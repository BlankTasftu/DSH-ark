/**
 * Seedance 视频生成（**异步任务模型**）。
 *
 * 与图像模块最大的区别：视频任务**提交即计费**（按秒计费，是本插件最贵的调用）。
 * 因此本模块有一条不可越界的铁律：
 *
 *   一个 taskId 只允许由一次 POST /contents/generations/tasks 产生；
 *   之后无论轮询失败、超时、取消还是进程重启，都只能拿这个 id 去 GET 查询，
 *   **任何情况下都不得重新提交**（重提 = 另建一个计费任务）。
 *
 * 由此推导出三个设计选择：
 *  1. createVideoTask 与 waitForVideo 彻底分离：工具层可以「提交一次 → 先落 task_id →
 *     稍后（甚至下一个会话）用同一个 id 继续轮询」。
 *  2. waitForVideo 超时**不是失败**：返回 { timedOut: true, taskId }，把「还在渲染」与
 *     「生成失败」严格区分开，调用方据此继续查询而不是重跑。
 *  3. output_url 是 TOS 预签名 URL，**24 小时后失效**，所以轮询到 succeeded 必须立刻
 *     下载落盘；只把 URL 回传给用户等于交付了一个明天就打不开的链接。
 *
 * 只依赖共享层（errors / http / artifacts），不 import 插件层、不读全局、不自取密钥。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'
import { requestBytes, requestJson } from './http.mjs'

/** 任务状态语义分组：终态判定与「还要不要继续轮询」都只认这三张表。 */
const TERMINAL_SUCCESS = new Set(['succeeded', 'success'])
const TERMINAL_FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled', 'expired'])

/** 本地素材内联上限 8MB：再大就没有理由 base64（体积膨胀 4/3），应当改用 URL。 */
export const MAX_LOCAL_MEDIA_BYTES = 8 * 1024 * 1024

/**
 * 视频 / 音频的本地内联开关，**默认关闭**（实际由 `input.allowLocalVideoAudio === true` 控制）。
 *
 * 为什么默认关闭：数据面对 `reference_video` / `reference_audio` 的 data URL
 * 直接返回 HTTP 400（`reference_video must be provided as a web url`），任务不会创建；
 * 图片内联则是**被支持**的。与其把本地视频转成 base64 发出去、等着上游 400，
 * 不如在本地就明确拒绝并告诉调用方「先上传到 TOS / 用可访问的 URL」——省一次往返，
 * 也不会让人误以为参数合法。需要内联的场景（例如自建网关上已支持）可显式打开。
 *
 * 该结论来自 ark-cli v1.0.37 随包 Skills（`arkcli-gen/references/intent-and-validation.md`）——
 * 那份镜像已不再随仓库分发，此处保留结论与原始措辞以便核对。
 */

/** 单次状态查询的默认超时：轮询请求本身必须比总渲染时间短得多，否则一次挂起会吃掉整个预算。 */
const DEFAULT_POLL_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 5_000
/** 默认总等待 10 分钟，与 arkcli `+gen --wait` 的默认口径一致（长视频请显式调大）。 */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000

/** 扩展名 → MIME，用于把本地素材转成 data URL。 */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
}

/** 下载产物时按上游 Content-Type 兜底选扩展名（ArtifactStore 认不出视频容器，得我们给）。 */
const VIDEO_EXT_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'application/octet-stream': 'mp4',
}

/** 参考素材类型 → 协议里的 role。空 role 会被数据面 400 拒绝，所以一律显式标注。 */
const ROLE_BY_KIND = {
  image: 'reference_image',
  video: 'reference_video',
  audio: 'reference_audio',
}

