/**
 * SeedAudio 1.0「音频生成」（Audio Generation）。
 *
 * 与语音合成（TTS）是**两条不同的产品线**，别混：
 *   · TTS（volc-tts.mjs）：给一个**音色** + 文本 → 念出来。走 `/tts/unidirectional[/sse]`。
 *   · 音频生成（本文件）：给一段**自然语言描述** → 直接生成音频。
 *     走 `POST /tts/create`，模型名 `seed-audio-1.0`。
 *
 * ⚠️ **音频生成模型没有"音色"这个概念。**
 * 不能用它"选一个音色来念台词" —— 要音色请用 `ark_speak`（TTS）。
 * 想影响生成结果，只有两条路：
 *   ① 在 `text_prompt` 里**用文字描述**想要的声音（如"温柔清澈的少女嗓音"）；
 *   ② 给 `references` 传参考素材（音频/图片/视频），让模型照着参考生成。
 * 传 `speaker`（TTS 那种音色 ID）会被上游**明确拒绝**（`45001115`），
 * 详见 `buildAudioRequestBody` 的注释。
 *
 * 端点、鉴权与响应结构均为**实测确认**（2026-10-11，真实凭据）：
 *   · 鉴权：`X-Api-Key`
 *   · 请求体最小形态：`{ model, text_prompt }`
 *   · 响应：`{ audio: <base64>, duration, original_duration, url }`
 *   · `audio_config.format` 不传时默认 **wav**（体积约为 mp3 的 20 倍），
 *     显式传 `mp3` / `wav` / `ogg_opus` 时容器与声明一致（已用文件头验证）。
 *   · 未知字段被**静默忽略**（传 `foo` / `audio_config.nope` 都不报错），
 *     但已知字段会被严格校验 —— 所以"没报错"不能当作"参数生效了"的证据。
 *   · 同一 prompt 多次生成**结果不同**（内容有随机性），因此不能靠"输出一致"判断参数是否生效。
 */

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'
import { resolveSpeechCredentials } from './config.mjs'
import { probeAudioHeader } from './volc-tts.mjs'

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

/** 实测可用的输出格式 → MIME/扩展名。 */
const AUDIO_FORMATS = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav' },
  ogg_opus: { mime: 'audio/ogg', ext: 'ogg' },
  pcm: { mime: 'audio/pcm', ext: 'pcm' },
}

/** 默认用 mp3：不传 format 时上游给 wav，体积大 ~20 倍且不适合分发。 */
export const DEFAULT_AUDIO_FORMAT = 'mp3'
export const DEFAULT_AUDIO_SAMPLE_RATE = 24_000

/** 参考音频的实测限制（来自官方文档，SDK 也做同样校验）。 */
export const MAX_REFERENCE_AUDIO = 3

/**
 * 规范化输出格式。
 * @param {string|undefined} format
 */
export function normalizeAudioFormat(format) {
  const value = String(format ?? DEFAULT_AUDIO_FORMAT).trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(AUDIO_FORMATS, value)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `不支持输出格式 ${format}。可用：${Object.keys(AUDIO_FORMATS).join(' / ')}。`,
    )
  }
  return value
}

/**
 * 组装请求体。
 *
 * `text_prompt` 的语义随 `references` 变化（官方口径）：
 *   · 无参考 → 描述"要生成什么音频"
 *   · 有音频参考 → 可在提示里用 `@音频1` / `@音频2` / `@音频3` 指代（按上传顺序编号）
 *   · 有图片参考 → 只能是"要念出来的文本"
 *
 * ⚠️ **`references` 里没有 `speaker` 这个可用字段。**
 * `seed-audio-1.0` 是**音频生成**模型，**没有音色概念**。实测把 `speaker` 当一个
 * "与 TTS 共用的音色参数"传进来，上游会明确拒绝而不是忽略：
 *
 * ```
 * HTTP 400  code=45001115
 * speaker xxx not found in speaker_map, speaker_audio, or mega_info
 * ```
 *
 * 该报错的另一句还给出了 `references` 的合法字段表（每个条目**必须且只能**给一个）：
 * `speaker / audio_data / audio_url / image_data / image_url / video_url`。
 * 其中 `speaker` 指"已注册进 speaker_map 的音色（如 TTS 音色或克隆音色）"，
 * 而不是"任意音色字符串"—— 传未注册的值就是上面的 400。
 *
 * 因此本函数**不再接受 speaker**：把音色当参数是误用，静默丢掉反而更糟
 * （用户会以为设置生效了）。纯函数，便于单测。
 */
