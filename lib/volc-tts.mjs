/**
 * 火山「语音技术」流式语音合成（TTS）客户端 —— SSE / NDJSON 双通道。
 *
 * 为什么不能直接用 lib/http.mjs 的 requestJson：
 *   语音合成返回的是**行分隔的流式响应**（SSE 每行 `data: {json}`，NDJSON 每行一个 JSON），
 *   而 requestJson 会先 `response.text()` 再整体 `JSON.parse` —— 对多行流必然抛 BAD_RESPONSE。
 *   所以这里自己走 fetch，但严格保持与 http.mjs 一致的取消 / 超时 / request-id 采集语义。
 *
 * 本模块存在的两个核心价值（都是线上真实故障，见 docs/ARK-API-CONTRACT.md §2.1）：
 *   1. **结束标记是 `code === 20000000`，不是 0。** 只收 `code === 0 && data` 的块；
 *      把 `code !== 0` 一律当结束会**丢掉最后一段音频**。
 *   2. **拼接后必须校验 base64 padding 与音频文件头**；不符报 `BAD_RESPONSE`（疑似截断），
 *      绝不把坏音频当成功交付。
 */

import { Buffer } from 'node:buffer'

import {
  ARK_ERROR_CODES,
  ArkError,
  classifyHttpStatus,
  isAbortError,
  readUpstreamError,
} from './errors.mjs'
import { readRequestId } from './http.mjs'
import { resolveSpeechCredentials } from './config.mjs'

/** 数据块成功码：只有 `code === 0` 且带 `data` 的块才是音频。 */
export const TTS_SUCCESS_CODE = 0

/** 结束标记：既不是错误，也不是数据。把它当失败会丢掉最后一段音频。 */
export const TTS_END_CODE = 20_000_000

/**
 * 本地解析失败（非 JSON / 非对象 / 缺数字 code）的占位码。
 * 上游错误码都是非负整数，用 -1 标记"这行根本不是协议帧"，调用方可以据此区分。
 */
export const TTS_LOCAL_PARSE_ERROR = -1

const TTS_PATH_SSE = '/tts/unidirectional/sse'
const TTS_PATH_NDJSON = '/tts/unidirectional'

const DEFAULT_MAX_CHARS_PER_REQUEST = 200
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_SAMPLE_RATE = 24_000

/** 非流式（整段一个 JSON）兼容缓存的上限，避免畸形响应把内存吃满。 */
const MAX_EARLY_RAW_CHARS = 64 * 1024

/** 分句标点：句末 + 停顿 + 换行（与契约 §2.1 一致）。分句后标点保留在前一片里。 */
const SENTENCE_BREAKS = new Set('。？！；，.?!;,\n')

/** 传输层哨兵行：只表示流结束，不携带音频，也不算错误。 */
const SENTINEL_LINES = new Set(['[done]', 'done', '[end]', 'end'])

/**
 * 请求格式 → 落盘信息。
 * 只放"能用文件头校验完整性"的容器：没有可校验头的格式（如裸 PCM）无法拒绝截断产物，
 * 所以宁可不支持，也不交付一份无法验证的音频。
 */
const AUDIO_FORMATS = Object.freeze({
  mp3: { mime: 'audio/mpeg', ext: 'mp3', probe: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav', probe: 'wav' },
  ogg: { mime: 'audio/ogg', ext: 'ogg', probe: 'ogg' },
  ogg_opus: { mime: 'audio/ogg', ext: 'ogg', probe: 'ogg' },
})

/** 探针结果（真实容器）→ 落盘信息。 */
const AUDIO_BY_PROBE = Object.freeze({
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav' },
  ogg: { mime: 'audio/ogg', ext: 'ogg' },
})

// ---------------------------------------------------------------- 分句

/**
 * 按标点分句，超长句再按字数硬切。纯函数。
 *
 * 保证：
 *  - 不产生空片段（只有空白的片段被丢掉）；
 *  - 不丢字符（除首尾空白与 CRLF 归一化外，各片段按序拼接即原文）；
 *  - 硬切不会切断代理对（emoji 之类的补充平面字符按码点计数，切一半会变成乱码）。
 *
 * @param {string} text
 * @param {number} maxChars 单次请求的最大字符数（非法值回落到 200）
 * @returns {string[]}
 */
export function splitText(text, maxChars) {
  const limit =
    Number.isFinite(maxChars) && maxChars >= 1
      ? Math.floor(maxChars)
      : DEFAULT_MAX_CHARS_PER_REQUEST
  // CRLF 归一化 + 去掉首尾空白：这两种字符不会改变语义，但会制造出空片段。
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) return []

  const rough = []
  let buffer = ''
  for (const char of normalized) {
    buffer += char
    if (SENTENCE_BREAKS.has(char)) {
      rough.push(buffer)
      buffer = ''
    }
  }
  if (buffer) rough.push(buffer)

  const out = []
  for (const piece of rough) {
    const sentence = piece.trim()
    if (!sentence) continue
    for (const part of hardSplit(sentence, limit)) out.push(part)
  }
  return out
}

/** 超长句按码点硬切（不能用 slice 按 UTF-16 下标切，会把代理对劈开）。 */
function hardSplit(sentence, limit) {
  const points = Array.from(sentence)
  if (points.length <= limit) return [sentence]
  const out = []
  for (let i = 0; i < points.length; i += limit) {
    out.push(points.slice(i, i + limit).join(''))
  }
  return out
}

