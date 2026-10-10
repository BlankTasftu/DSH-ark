/**
 * 火山「语音技术」语音识别（ASR）—— 录音文件识别**极速版**。
 *
 * 端点、鉴权、请求体与响应结构均为**实测确认**（2026-10-11，真实凭据 + 真实语音）：
 *
 *   POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
 *   X-Api-Key: <api-key>                        ← 只支持新版鉴权
 *   X-Api-Resource-Id: volc.seedasr.sauc.duration
 *   { user:{uid}, audio:{format,data|url}, request:{model_name,enable_itn,enable_punc} }
 *
 * 实测返回：
 *   { "audio_info": { "duration": 3240 },
 *     "result": { "text": "你好呀！喜欢我送给你的礼物吗？",
 *                 "utterances": [ { "text": "你好呀！", "start_time": 330, "end_time": 930,
 *                                   "words": [ { "text": "你", "start_time": 330, "end_time": 490 } ] } ] } }
 *
 * 三个踩坑点（都实测过，写进代码避免重犯）：
 *  1. 资源 id 必须是 `volc.seedasr.sauc.duration`。换成 `volc.bigasr.auc` /
 *     `volc.bigasr.sauc.duration` 会得到 `45000030 requested resource not granted`
 *     —— 看起来像"没开通语音识别"，其实只是资源名不对。
 *  2. 该接口**只支持新版 `X-Api-Key`**：用旧版双头会得到 `45000000 resourceId … is not allowed`。
 *  3. 鉴权/资源类错误可能以 **HTTP 403 + 响应体 `{"header":{"code":…}}`** 返回，
 *     所以不能只看 HTTP 状态，必须解析响应体里的 `header.code`。
 *  4. 时间戳单位是**毫秒**（`duration: 3240` 对 3.24 秒音频）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'
import { resolveSpeechCredentials } from './config.mjs'

/**
 * 单文件体积上限：base64 提交会把体积放大 ~33%，再大就应该先切分或走分片接口。
 * 超限直接拒绝，避免把内存和请求体撑爆（与 ark-video 对本地素材的口径一致）。
 */
export const DEFAULT_MAX_AUDIO_BYTES = 100 * 1024 * 1024

/** 极速版端点（实测确认存在）。 */
export const ASR_FLASH_PATH = '/auc/bigmodel/recognize/flash'

/**
 * 生成请求追踪 id。
 *
 * 不能只用 `Date.now()`：同一毫秒内并发发两次请求会拿到**相同**的 id，
 * 而 `X-Api-Request-Id` 的用途正是"把一次调用与上游日志对上" —— 撞 id 会让排障失效。
 * 加一个进程内自增序号即可保证唯一（该 id 只用于追踪，不参与鉴权）。
 */