const isHttpUrl = (value) => /^https?:\/\//i.test(value)
const isDataUrl = (value) => /^data:/i.test(value)

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${suffix}`
}

/** 把 taskId 安全地放进 path。id 由上游签发，这里只做防御性编码，避免拼出畸形 URL。 */
function taskUrl(baseUrl, taskId) {
  const id = String(taskId || '').trim()
  if (!id) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, '缺少 taskId：查询视频任务必须指明具体任务。')
  }
  return joinUrl(baseUrl, `/contents/generations/tasks/${encodeURIComponent(id)}`)
}

/** 判断 target 是否真的在 root 之内（逐段比较，避免 "..foo" 这类同名前缀的误判）。 */
function isInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel.split(path.sep)[0] !== '..'
}

/** 工作区根的真实路径（Windows 上 cwd 常经 junction/符号链接访问，不归一会误伤）。 */
async function realWorkspaceRoot(cwd) {
  const root = path.resolve(cwd)
  try {
    return await fs.realpath(root)
  } catch {
    return root
  }
}

/**
 * 读取本地素材并转 data URL。
 *
 * 安全边界（契约 3.5）：本地路径必须落在 cwd 内 —— 否则模型可以用 `../../.ssh/id_rsa`
 * 把工作区外的任意文件读出来塞进请求体，这是一条真实的数据外泄通道。
 *
 * ⚠️ 判定必须**在 realpath 之后**做：只做词法 path.resolve + relative 会被工作区内的
 * junction / 符号链接绕过（链接本身在 cwd 内，目标在外面）。该向量已实测复现，勿回退。
 */
async function localFileToDataUrl(input, cwd) {
  const root = await realWorkspaceRoot(cwd)
  const abs = path.resolve(root, input)

  // 第一层：词法判定。像 `../../etc/passwd` 这种**字面上就越界**的路径在这里就拒掉，
  // 好处是错误码稳定为 INVALID_PARAMETER（不会被 realpath 的 ENOENT 覆盖成 FILE），
  // 也不会泄漏"工作区外某个路径是否存在"。
  if (!isInside(root, abs)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `参考素材路径越界：${input} 不在工作区 ${cwd} 内。`,
    )
  }

  // 第二层：真实路径判定。词法在界内但目标经 junction / 符号链接指向界外时，只有这一层能挡住。
  let real
  try {
    real = await fs.realpath(abs)
  } catch (err) {
    throw new ArkError(
      ARK_ERROR_CODES.FILE,
      `读取参考素材失败：${input}（${err && err.message ? err.message : String(err)}）`,
      { cause: err },
    )
  }
  if (!isInside(root, real)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `参考素材路径越界：${input} 不在工作区 ${cwd} 内。`,
    )
  }

  let stat
  try {
    stat = await fs.stat(real)
  } catch (err) {
    throw new ArkError(ARK_ERROR_CODES.FILE, `读取参考素材失败：${input}（${err.message}）`, { cause: err })
  }
  if (!stat.isFile()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, `参考素材不是文件：${input}`)
  }
  // 先看大小再读：一个 2GB 的本地视频如果先 readFile 再判大小，进程已经先被内存压垮了。
  if (stat.size > MAX_LOCAL_MEDIA_BYTES) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `本地参考素材 ${input} 有 ${stat.size} 字节，超过内联上限 `
        + `${MAX_LOCAL_MEDIA_BYTES} 字节（base64 会让请求体再涨约 1/3）。`
        + '请先把素材上传到对象存储或任意可公网访问的位置，改用 URL 传入。',
    )
  }

  const bytes = await fs.readFile(real)
  const ext = path.extname(real).slice(1).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * 把调用方给的素材引用（本地路径 / http(s) URL / data URL）统一解析成协议里的 url 字符串。
 *
 * @param {string} ref
 * @param {string} cwd
 * @param {{ allowLocalVideoAudio?: boolean, label: string, kind: 'image'|'video'|'audio' }} ctx
 */
async function resolveMediaRef(ref, cwd, ctx) {
  const value = String(ref || '').trim()
  if (!value) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, `${ctx.label} 的素材引用为空。`)
  }
  if (isDataUrl(value)) return value
  if (isHttpUrl(value)) return value

  if (ctx.kind === 'video' || ctx.kind === 'audio') {
    if (!ctx.allowLocalVideoAudio) {
      throw new ArkError(
        ARK_ERROR_CODES.INVALID_PARAMETER,
        `${ctx.label} 只接受 http(s) URL 或 data URL：本地文件需先上传到可访问的存储`
          + '（数据面对视频/音频的 data URL 会直接返回 400，任务不会创建）。'
          + `当前收到本地路径 ${value}。`,
      )
    }
  }
  return localFileToDataUrl(value, cwd)
}

/** 组装 content 数组：text 在前，随后按 role 标注的素材块。顺序与 role 都由调用方语义决定，不重排。 */
async function buildContentArray({ prompt, cwd, input }) {
  const content = [{ type: 'text', text: String(prompt) }]
  const allowLocalVideoAudio = input.allowLocalVideoAudio === true

  if (input.firstFrame) {
    content.push({
      type: 'image_url',
      image_url: {
        url: await resolveMediaRef(input.firstFrame, cwd, { label: '首帧', kind: 'image' }),
      },
      role: 'first_frame',
    })
  }
  if (input.lastFrame) {
    content.push({
      type: 'image_url',
      image_url: {
        url: await resolveMediaRef(input.lastFrame, cwd, { label: '尾帧', kind: 'image' }),
      },
      role: 'last_frame',
    })
  }
  for (const [index, ref] of (input.referenceImages || []).entries()) {
    content.push({
      type: 'image_url',
      image_url: {
        url: await resolveMediaRef(ref, cwd, { label: `参考图 #${index + 1}`, kind: 'image' }),
      },
      // 带视频的请求里，同请求的图片必须带 role，否则整条请求被 400 拒绝：
      // 所以这里从不留空 role，宁可显式写成 reference_image。
      role: 'reference_image',
    })
  }
  if (input.referenceVideo) {
    content.push({
      type: 'video_url',
      video_url: {
        url: await resolveMediaRef(input.referenceVideo, cwd, {
          label: '参考视频',
          kind: 'video',
          allowLocalVideoAudio,
        }),
      },
      role: 'reference_video',
    })
  }
  if (input.referenceAudio) {
    content.push({
      type: 'audio_url',
      audio_url: {
        url: await resolveMediaRef(input.referenceAudio, cwd, {
          label: '参考音频',
          kind: 'audio',
          allowLocalVideoAudio,
        }),
      },
      role: 'reference_audio',
    })
  }
  return content
}