// ---------------------------------------------------------------- 流解析

/**
 * 逐行 JSON 流 → 音频字节。纯函数（不发请求，不落盘）。
 *
 * 兼容四种上游形态：
 *  - SSE：`data: {json}` 前缀行 + 空行 / `: comment` 心跳行 / `event:` 元数据行；
 *  - NDJSON：每行一个裸 JSON；
 *  - 哨兵行：`[DONE]` 之类，忽略；
 *  - 非流式 / 未按行对齐：整段响应其实是一个（可能跨多行的）JSON 对象，或调用方按字节分片喂进来
 *    导致行边界被打断 —— 逐行解析会全部失败，因此在没有收到任何音频时保留原始载荷并做一次整体回退解析。
 *
 * @param {AsyncIterable<string>|string[]|string|ReadableStream} lines
 * @returns {Promise<{bytes: Uint8Array, chunks: number, endMarkerSeen: boolean,
 *   errors: {code: number, message?: string}[], base64: string}>}
 */
export async function parseTtsStream(lines) {
  const parts = []
  const errors = []
  /** @type {string[]} 逐行解析失败时的原始载荷（仅在没有音频前累积，用于整体回退） */
  const earlyRaw = []
  let earlyRawChars = 0
  let chunks = 0
  let endMarkerSeen = false
  let lineNo = 0

  for await (const rawLine of normalizeLines(lines)) {
    lineNo += 1
    const payload = extractPayload(rawLine)
    if (!payload) continue
    if (SENTINEL_LINES.has(payload.toLowerCase())) continue

    let json
    try {
      json = JSON.parse(payload)
    } catch {
      errors.push({
        code: TTS_LOCAL_PARSE_ERROR,
        message: `第 ${lineNo} 行不是合法 JSON：${truncate(payload)}`,
      })
      rememberEarlyRaw(earlyRaw, payload, () => earlyRawChars, (n) => (earlyRawChars = n))
      continue
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      errors.push({
        code: TTS_LOCAL_PARSE_ERROR,
        message: `第 ${lineNo} 行不是 JSON 对象：${truncate(payload)}`,
      })
      continue
    }

    const code = Number(json.code)
    if (!Number.isFinite(code)) {
      errors.push({
        code: TTS_LOCAL_PARSE_ERROR,
        message: `第 ${lineNo} 行缺少数字 code：${truncate(payload)}`,
      })
      rememberEarlyRaw(earlyRaw, payload, () => earlyRawChars, (n) => (earlyRawChars = n))
      continue
    }

    // 结束标记必须在"其它非 0 码 = 错误"之前判断，否则它会被记成错误；
    // 更要紧的是：绝不能用"非 0 即结束"来终止读取，那会丢掉最后一段音频。
    if (code === TTS_END_CODE) {
      endMarkerSeen = true
      // 官方协议里结束标记是最后一条；服务端有时不主动断连接，这里主动收尾以免挂死。
      break
    }

    if (code === TTS_SUCCESS_CODE) {
      const data = typeof json.data === 'string' ? json.data.trim() : ''
      // code=0 但无 data 是心跳/元数据块：既不是音频，也不是错误。
      if (data) {
        parts.push(data)
        chunks += 1
      }
      continue
    }

    const message = pickMessage(json)
    // 上游响应体自带 reqid（排障用）。真实探测确认了这一点：
    //   401/凭据无效时返回 `data: {"reqid":"…","code":45000010,"message":"load grant: …"}`
    // 所以即使响应头没带 X-Tt-Logid，也要能从体里拿到关联 id。
    const reqid = typeof json.reqid === 'string' && json.reqid ? json.reqid : undefined
    errors.push({ code, ...(message ? { message } : {}), ...(reqid ? { reqid } : {}) })
  }

  // 回退：整段响应是一个跨多行的 JSON 对象、或调用方按字节/文本分片喂进来导致行边界被打断时，
  // 逐行解析会全部失败。这里只在"一个音频块都没拿到"时，把原始载荷按出现顺序拼回一个 JSON 对象；
  // 正常流式路径（已经收到 code===0 的块）完全不受影响，绝不会因此改变音频内容。
  if (chunks === 0 && earlyRaw.length > 0) {
    const whole = tryParseJsonObject(earlyRaw.join(''))
    if (whole) {
      const code = Number(whole.code)
      if (code === TTS_END_CODE) {
        endMarkerSeen = true
      } else if (code === TTS_SUCCESS_CODE) {
        const data = typeof whole.data === 'string' ? whole.data.trim() : ''
        if (data) {
          parts.push(data)
          chunks = 1
        }
      } else if (Number.isFinite(code)) {
        // 整体其实是一个"上游错误"响应：把逐行误报换成真实错误码，
        // 否则调用方只会看到一串 -1，拿不到 400 这类可判断的上游信息。
        discardLocalParseErrors(errors)
        const message = pickMessage(whole)
        errors.push(message ? { code, message } : { code })
      }
      if (chunks > 0 || endMarkerSeen) {
        // 整体解析成功 ⇒ 之前逐行报的"不是合法 JSON"是误报，清掉噪音。
        discardLocalParseErrors(errors)
      }
    }
  }

  const base64 = parts.join('')
  return { bytes: decodeBase64Parts(parts), chunks, endMarkerSeen, errors, base64 }
}