let requestSeq = 0
function nextRequestId(prefix) {
  requestSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${requestSeq.toString(36)}`
}

/** 支持的容器 → 请求里 `audio.format` 的取值。 */
const AUDIO_FORMAT_BY_EXT = {
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  opus: 'ogg_opus',
  oga: 'ogg_opus',
  m4a: 'mp3',
  pcm: 'pcm',
  aac: 'mp3',
}

/** 从扩展名推 `audio.format`；未知时按 mp3（上游对容器较宽容）。 */
export function asrAudioFormat(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase()
  return AUDIO_FORMAT_BY_EXT[ext] || 'mp3'
}

/**
 * 实测结论保留为"已验证清单"，供文档与排障引用。
 * @type {readonly string[]}
 */
export const ASR_UNVERIFIED = Object.freeze([])

/** 实测确认过的关键事实（与 ASR_UNVERIFIED 相对）。 */
export const ASR_VERIFIED = Object.freeze([
  `端点：POST ${ASR_FLASH_PATH}`,
  '鉴权：仅支持新版 X-Api-Key（旧版双头返回 45000000 resourceId is not allowed）',
  '资源 id：volc.seedasr.sauc.duration（其它 volc.bigasr.* 均未授权）',
  '请求体：{ user:{uid}, audio:{format,data|url}, request:{model_name,enable_itn,enable_punc} }',
  '响应：result.text 为全文，result.utterances[] 带毫秒级 start_time/end_time（含逐字 words）',
  '错误：鉴权/资源类错误可能是 HTTP 403 + 响应体 { header: { code, message } }',
])

/**
 * 校验并解析音频文件路径。
 *
 * 路径必须落在工作区内：`../` 逃逸与符号链接逃逸都会被拒（后者靠 realpath 判定），
 * 因为"读本地文件"是这个模块唯一可能被用来越权读取的入口。
 *
 * 签名里没有 cwd 字段（接口文档冻结了 transcribe 的入参），所以默认取进程工作目录 ——
 * 插件运行时进程 cwd 就是工作区；测试与调用方都可以显式传 cwd 覆盖。
 *
 * @param {{audioPath: string, cwd?: string, maxBytes?: number}} input
 * @returns {Promise<{path: string, relativePath: string, bytes: number}>}
 */
export async function resolveAudioFile({ audioPath, cwd = process.cwd(), maxBytes = DEFAULT_MAX_AUDIO_BYTES } = {}) {
  if (typeof audioPath !== 'string' || !audioPath.trim()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, 'audioPath 必须是非空的本地文件路径。', {
      provider: 'speech',
    })
  }

  const root = path.resolve(cwd)
  const absolute = path.resolve(root, audioPath)

  if (!isInside(root, absolute)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `audioPath 必须位于工作区内：${absolute}`,
      { provider: 'speech' },
    )
  }

  // 目录里可能存在指向工作区外的符号链接：先解析真实路径，再做一次包含判定。
  let realPath
  try {
    realPath = await fs.realpath(absolute)
  } catch (err) {
    throw new ArkError(ARK_ERROR_CODES.FILE, `读取音频文件失败：${absolute}`, {
      provider: 'speech',
      cause: err,
    })
  }
  let realRoot = root
  try {
    realRoot = await fs.realpath(root)
  } catch {
    // 工作区不存在时保留原 root，后面的包含判定仍然有效。
  }
  if (!isInside(realRoot, realPath)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `audioPath 指向工作区外的真实路径（符号链接逃逸）：${realPath}`,
      { provider: 'speech' },
    )
  }

  let stat
  try {
    stat = await fs.stat(realPath)
  } catch (err) {
    throw new ArkError(ARK_ERROR_CODES.FILE, `读取音频文件失败：${realPath}`, {
      provider: 'speech',
      cause: err,
    })
  }
  if (!stat.isFile()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, `audioPath 不是普通文件：${realPath}`, {
      provider: 'speech',
    })
  }
  if (stat.size === 0) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, `音频文件为空：${realPath}`, {
      provider: 'speech',
    })
  }
  if (stat.size > maxBytes) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `音频文件 ${stat.size} 字节，超过上限 ${maxBytes} 字节；请先切分或改用分片识别。`,
      { provider: 'speech' },
    )
  }

  return {
    path: realPath,
    relativePath: path.relative(realRoot, realPath).split(path.sep).join('/'),
    bytes: stat.size,
  }
}

/**
 * 判定 target 是否在 root 之内（含 root 自身）。
 *
 * ⚠️ 这里**必须**判断 `rel === '..'` 或以 `'..' + 分隔符` 开头，不能只写
 * `rel.startsWith('..')` —— 后者会把工作区内**合法的**、名字以两个点开头的文件
 * （例如 `..foo.mp3`）误判成越界并拒绝读取。这类误判很难察觉：用户只会看到
 * "文件必须位于工作区内"，而文件明明就在工作区里。
 */
function isInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  if (rel === '..') return false
  return !rel.startsWith(`..${path.sep}`)
}

/**
 * 解析 ASR 凭据：复用与 TTS 相同的双通道逻辑，再补上 ASR 资源 id。
 * 之所以单独包一层：ASR 的资源 id 与 TTS 不同，实测实现时不应该再自己拼一遍。
 *
 * @returns {Promise<{channel: 'speech'|'ark', appId: string, accessKey: string, resourceId: string}>}
 */
export async function resolveAsrCredentials(config, creds) {
  const speech = config && typeof config === 'object' && config.speech ? config.speech : {}
  const base = await resolveSpeechCredentials({ ...config, speech }, creds)
  const resourceId = speech.resourceAsr
  if (!resourceId) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'config.speech.resourceAsr 未配置，无法确定 X-Api-Resource-Id。',
      { provider: 'speech' },
    )
  }
  return { ...base, resourceId }
}

/**
 * 语音转写（录音文件识别极速版）。
 *
 * @param {object} input
 * @param {object} input.config
 * @param {object} input.creds
 * @param {string} input.audioPath 工作区内的本地音频路径
 * @param {string} [input.language] 语种提示（该接口主要由模型自判，这里仅透传为提示）
 * @param {boolean} [input.enablePunctuation] 是否输出标点，默认 true
 * @param {string} [input.cwd] 工作区根目录
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{text: string, durationMs?: number, segments: Array<{text: string, startMs?: number, endMs?: number}>, format: string, bytes: number, requestId?: string, raw?: unknown}>}
 */
export async function transcribe(input, opts = {}) {
  const source = input ?? {}
  if (opts.signal?.aborted) {
    throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider: 'speech' })
  }

  const { config, creds, cwd } = source
  const speech = config?.speech ?? {}

  // 鉴权只有一条路：API Key（缺了会由 resolveSpeechCredentials 抛 MISSING_CREDENTIAL）。
  const speechCreds = await resolveSpeechCredentials(config, creds)

  const resourceId = speech.resourceAsr || 'volc.seedasr.sauc.duration'
  const file = await resolveAudioFile({ audioPath: source.audioPath, cwd: cwd || process.cwd() })
  const bytes = await fs.readFile(file.path)
  const format = asrAudioFormat(file.path)

  const baseUrl = String(speech.baseUrl || 'https://openspeech.bytedance.com/api/v3').replace(/\/+$/, '')
  const timeoutMs = Math.min(Number(config?.ark?.requestTimeoutMs) || 300_000, 2_147_483_647)
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  const body = {
    user: { uid: 'dsh-ark' },
    audio: { format, data: bytes.toString('base64') },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: source.enablePunctuation !== false,
    },
  }
  // 语种只作为可选提示透传；接口以模型自判为主。
  if (source.language && String(source.language).trim()) {
    body.request.language = String(source.language).trim()
  }

  let response
  try {
    response = await (opts.fetchImpl || globalThis.fetch)(`${baseUrl}${ASR_FLASH_PATH}`, {
      method: 'POST',
      headers: {
        'X-Api-Key': speechCreds.apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': nextRequestId('dsh-ark-asr'),
        // 极速版是"一次性整段"语义，用 -1 表示不带分片序号（实测该头不影响成功）
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    })
  } catch (err) {
    if (signal.aborted || err?.name === 'AbortError') {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '语音识别已被取消。', { provider: 'speech', cause: err })
    }
    throw new ArkError(ARK_ERROR_CODES.NETWORK, `语音识别请求失败：${err?.message || err}`, {
      provider: 'speech',
      cause: err,
    })
  }

  const raw = await response.text()
  const requestId =
    response.headers.get('x-tt-logid') || response.headers.get('x-request-id') || undefined

  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `语音识别返回了非 JSON 响应（HTTP ${response.status}）：${raw.slice(0, 300)}`,
      { provider: 'speech', httpStatus: response.status, requestId },
    )
  }

  /**
   * 错误判定必须**同时**看 HTTP 状态与响应体的 `header.code`：
   * 实测里 45000030 是以 HTTP 403 + `{"header":{"code":45000030,…}}` 返回的。
   */
  const headerCode = json?.header?.code
  const failed = !response.ok || (headerCode !== undefined && Number(headerCode) !== 0)
  if (failed) {
    const code = Number(headerCode)
    const mapped =
      code === 45000010
        ? ARK_ERROR_CODES.AUTHENTICATION
        : code === 45000030
          ? ARK_ERROR_CODES.PERMISSION
          : code === 45000000
            ? ARK_ERROR_CODES.INVALID_PARAMETER
            : response.status === 429
              ? ARK_ERROR_CODES.RATE_LIMITED
              : ARK_ERROR_CODES.HTTP
    const hint =
      code === 45000030
        ? `（资源 id 用的是 ${resourceId}；实测只有 volc.seedasr.sauc.duration 在授权范围内）`
        : ''
    throw new ArkError(
      mapped,
      `语音识别失败（HTTP ${response.status}${headerCode !== undefined ? `, code=${headerCode}` : ''}）`
        + `${json?.header?.message ? `：${json.header.message}` : ''}${hint}`,
      { provider: 'speech', httpStatus: response.status, requestId },
    )
  }

  const result = json?.result ?? {}
  const text = typeof result.text === 'string' ? result.text : ''
  if (!text) {
    // 成功但没文本：可能是纯静音音频，也可能是结构变化 —— 如实报出来，别给空串当成功。
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `语音识别返回成功但没有识别到文本（result.text 为空）：${raw.slice(0, 300)}`,
      { provider: 'speech', requestId },
    )
  }

  // 时间戳单位实测为**毫秒**。
  const segments = Array.isArray(result.utterances)
    ? result.utterances.map((u) => ({
        text: String(u?.text ?? ''),
        startMs: Number.isFinite(u?.start_time) ? u.start_time : undefined,
        endMs: Number.isFinite(u?.end_time) ? u.end_time : undefined,
      }))
    : []

  return {
    text,
    durationMs: Number.isFinite(json?.audio_info?.duration) ? json.audio_info.duration : undefined,
    segments,
    format,
    bytes: file.bytes,
    requestId,
    raw: json,
  }
}