export function buildAudioRequestBody(input) {
  const model = String(input.model || 'seed-audio-1.0').trim()
  const textPrompt = String(input.textPrompt ?? '').trim()
  if (!textPrompt) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'text_prompt 不能为空：请描述要生成的音频（或用它给出要朗读的文本）。',
    )
  }
  const format = normalizeAudioFormat(input.format)
  const sampleRate = Number.isFinite(input.sampleRate) ? Number(input.sampleRate) : DEFAULT_AUDIO_SAMPLE_RATE

  /** @type {Record<string, unknown>} */
  const body = { model, text_prompt: textPrompt, audio_config: { format, sample_rate: sampleRate } }

  const references = Array.isArray(input.references) ? input.references.filter(Boolean) : []
  if (references.length > 0) {
    /**
     * 普通音频/图片素材互斥（音频与图片不能混用，官方限制）。
     * `speaker` **不**参与互斥判定 —— 它既不是音频也不是图片；但本插件不再生成它。
     */
    const withAudio = references.filter((r) => r.audioData || r.audioUrl)
    const withImage = references.filter((r) => r.imageUrl)
    if (withAudio.length > 0 && withImage.length > 0) {
      throw new ArkError(
        ARK_ERROR_CODES.INVALID_PARAMETER,
        'references 不能混用音频与图片参考：一次请求只能都是音频、或只给一张图片。',
      )
    }
    if (withAudio.length > MAX_REFERENCE_AUDIO) {
      throw new ArkError(
        ARK_ERROR_CODES.INVALID_PARAMETER,
        `参考音频最多 ${MAX_REFERENCE_AUDIO} 条（收到 ${withAudio.length} 条）。`,
      )
    }
    /**
     * 上下游都要求"每个条目必须且只能给一个素材字段"：
     *   `reference[0] must have exactly one of speaker/audio_data/audio_url/image_data/image_url/video_url`
     * 所以先映射、再把空条目过滤掉；**若过滤后一条不剩，就完全不要 `references` 字段** ——
     * 留一个 `references: []` 虽多半无害，但它会让"有没有传参考"这件事在抓包里变得含糊。
     */
    const mapped = references
      .map((r) => {
        const item = {}
        if (r.audioData) item.audio_data = String(r.audioData)
        if (r.audioUrl) item.audio_url = String(r.audioUrl)
        if (r.imageUrl) item.image_url = String(r.imageUrl)
        return item
      })
      .filter((item) => Object.keys(item).length > 0)
    if (mapped.length > 0) body.references = mapped
  }

  return { body, format }
}