/** 统一输入形态：字符串 / 字符串数组 / 异步可迭代（含 ReadableStream）/ 字节分片。 */
async function* normalizeLines(source) {
  if (source === null || source === undefined) return
  if (typeof source === 'string') {
    yield* splitItem(source)
    return
  }
  if (typeof source[Symbol.asyncIterator] === 'function') {
    for await (const item of source) yield* splitItem(item)
    return
  }
  if (typeof source[Symbol.iterator] === 'function') {
    for (const item of source) yield* splitItem(item)
    return
  }
  throw new ArkError(
    ARK_ERROR_CODES.INVALID_PARAMETER,
    'parseTtsStream 需要字符串、字符串数组或异步可迭代对象（如 ReadableStream）。',
    { provider: 'speech' },
  )
}

/** 一个分片可能自带多行（网络分片不保证按行对齐），必须再按换行拆一次。 */
function* splitItem(item) {
  if (item === null || item === undefined) return
  const text = item instanceof Uint8Array ? new TextDecoder('utf-8').decode(item) : String(item)
  for (const line of text.split(/\r?\n/)) yield line
}

/** 取出一行的协议载荷；返回空串表示"这行不该被解析"。 */
function extractPayload(rawLine) {
  const line = String(rawLine ?? '').replace(/\r$/, '').trim()
  if (!line) return ''
  // SSE 注释行（`: keep-alive`）与 event/id/retry 元数据行都不携带数据。
  if (line.startsWith(':')) return ''
  const lower = line.toLowerCase()
  if (lower.startsWith('event:') || lower.startsWith('id:') || lower.startsWith('retry:')) return ''
  const match = /^data\s*:\s*/i.exec(line)
  if (match) return line.slice(match[0].length).trim()
  return line
}

function rememberEarlyRaw(store, payload, getChars, setChars) {
  const chars = getChars()
  if (chars >= MAX_EARLY_RAW_CHARS) return
  store.push(payload)
  setChars(chars + payload.length)
}

function tryParseJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const json = JSON.parse(trimmed)
    return json && typeof json === 'object' && !Array.isArray(json) ? json : undefined
  } catch {
    return undefined
  }
}

/** 整体回退解析成功后，逐行阶段的"不是合法 JSON"就都是误报，必须清掉。 */
function discardLocalParseErrors(errors) {
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].code === TTS_LOCAL_PARSE_ERROR) errors.splice(i, 1)
  }
}

function pickMessage(json) {
  if (typeof json.message === 'string' && json.message) return json.message
  if (typeof json.msg === 'string' && json.msg) return json.msg
  return undefined
}

function truncate(text, max = 120) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 拼接并解码各数据块。
 *
 * 兼容两种上游行为：
 *  A. `data` 是**整段 base64 的分片**，只有最后一片带 padding ⇒ 必须拼成一整串再解码；
 *  B. `data` 是逐块独立编码的 base64（每片自带 padding）⇒ 逐片解码后按字节序拼接才不丢字节。
 * 判据是"除最后一片外是否出现 padding"，这是两种行为唯一可观测的差异。
 */
function decodeBase64Parts(parts) {
  const cleaned = parts
    .map((p) => String(p).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'))
    .filter(Boolean)
  if (cleaned.length === 0) return new Uint8Array(0)
  const interiorPadded = cleaned.slice(0, -1).some((p) => p.endsWith('='))
  if (!interiorPadded) return toBytes(Buffer.from(cleaned.join(''), 'base64'))
  return toBytes(Buffer.concat(cleaned.map((p) => Buffer.from(p, 'base64'))))
}

/** Buffer 是 Uint8Array 子类，但返回一个纯 Uint8Array 视图对调用方更可预期。 */
function toBytes(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

// ---------------------------------------------------------------- 产物校验

/**
 * 按文件头判断真实音频容器。只认契约列举的四种头：
 * ID3(`49 44 33`) / MP3 帧同步(`ff f3`、`ff fb`) / WAV(`RIFF`) / OGG(`OggS`)。
 *
 * @param {Uint8Array} bytes
 * @returns {'mp3'|'wav'|'ogg'|undefined}
 */
export function probeAudioHeader(bytes) {
  if (!bytes || bytes.length < 3) return undefined
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3' // 'ID3'
  if (bytes[0] === 0xff && (bytes[1] === 0xf3 || bytes[1] === 0xfb)) return 'mp3'
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'wav' // 'RIFF'
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'ogg' // 'OggS'
  }
  return undefined
}

/**
 * 交付前的校验闸门：完整性证据 + 音频文件头。
 *
 * 为什么必须卡在这里：截断的音频仍然"看起来像成功"（HTTP 200、有字节、能落盘），
 * 但它会在播放到一半时断掉，而调用方无从分辨 —— 这是比抛错严重得多的交付事故。
 *
 * 但判据必须选对，否则会**误伤完整音频**：
 *  - **不可靠判据**：base64 是否以 `=` 结尾。padding 只取决于总字节数 %3，
 *    而音频字节数正好是 3 的倍数时**本来就没有 padding**（约 1/3 概率）。
 *    按"必须以 = 结尾"判决，会把完整音频误判成截断。
 *  - **可靠判据**：流里是否出现官方结束标记 `code === 20000000`。
 *    服务端正常收尾才会发它；缺了它才真正说明"流可能被切断"。
 *
 * 因此优先级是：
 *  1. 见到结束标记 → 流完整，**跳过 padding 判据**（避免误伤）；文件头认不出时只降级为 warning；
 *  2. 没见到结束标记 → 两道判据都上（这才是真正的截断风险场景）。
 *
 * @param {{base64?: string, bytes?: Uint8Array, requestId?: string, endMarkerSeen?: boolean}} input
 * @returns {{format: string, mime: string, ext: string, warnings: string[]}}
 */
export function assertAudioDeliverable({ base64, bytes, requestId, endMarkerSeen = false } = {}) {
  const merged = String(base64 ?? '').replace(/\s+/g, '')
  const warnings = []
  const problems = []

  if (!endMarkerSeen && !merged.endsWith('=')) {
    problems.push('合并后的 base64 未以 "=" 结尾且未见结束标记（缺少尾部 padding）')
  }

  const format = probeAudioHeader(bytes)
  if (!format) {
    const detail = `音频文件头无法识别（前 4 字节 ${hexPreview(bytes)}）`
    if (endMarkerSeen) {
      // 流已被服务端正常收尾：认不出容器是"我们没见过的封装"，不是交付事故。
      warnings.push(`${detail}；已按流结束标记判定为完整，但无法确认容器格式`)
    } else {
      problems.push(detail)
    }
  }

  if (problems.length > 0) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `语音合成产物校验失败：${problems.join('；')}。疑似流式响应被截断`
        + `（常见原因是把 code!==0 的块当成结束标记），已拒绝把坏音频当成功交付。`,
      { provider: 'speech', requestId },
    )
  }
  // 认不出容器时按二进制兜底（调用方仍会用请求格式命名），不编造假格式。
  const spec = format ? AUDIO_BY_PROBE[format] : undefined
  return spec
    ? { format, mime: spec.mime, ext: spec.ext, warnings }
    : { format: 'bin', mime: 'application/octet-stream', ext: 'bin', warnings }
}