/**
 * 组装请求体。
 *
 * 关键点：`duration` 与 `frames` 是**互斥**的（frames 在支持的模型上覆盖 duration）。
 * 同时传两个不会「都生效」，只会让服务端按其中之一静默丢弃，用户看到的成品时长就不可预期。
 * 这里选择「显式报错」而不是替调用方猜——时长直接决定计费金额，静默改写是最坏的选择。
 */
async function buildRequestBody(input, cwd) {
  const { config } = input
  if (input.duration !== undefined && input.frames !== undefined) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'duration 与 frames 互斥：frames 会覆盖 duration，请只传其中一个（时长直接决定计费，不替你猜）。',
    )
  }
  const text = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!text && !input.firstFrame) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'prompt 不能为空：纯文本生视频至少要给一段提示词，或以 firstFrame 作为首帧输入。',
    )
  }

  const body = {
    model: input.model || config.ark.videoModel,
    content: await buildContentArray({ prompt: text, cwd, input }),
  }
  // 未显式传入的可选参数一律**不发**：交给模型自己的默认值，避免我们替用户决定
  // 分辨率/时长/是否出声，也就不会凭空改变费用。
  if (input.ratio !== undefined) body.ratio = input.ratio
  if (input.resolution !== undefined) body.resolution = input.resolution
  if (input.duration !== undefined) body.duration = input.duration
  if (input.frames !== undefined) body.frames = input.frames
  if (input.watermark !== undefined) body.watermark = input.watermark
  if (input.generateAudio !== undefined) body.generate_audio = input.generateAudio
  if (input.cameraFixed !== undefined) body.camera_fixed = input.cameraFixed
  return body
}

/** 收集产物 URL：兼容 output_url（单数）与 output_urls（复数）两种上游形态。 */
function pickOutputUrls(raw) {
  const urls = []
  if (Array.isArray(raw?.output_urls)) {
    for (const url of raw.output_urls) if (url) urls.push(String(url))
  }
  if (raw?.output_url) urls.push(String(raw.output_url))
  return [...new Set(urls)]
}

/**
 * 归一化任务状态。
 *
 * 上游同时在用两种形态：契约 §1.2 记的是 `{status: "succeeded"}`，而 arkcli 的 VideoTask
 * 是 `{status: {phase, message}}`。只认其中一种都会在真实调用里把终态判错，所以两种都支持。
 */
function normalizeTask(raw) {
  const rawStatus = raw?.status
  const status =
    rawStatus && typeof rawStatus === 'object'
      ? String(rawStatus.phase || rawStatus.status || '')
      : String(rawStatus || '')
  const statusMessage =
    rawStatus && typeof rawStatus === 'object' ? rawStatus.message || rawStatus.reason : undefined
  const failureReason =
    raw?.failure_reason || raw?.error?.message || raw?.error || statusMessage || undefined
  const outputUrls = pickOutputUrls(raw)
  const taskId = String(raw?.id || raw?.task_id || '')
  return { status, taskId, outputUrls, failureReason }
}

function assertTaskPayload(json, { context, requestId }) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, `${context}返回了非任务对象：${JSON.stringify(json)?.slice(0, 200)}`, {
      provider: 'ark',
      requestId,
    })
  }
  return json
}