/**
 * 生成音频。
 *
 * 响应里**同时**有 base64 音频与一个临时 URL（上游只保 2 小时），
 * 因此照插件一贯做法：本地落盘，不回传临时直链。
 *
 * @param {object} input
 * @param {object} input.config
 * @param {{resolve: Function, require: Function}} input.creds
 * @param {{save: Function}} input.store
 * @param {string} input.textPrompt
 * @param {string} [input.model]
 * @param {string} [input.format]
 * @param {number} [input.sampleRate]
 * @param {Array<{audioData?: string, audioUrl?: string, imageUrl?: string}>} [input.references]
 *   参考素材。**没有 `speaker`**：音频生成模型无音色概念。
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 */
export async function generateAudio(input, opts = {}) {
  const { config, creds, store } = input
  const speech = config.speech

  // 鉴权只有一条路：API Key（缺了会由 resolveSpeechCredentials 抛 MISSING_CREDENTIAL）。
  const credsResolved = await resolveSpeechCredentials(config, creds)

  const { body, format } = buildAudioRequestBody({
    model: input.model,
    textPrompt: input.textPrompt,
    format: input.format,
    sampleRate: input.sampleRate,
    references: input.references,
  })

  const baseUrl = String(speech.baseUrl || '').replace(/\/+$/, '')
  const url = `${baseUrl}/tts/create`
  const timeoutMs = Math.min(Number(config?.ark?.requestTimeoutMs) || 300_000, 2_147_483_647)
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  let response
  try {
    response = await (opts.fetchImpl || globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        'X-Api-Key': credsResolved.apiKey,
        'Content-Type': 'application/json',
        'X-Api-Request-Id': nextRequestId('dsh-ark-audio'),
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    })
  } catch (err) {
    /**
     * ⚠️ 判定顺序很重要：**先看 `err.name`，再看 `signal.aborted`**。
     *
     * `signal` 是 `AbortSignal.any([调用方 signal, AbortSignal.timeout(...)])`，
     * 而 `AbortSignal.timeout` 触发时**也会**把 `signal.aborted` 置为 true。
     * 原实现写的是 `if (signal.aborted || err?.name === 'AbortError')`，
     * 左支先命中 → 本机回环实测：超时被报成"音频生成已被取消"。
     *
     * 两者对模型的含义完全相反：取消 = 调用方主动停止、不该重试；
     * 超时 = 服务端慢或网络慢、**可以重试**（且应提示缩短输入）。
     * 同仓 `lib/http.mjs` / `lib/volc-tts.mjs` 的写法是对的，这里对齐。
     */
    if (err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') {
      throw new ArkError(ARK_ERROR_CODES.TIMEOUT, '音频生成请求超时（服务端未在时限内响应）。可重试；若反复超时请缩短提示词或稍后再试。', {
        retryable: true,
        cause: err,
      })
    }
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '音频生成已被取消。', { cause: err })
    }
    throw new ArkError(ARK_ERROR_CODES.NETWORK, `音频生成请求失败：${err?.message || err}`, { cause: err })
  }

  const raw = await response.text()
  const requestId = response.headers.get('x-tt-logid') || response.headers.get('x-request-id') || undefined
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `音频生成返回了非 JSON 响应（HTTP ${response.status}）：${raw.slice(0, 300)}`,
      { provider: 'speech', httpStatus: response.status, requestId },
    )
  }

  if (!response.ok || (json.code !== undefined && Number(json.code) !== 0)) {
    const code = Number(json.code)
    // 实测过的码：鉴权类会以 HTTP 200 + code 返回，所以不能只看 HTTP 状态。
    const mapped =
      code === 45000010
        ? ARK_ERROR_CODES.AUTHENTICATION
        : code === 45000030
          ? ARK_ERROR_CODES.PERMISSION
          : response.status === 429
            ? ARK_ERROR_CODES.RATE_LIMITED
            : ARK_ERROR_CODES.HTTP
    throw new ArkError(
      mapped,
      `音频生成失败（HTTP ${response.status}${json.code !== undefined ? `, code=${json.code}` : ''}）`
        + `${json.message ? `：${json.message}` : ''}`,
      { provider: 'speech', httpStatus: response.status, requestId },
    )
  }

  const base64 = typeof json.audio === 'string' ? json.audio : ''
  if (!base64) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `音频生成返回成功但没有 audio 字段：${raw.slice(0, 300)}`,
      { provider: 'speech', requestId },
    )
  }

  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
  if (bytes.byteLength === 0) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, '音频生成返回了空音频。', {
      provider: 'speech',
      requestId,
    })
  }

  // 用真实文件头判定容器，而不是信任请求里写的 format —— 两者不一致时以文件为准
  // （实测：不传 audio_config 时上游给的是 wav，与"默认 mp3"的直觉相反）。
  const probed = probeAudioHeader(bytes)
  const declared = AUDIO_FORMATS[format]
  const actualMime = probed ? AUDIO_FORMATS[probed]?.mime : declared.mime
  const actualExt = probed || declared.ext

  const saved = await store.save({
    bytes,
    hint: String(input.textPrompt).slice(0, 24),
    mime: actualMime,
    ext: actualExt,
  })

  return {
    audio: saved,
    model: body.model,
    // 实际容器（按文件头判定）
    format: probed || format,
    requestedFormat: format,
    durationSeconds: Number.isFinite(json.duration) ? json.duration : undefined,
    originalDurationSeconds: Number.isFinite(json.original_duration) ? json.original_duration : undefined,
    referenceCount: Array.isArray(body.references) ? body.references.length : 0,
    requestId,
  }
}