function hexPreview(bytes, count = 4) {
  if (!bytes || bytes.length === 0) return '空'
  return Array.from(bytes.slice(0, count))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

// ---------------------------------------------------------------- 合成

/**
 * 音色是否为"声音克隆"音色。克隆音色必须换资源 id 并强制带 explicit_language。
 * @param {string} voice
 */
export function isCloneSpeaker(voice) {
  const value = String(voice ?? '').trim().toLowerCase()
  return value.startsWith('s_') || value.startsWith('clone_')
}

/**
 * 依据音色名推断它所属的 `X-Api-Resource-Id`。
 *
 * 为什么必须推断而不能写死：语音服务把"音色"和"资源"绑在一起校验，配错的表现是
 * **HTTP 200 但音频为空**，错误码 `55000000: resource ID is mismatched with speaker
 * related resource` —— 极易被误判成"音色不存在"或"账号没开通"。
 *
 * 判定规则：
 *   · `S_` / `clone_` 开头 → 声音克隆资源（默认 `seed-icl-2.0`，已确认该资源存在）
 *   · 名字含 `uranus`      → 2.0 代音色（默认 `seed-tts-2.0`，已实测可用）
 *   · 其余（含 `_bigtts`） → 回落 `seed-tts-2.0`，让上游报"音色与资源不配套"
 *
 * ⚠️ **这里曾有一个错误分支，已删除，记录以免重犯**：
 * 我一度按"`_mars_bigtts` 是 1.0 代音色"给它们路由到 `volc.service_type.10029`。
 * 实测证明那个资源在账号上**并不存在**——用**已确认可用**的 2.0 音色去配它，照样返回
 * `45000030 requested resource not granted`（对照组 `seed-tts-2.0` 正常出音频）。
 * 也就是说该分支不但无依据，还会把错误信息**变差**：用户看到"资源未授权"，
 * 而真相只是"这个音色不属于这个资源"。现在让它回落，由上游给出准确的 mismatch。
 *
 * 另注：`_mars_bigtts` / `_uranus_bigtts` 的"代"划分来自第三方整理的音色表，
 * 不是官方口径；真正的官方产品线里 **TTS 与 SeedAudio 音频生成是两回事**，
 * 不要因为都带 "1.0" 就混为一谈（这正是当初出错的根源）。
 *
 * @param {string} voice
 * @param {{resourceTts?: string, resourceTtsClone?: string}} [speech]
 * @returns {string}
 */
export function resourceForVoice(voice, speech = {}) {
  const value = String(voice ?? '').trim().toLowerCase()
  if (value.startsWith('s_') || value.startsWith('clone_')) {
    return speech.resourceTtsClone || 'seed-icl-2.0'
  }
  return speech.resourceTts || 'seed-tts-2.0'
}

/**
 * 合成一段文本（内部完成分句、串行请求、拼接、校验、落盘）。
 *
 * @param {object} input
 * @param {object} input.config 由 resolveConfig() 产出
 * @param {{resolve: Function, require: Function}} input.creds
 * @param {{save: Function}} input.store ArtifactStore
 * @param {string} input.text
 * @param {string} [input.voice]
 * @param {string} [input.format] mp3 | wav | ogg | ogg_opus
 * @param {number} [input.sampleRate]
 * @param {number} [input.speedRatio]
 * @param {number} [input.volumeRatio]
 * @param {number} [input.pitchRatio]
 * @param {string} [input.emotion]
 * @param {string} [input.explicitLanguage] 克隆音色的显式语种，缺省按文本推断
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 */
export async function synthesizeSpeech(input, opts = {}) {
  const source = input ?? {}
  const { config, creds, store, text } = source
  const signal = opts.signal
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  if (signal?.aborted) {
    throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech' })
  }
  if (!store || typeof store.save !== 'function') {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'synthesizeSpeech 需要注入 ArtifactStore（音频必须落盘才能交付）。',
      { provider: 'speech' },
    )
  }

  const speech = config && typeof config === 'object' && config.speech ? config.speech : {}
  const mode = normalizeMode(speech.mode)
  const voice = String(source.voice || speech.voice || '').trim()
  if (!voice) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      '缺少 speaker：请在 config.speech.voice 里配置音色，或显式传 voice。',
      { provider: 'speech' },
    )
  }
  const requestedFormat = normalizeFormat(source.format || speech.format || 'mp3')
  const sampleRate = toPositiveInt(source.sampleRate ?? speech.sampleRate, DEFAULT_SAMPLE_RATE)
  const maxChars = toPositiveInt(speech.maxCharsPerRequest, DEFAULT_MAX_CHARS_PER_REQUEST)

  const sentences = splitText(text, maxChars)
  if (sentences.length === 0) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'text 为空或只有空白，没有可合成的文本。',
      { provider: 'speech' },
    )
  }

  // 凭据走共享解析：只有一条通道（语音技术的 API Key，`X-Api-Key`）；
  // 缺失时报 MISSING_CREDENTIAL 并给出获取位置。
  // （这里原先写"双通道：语音技术优先、Ark 侧兜底"，但那套 Ark 侧凭据已整体移除，
  //  留着只会让排障时以为还有第二种配法。）
  const speechCreds = await resolveSpeechCredentials({ ...config, speech }, creds)

  const clone = isCloneSpeaker(voice)
  /**
   * 资源 id 必须跟着**音色**走，不能写死。
   *
   * 为什么：语音服务把"音色"和"资源"绑在一起校验，配错的表现是
   * **HTTP 200 但音频为空**（`55000000 resource ID is mismatched with speaker related resource`），
   * 看起来像音色不存在或账号没开通 —— 极难定位。
   *
   * 因此按音色名推断资源；配置里的 resourceTts / resourceTtsClone 只在能明确归属时
   * 作为覆盖（克隆音色永远用配置的克隆资源）。
   */
  const resourceId = clone
    ? speech.resourceTtsClone
    : resourceForVoice(voice, {
        resourceTts: speech.resourceTts,
        resourceTtsClone: speech.resourceTtsClone,
      })
  if (!resourceId) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `config.speech.${clone ? 'resourceTtsClone' : 'resourceTts'} 未配置，无法确定 X-Api-Resource-Id。`,
      { provider: 'speech' },
    )
  }

  const baseUrl = String(speech.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, 'config.speech.baseUrl 未配置。', {
      provider: 'speech',
    })
  }
  const url = baseUrl + (mode === 'ndjson' ? TTS_PATH_NDJSON : TTS_PATH_SSE)

  // 克隆音色不带 explicit_language 会被官方 400「语言不支持」，所以必须给一个兜底值；
  // 普通音色只在调用方显式指定时才带，避免给标准音色塞不支持的字段。
  const language = resolveLanguage({
    clone,
    explicitLanguage: source.explicitLanguage,
    text: String(text ?? ''),
  })

  /**
   * 鉴权头：**只发 `X-Api-Key`**。
   *
   * 官方文档明确 App ID 是"请求/应用配置"、不是鉴权因子，因此这里连可选的
   * `X-Api-App-Id` 都不带 —— 少一个头就少一处"填错也看不出来"的可能。
   * 旧版双头（App ID + Access Token）已整体移除：实测被 ASR / 音频生成直接拒绝
   * （`45000000 resourceId is not allowed`），留着只会误导。
   */
  const headers = {
    'X-Api-Key': speechCreds.apiKey,
    'X-Api-Resource-Id': resourceId,
    'Content-Type': 'application/json',
    Accept: mode === 'sse' ? 'text/event-stream' : 'application/json',
  }

  // AbortSignal.timeout 的上限是 2^31-1，配置写超了会直接抛 RangeError，这里先夹住。
  const timeoutMs = Math.min(
    toPositiveInt(config?.ark?.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
    2_147_483_647,
  )
  const retries = Number.isInteger(config?.ark?.rateLimitRetries)
    ? Math.max(0, config.ark.rateLimitRetries)
    : 0
  const backoffMs = toPositiveInt(config?.ark?.rateLimitBackoffMs, 25_000)

  const byteParts = []
  const errors = []
  let mergedBase64 = ''
  let requestId
  /** 任一句见到结束标记（用于返回值里的诊断字段）。 */
  let sawAnyEndMarker = false

  // 串行请求：分句顺序即拼接顺序，并发会打乱音频时序、也可能触发限流。
  for (let i = 0; i < sentences.length; i++) {
    /**
     * ⚠️ 每句**独立的**结束标记 —— 必须在循环**内部**初始化。
     *
     * 原实现把它声明在循环外并跨句累加，于是出现这个漏洞（BUG 审计 B7）：
     *
     *   第 1 句见到结束标记 → 变量为 true
     *   第 2 句实际被截断（没有结束标记）
     *   → 第 2 句的判定因为变量仍为 true 而认为"流完整"
     *   → **截断的音频被当完整产物交付**（只有时长/内容不对，没有任何报错）
     *
     * 判据本身没错（见到官方结束标记 = 流被正常收尾，比"base64 是否带 padding"可靠），
     * 错在它问的是"整次调用有没有见过"，而每个请求的流完整性必须各自判定。
     */
    let sentenceEndMarkerSeen = false
    if (signal?.aborted) {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech' })
    }
    const body = {
      user: { uid: 'dsh-ark' },
      req_params: buildReqParams({
        text: sentences[i],
        voice,
        format: requestedFormat,
        sampleRate,
        language,
        speedRatio: source.speedRatio,
        volumeRatio: source.volumeRatio,
        pitchRatio: source.pitchRatio,
        emotion: source.emotion,
      }),
    }

    const parsed = await postSegmentWithRetry({
      url,
      headers,
      body,
      signal,
      timeoutMs,
      fetchImpl,
      retries,
      backoffMs,
    })

    if (!requestId && parsed.requestId) requestId = parsed.requestId
    errors.push(...parsed.errors)
    if (parsed.endMarkerSeen) {
      sentenceEndMarkerSeen = true
      sawAnyEndMarker = true
    }

    /**
     * 本句没有结束标记 = **这一句的音频流很可能被截断**。
     *
     * 必须在这里判，不能等到最后对拼接结果判：`assertAudioDeliverable` 看的是
     * **拼接后**的整体，它无法区分"哪一句被截断"，而拼接后 padding 往往正好合法
     * （前一句的尾部 padding 掩盖了后一句的缺失）—— 这正是 B7 那个静默交付
     * 截断音频的成因。
     *
     * 宁可在计费已发生的情况下**明确报错并说明重试方式**，也不要交付一段
     * 听起来没问题、实际少了半句的音频。提示词里明确"不要重复合成整段"，
     * 因为已经合成的部分已经计费了。
     */
    /**
     * ⚠️ **顺序很重要：先报"上游明确说了什么错"，再报"流看起来被截断"。**
     *
     * 这两件事在响应里同时成立时（上游返回 `code: 45000010` 鉴权失败 → 没有数据块、
     * 也没有结束标记），必须先把**上游的真实原因**报出去：否则用户看到的是
     * "疑似被截断"，而去查网络，真正的问题是凭据错了。
     * 判据：`parsed.errors` 里有没有**非零**的上游 code。
     */
    const upstreamFailure = parsed.errors.find(
      (e) => typeof e.code === 'number' && e.code !== 0 && e.code !== TTS_END_CODE,
    )

    if (parsed.bytes.length === 0) {
      const detail = describeErrors(parsed.errors)
      // 有上游错误码时按码分类（鉴权 vs 其它），并附可执行指引；
      // 完全没有错误码才是"响应结构不对"。
      const firstCode = parsed.errors.find((e) => typeof e.code === 'number')?.code
      const code = firstCode === undefined ? ARK_ERROR_CODES.BAD_RESPONSE : classifySpeechCode(firstCode)
      const hint = firstCode === undefined ? '' : hintForSpeechCode(firstCode)
      throw new ArkError(
        code,
        `第 ${i + 1}/${sentences.length} 句没有返回任何音频数据`
          + `${detail ? `（上游返回：${detail}）` : '（响应里没有 code===0 的数据块）'}。`
          + (hint ? `\n${hint}` : ''),
        { provider: 'speech', requestId: parsed.requestId },
      )
    }

    /**
     * 有音频但对不上：只有当**上游没有明确报错**时，才把"缺结束标记"判成截断。
     *
     * 必须在这里判，不能等到最后对拼接结果判：`assertAudioDeliverable` 看的是
     * **拼接后**的整体，无法区分"哪一句被截断"，而拼接后 padding 往往正好合法
     * （前一句的尾部 padding 掩盖了后一句的缺失）—— 这正是 B7 那个静默交付
     * 截断音频的成因。
     *
     * 宁可在计费已发生的情况下**明确报错**，也不要交付一段听起来没问题、
     * 实际少了半句的音频。提示里明确"重试会重新计费"，避免用户以为免费重来。
     */
    /**
     * 有音频、上游也没报错 —— 先看**文件头**，再看结束标记。
     *
     * 顺序是有意的（BUG 审计 B7 修复时踩出来的）：两者都不满足时，
     * "文件头认不出来"是**更具体、更可执行**的原因（大概率是响应体根本不是音频），
     * 而"没有结束标记"只说明"流可能被截断"。先把具体原因说出去，用户才知道查哪里。
     */
    if (!probeAudioHeader(parsed.bytes)) {
      throw new ArkError(
        ARK_ERROR_CODES.BAD_RESPONSE,
        `第 ${i + 1}/${sentences.length} 句返回的内容不是可识别的音频`
          + `（文件头无法识别，前 4 字节 ${hexPreview(parsed.bytes)}）。`
          + '已拒绝把坏数据当成功交付。'
          + (requestId ? ` request_id=${requestId}` : ''),
        { provider: 'speech', requestId },
      )
    }

    if (!sentenceEndMarkerSeen && upstreamFailure === undefined) {
      throw new ArkError(
        ARK_ERROR_CODES.BAD_RESPONSE,
        `第 ${i + 1}/${sentences.length} 句的音频流没有正常结束：未见结束标记，`
          + '且 base64 的尾部形态也不支持"流已完整"（疑似被截断）。已停止交付，'
          + '以免给出不完整的音频。'
          + `已成功的 ${i} 句无法单独取回；请重试整段合成（重试会重新计费）。`
          + (requestId ? ` request_id=${requestId}` : ''),
        { provider: 'speech', requestId },
      )
    }

    byteParts.push(parsed.bytes)
    mergedBase64 += parsed.base64
  }

  const bytes = concatBytes(byteParts)
  // 硬闸门：校验不通过就抛错，绝不落盘、绝不返回。
  // endMarkerSeen 必须传进去：见到官方结束标记（code 20000000）才是"流完整"的可靠证据，
  // 而 base64 是否带 padding 只取决于总字节数 %3，完整音频也可能没有 "="。
  const probed = assertAudioDeliverable({ base64: mergedBase64, bytes, requestId, endMarkerSeen: sawAnyEndMarker })

  const saved = await store.save({
    bytes,
    hint: sentences[0].slice(0, 24),
    mime: probed.mime,
    ext: probed.ext,
  })

  return {
    audio: saved,
    // 恒为 'apiKey'（旧版 App ID 方案已移除）；保留字段名以免破坏调用方。
    channel: speechCreds.scheme,
    segments: sentences.length,
    // 返回真实容器（由文件头判定），而不是"请求时写的格式"——两者不一致时以文件为准。
    format: probed.format,
    sampleRate,
    // 不做时长估算：没有可靠依据的估算值会被上层当成事实使用（WAV 之外无法从头部得出）。
    requestId,
    // 附加诊断字段：上游错误码块（有音频时的非致命错误）也会在这里露出。
    errors,
    // 非致命的完整性问题（例如流已由结束标记证明完整、但容器头认不出）——必须暴露，
    // 不能因为"没抛错"就当作没发生。
    warnings: probed.warnings,
    // 是否见到了官方结束标记。缺了它意味着流可能被服务端/网络切断，上层可据此判断可信度。
    endMarkerSeen: sawAnyEndMarker,
  }
}