/** 把上游失败原因收敛成可读文本；失败详情可能藏在 status.message / error / failure_reason 里。 */
function describeFailure(reason) {
  if (!reason) return '未提供失败原因'
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason).slice(0, 500)
  } catch {
    return String(reason)
  }
}

/** 下载并落盘所有产物。失败时**不上抛**：任务已经计费成功，不能因为下载失败就丢掉 taskId。 */
async function saveOutputs({ input, outputUrls, opts, hint }) {
  const { config, store } = input
  const videos = []
  const warnings = []
  for (const url of outputUrls) {
    try {
      const downloaded = await requestBytes({
        url,
        signal: opts?.signal,
        timeoutMs: config.ark.downloadTimeoutMs,
        fetchImpl: opts?.fetchImpl,
      })
      const mime = downloaded.contentType
      const mimeKey = String(mime || '').split(';')[0].trim().toLowerCase()
      videos.push(
        await store.save({
          bytes: downloaded.bytes,
          hint,
          mime,
          // 产物是视频任务产出的，扩展名兜底也必须落成视频：ArtifactStore 的魔数探测
          // 只认图片容器，不显式给 ext 会得到一个 .bin 的「视频文件」。
          ext: VIDEO_EXT_BY_MIME[mimeKey] || 'mp4',
        }),
      )
    } catch (err) {
      warnings.push(`产物下载失败（${url}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { videos, warnings }
}

/** 可被取消的 sleep：轮询等待期间也必须能立刻响应 opts.signal。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。'))
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。'))
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      // 兜底：signal 在挂载监听前的一瞬间被触发时，上面的分支已经错过，这里再确认一次。
      if (signal.aborted) onAbort()
    }
  })
}

/**
 * 提交一个视频生成任务。
 *
 * **这是一次计费动作**：每个成功返回的 taskId 都代表服务端已受理并开始计费。
 * 所以本函数只发一次 POST；调用方必须把返回的 taskId 持久化，后续一律用 getVideoTask /
 * waitForVideo 查询，绝不重新调用本函数。
 */
export async function createVideoTask(input, opts) {
  const { config, creds } = input
  const cwd = input.cwd || process.cwd()
  const apiKey = await creds.require(config.ark.credential, '视频生成需要方舟 API Key。')
  const body = await buildRequestBody(input, cwd)

  const { json, requestId } = await requestJson({
    url: joinUrl(config.ark.baseUrl, '/contents/generations/tasks'),
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: opts?.signal,
    timeoutMs: config.ark.requestTimeoutMs,
    // 仅 429/限流 会退避重试（http.mjs 内保证），此时上游没有建任务，重试不会重复计费；
    // 参数错误（400/InvalidParameter）绝不重试 —— 重试只会白烧一次配额。
    retries: config.ark.rateLimitRetries,
    retryBackoffMs: config.ark.rateLimitBackoffMs,
    provider: 'ark',
    fetchImpl: opts?.fetchImpl,
  })

  const raw = assertTaskPayload(json, { context: '提交视频任务', requestId })
  const { taskId, status } = normalizeTask(raw)
  if (!taskId) {
    // 没有 id 就没有「对账面」：调用方拿不到 id 就无法查询，只能记 UNKNOWN 交给人工排查。
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      '上游接受了视频任务但没有返回任务 id，无法后续查询；请凭 request_id 到控制台核对任务，不要重复提交。',
      { provider: 'ark', requestId },
    )
  }
  return { taskId, status, raw, requestId }
}

/**
 * 查询一次任务状态（**不产生新任务**，也不下载产物）。
 *
 * 与 createVideoTask 分开的原因：工具层要能把 task_id 落下来，跨调用/跨会话继续查询；
 * 轮询只是「反复调用本函数」，本身不具备任何提交能力。
 */
export async function getVideoTask(input, opts) {
  const { config, creds, taskId } = input
  const apiKey = await creds.require(config.ark.credential, '查询视频任务需要方舟 API Key。')

  const { json, requestId } = await requestJson({
    url: taskUrl(config.ark.baseUrl, taskId),
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: opts?.signal,
    timeoutMs: DEFAULT_POLL_REQUEST_TIMEOUT_MS,
    provider: 'ark',
    fetchImpl: opts?.fetchImpl,
  })

  const raw = assertTaskPayload(json, { context: '查询视频任务', requestId })
  const normalized = normalizeTask(raw)
  return {
    taskId: normalized.taskId || String(taskId),
    status: normalized.status,
    outputUrls: normalized.outputUrls,
    raw,
    requestId,
  }
}

/**
 * 轮询到终态或超时；`succeeded` 时立刻把产物下载落盘。
 *
 * **超时 ≠ 失败**：撞到 timeoutMs 只说明「这次没等到」，服务端任务仍在渲染并继续计费，
 * 所以返回 `{ timedOut: true, taskId }`，调用方（或下一个会话）应当继续查询同一个 taskId。
 * 本函数内部绝不会重新提交任务——重提会另建一个计费任务。
 */
export async function waitForVideo(input, opts) {
  const { config, store } = input
  const taskId = String(input.taskId || '').trim()
  if (!taskId) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'waitForVideo 缺少 taskId：只能等待已经提交过的任务，不允许在这里重新提交。',
    )
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  /**
   * 单次模式：只查一次、如果已完成就下载，**不轮询**。
   *
   * 为什么需要这个开关：`timeoutMs` 是「elapsed 预算」语义 —— 传 0 意味着"不等了"，
   * 循环会在第一次迭代就返回 timedOut，于是**那次查询根本不会发出、产物也不会下载**。
   * 工具层 `action="status"` 想要的恰恰是"查一次并顺手把已完成的产物拿下来"，
   * 用预算表达不了这个意图，所以单独给一个布尔开关。
   */
  const once = input.once === true

  const hint = (typeof input.prompt === 'string' && input.prompt.trim()) || taskId
  let last = { status: 'queued', outputUrls: [], raw: undefined, requestId: undefined }

  for (;;) {
    // 每轮先看预算，**包括第一轮**：`timeoutMs <= 0` 的语义就是「不等了」，
    // 此时再补一次查询毫无意义，还会白占一个请求超时。睡眠本身按剩余时间裁剪，
    // 所以正常情况下醒来时刚好到点，这里直接返回即可。
    // `once` 模式跳过这道闸门：它的语义是"只查一次"，与是否还有等待预算无关。
    if (!once && Date.now() >= deadline) {
      // 只带了「上次已知状态」的超时返回；调用方拿 taskId 稍后继续查询，绝不重提。
      return { ...last, taskId, videos: [], warnings: [], timedOut: true }
    }
    if (opts?.signal?.aborted) {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。')
    }

    // 查询失败（含取消）一律原样上抛：http.mjs 已把取消归一成 ABORTED，
    // 网络/鉴权错误也不该被这里吞掉后伪装成「还在渲染」。
    const result = await getVideoTask({ config, creds: input.creds, taskId }, opts)
    last = {
      status: result.status,
      outputUrls: result.outputUrls,
      raw: result.raw,
      requestId: result.requestId,
    }

    if (TERMINAL_FAILURE.has(result.status)) {
      // 终态失败才抛错；queued/running 落到下面继续等，绝不因为「还没好」就报失败。
      throw new ArkError(
        ARK_ERROR_CODES.HTTP,
        `视频任务 ${taskId} 生成失败（status=${result.status}）：`
          + `${describeFailure(normalizeTask(result.raw).failureReason)}`,
        { provider: 'ark', requestId: result.requestId },
      )
    }

    if (TERMINAL_SUCCESS.has(result.status)) {
      if (result.outputUrls.length === 0) {
        // 报成功却没有产物 URL：这属于上游契约违约，宁可报 BAD_RESPONSE 让用户去控制台看，
        // 也不能返回一个「成功但空空如也」的结果。
        throw new ArkError(
          ARK_ERROR_CODES.BAD_RESPONSE,
          `视频任务 ${taskId} 状态为 ${result.status}，但响应里没有 output_url/output_urls，无法下载产物。`,
          { provider: 'ark', requestId: result.requestId },
        )
      }
      // output_url 24h 失效 ⇒ 成功即下载，且必须在同一个调用里完成。
      const { videos, warnings } = await saveOutputs({
        input: { config, store },
        outputUrls: result.outputUrls,
        opts,
        hint,
      })
      return { ...last, taskId, videos, warnings, timedOut: false }
    }

    // 未知状态：既不能当成功，也不能当失败（可能是上游新增的中间态）。继续轮询到超时为止。
    // `once` 模式只查一次，未知状态就带着现状返回（timedOut=false，让它如实反映"还没好"）。
    if (once) {
      return { ...last, taskId, videos: [], warnings: [], timedOut: false }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { ...last, taskId, videos: [], warnings: [], timedOut: true }
    }
    await sleep(Math.min(pollIntervalMs, remaining), opts?.signal)
  }
}