/** 组装单句请求参数（字段名严格用契约里的 snake_case）。 */
function buildReqParams({ text, voice, format, sampleRate, language, speedRatio, volumeRatio, pitchRatio, emotion }) {
  const params = {
    text,
    speaker: voice,
    audio_params: { format, sample_rate: sampleRate },
  }
  if (Number.isFinite(speedRatio)) params.speed_ratio = speedRatio
  if (Number.isFinite(volumeRatio)) params.volume_ratio = volumeRatio
  if (Number.isFinite(pitchRatio)) params.pitch_ratio = pitchRatio
  if (typeof emotion === 'string' && emotion) params.emotion = emotion
  // additions 官方要求是"JSON 字符串"，不是 JSON 对象——传对象会被当成非法参数。
  if (language) params.additions = JSON.stringify({ explicit_language: language })
  return params
}

/** 克隆音色必须给出语种；显式参数 > 文本推断（kana→ja，CJK→zh，其余→en）。 */
function resolveLanguage({ clone, explicitLanguage, text }) {
  if (typeof explicitLanguage === 'string' && explicitLanguage.trim()) {
    return explicitLanguage.trim()
  }
  if (!clone) return undefined
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  return 'en'
}

function normalizeMode(mode) {
  const value = String(mode ?? 'sse').trim().toLowerCase()
  if (value === 'sse' || value === 'ndjson') return value
  throw new ArkError(
    ARK_ERROR_CODES.INVALID_PARAMETER,
    `config.speech.mode 只支持 'sse' 或 'ndjson'，收到 ${JSON.stringify(mode)}。`,
    { provider: 'speech' },
  )
}

function normalizeFormat(format) {
  const value = String(format ?? 'mp3').trim().toLowerCase()
  if (!AUDIO_FORMATS[value]) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `不支持的音频格式 ${JSON.stringify(format)}，只支持 ${Object.keys(AUDIO_FORMATS).join(' / ')}：`
        + '这些容器有可校验的文件头，没有文件头的格式无法拒绝截断产物。',
      { provider: 'speech' },
    )
  }
  return value
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function describeErrors(errors) {
  if (!errors || errors.length === 0) return ''
  return errors
    .map((e) => `${e.code}${e.message ? `: ${e.message}` : ''}`)
    .join('；')
}

/**
 * 上游语音错误码 → 稳定错误码。
 *
 * 语音服务**不在 HTTP 状态码里表达鉴权结果**：凭据无效时依然返回 HTTP 200，
 * 真正的错误放在数据帧的 `code` 字段里。
 *
 * 这里**只映射实测过的码**，不做区间猜测：
 *   - `45000010`：`load grant: requested grant not found in SaaS storage`
 *     —— App ID / Access Token / Resource ID 与账号不匹配（最常见是拿 Ark API Key 当语音 Key）。
 *     已于 2026-10-10 用真实端点探测确认（见 docs/ARK-API-CONTRACT.md §2.1）。
 *   - 其余码（含 `40000000`/`40000001` 这类语义型错误，如"语言不支持"）一律
 *     `BAD_RESPONSE` 并原样带上上游 message —— 猜测区间会把参数错误说成鉴权错误，
 *     反而把用户引向错误的方向。新增映射必须同时补上探测证据与用例。
 */
function classifySpeechCode(code) {
  if (code === 45000010) return ARK_ERROR_CODES.AUTHENTICATION
  return ARK_ERROR_CODES.BAD_RESPONSE
}

/** 结合上游错误码给出可执行的修复指引（只说我们确知的事，不编造原因）。 */
function hintForSpeechCode(code) {
  if (code === 45000010) {
    return '语音服务拒绝了这次调用：请核对语音 API Key（X-Api-Key）与 X-Api-Resource-Id 是否匹配'
      + '（凭据来自火山引擎控制台 → 语音技术 → API Key 管理；方舟的 ARK_API_KEY 不能用于语音）。'
  }
  if (code === 45_000_030) {
    return '该语音资源未被授权：本插件只会请求 seed-tts-2.0（TTS）或 seed-icl-2.0（声音克隆）。'
      + '如果这两个都报未授权，请到语音技术控制台确认该 API Key 开通了对应能力。'
  }
  if (code === 55_000_000) {
    return '音色与资源不配套：请检查 speaker 是不是这个资源下的音色'
      + '（TTS 2.0 音色走 seed-tts-2.0；声音克隆音色走 seed-icl-2.0）。'
  }
  return ''
}

// ---------------------------------------------------------------- 请求

/** 单句请求：限流（429）按 config.ark 退避重试；参数错误、解析失败一律不重试。 */
async function postSegmentWithRetry({ url, headers, body, signal, timeoutMs, fetchImpl, retries, backoffMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await postTtsStream({ url, headers, body, signal, timeoutMs, fetchImpl })
    } catch (err) {
      const rateLimited = err instanceof ArkError && err.code === ARK_ERROR_CODES.RATE_LIMITED
      if (rateLimited && attempt < retries) {
        // 限流是唯一允许自动重试的情形（契约 §3）：它没有产生计费，也不会重复交付音频。
        await sleepAbortable(backoffMs * (attempt + 1), signal)
        continue
      }
      throw err
    }
  }
}

/** 发一次流式请求并把响应体逐行喂给解析器。 */
async function postTtsStream({ url, headers, body, signal, timeoutMs, fetchImpl }) {
  if (signal?.aborted) {
    throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech' })
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const timedOut = () => timeoutSignal.aborted && !(signal && signal.aborted)

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
      // 请求头里带 Access Key，绝不能跟随重定向把凭据带到别的源。
      redirect: 'error',
    })
  } catch (err) {
    throw mapTransportError(err, { signal, timedOut, timeoutMs })
  }

  const requestId = readRequestId(response.headers)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const upstream = readUpstreamError(text)
    throw new ArkError(
      classifyHttpStatus(response.status, upstream.code),
      `语音合成请求失败：HTTP ${response.status}`
        + `${upstream.code ? ` (${upstream.code})` : ''}`
        + `${upstream.message ? `：${upstream.message}` : ''}`,
      { provider: 'speech', httpStatus: response.status, requestId },
    )
  }

  try {
    const parsed = await parseTtsStream(responseLines(response))
    return { ...parsed, requestId }
  } catch (err) {
    if (err instanceof ArkError) throw err
    // 流读到一半断掉：取消 → ABORTED，超时 → TIMEOUT，其余按 NETWORK。
    throw mapTransportError(err, { signal, timedOut, timeoutMs })
  }
}

/**
 * 把响应体拆成行。
 * 真实 fetch 走 ReadableStream 增量解码；测试注入的轻量 mock 只有 text() 时走退化路径。
 */
async function* responseLines(response) {
  const stream = response && response.body
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let pending = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let at
        while ((at = pending.indexOf('\n')) >= 0) {
          yield pending.slice(0, at)
          pending = pending.slice(at + 1)
        }
      }
      pending += decoder.decode()
      if (pending) yield pending
    } finally {
      // 提前收尾（已看到结束标记）时要主动取消底层流，否则连接可能一直挂着。
      try {
        await reader.cancel()
      } catch {
        // 流已关闭/已出错，忽略。
      }
      try {
        reader.releaseLock()
      } catch {
        // 同上。
      }
    }
    return
  }
  const text = typeof response?.text === 'function' ? await response.text() : ''
  for (const line of String(text).split('\n')) yield line
}

function mapTransportError(err, { signal, timedOut, timeoutMs }) {
  if (isAbortError(err) || (signal && signal.aborted)) {
    return new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech', cause: err })
  }
  if (timedOut()) {
    return new ArkError(
      ARK_ERROR_CODES.TIMEOUT,
      `语音合成请求超过 ${timeoutMs} ms 未返回。`,
      { provider: 'speech', retryable: true, cause: err },
    )
  }
  const message = err && err.message ? err.message : String(err)
  return new ArkError(ARK_ERROR_CODES.NETWORK, `语音合成网络请求失败：${message}`, {
    provider: 'speech',
    retryable: true,
    cause: err,
  })
}

/** 可被取消的退避等待（不能用 http.mjs 里未导出的 sleep）。 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech' }))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
