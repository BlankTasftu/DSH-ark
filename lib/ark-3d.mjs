/**
 * Seed3D 图生 3D（`doubao-seed3d-2-0-260328`）。
 *
 * 与视频生成**共用同一个任务式端点**，只靠 `model` 区分 —— 这是实测结论，不是文档抄的：
 *
 *   POST /api/v3/contents/generations/tasks
 *   { "model": "doubao-seed3d-2-0-260328",
 *     "content": [{ "type": "image_url", "image_url": { "url": "<url 或 data URI>" } }] }
 *   → 200 { "id": "cgt-…", "status": "running" }
 *
 * 查询：`GET /api/v3/contents/generations/tasks/{id}`，终态 `succeeded`。
 *
 * ## 实测踩坑点（务必读）
 *
 * 1. **图片可以内联为 base64 data URI** —— 实测 555K 字符的 data URI 直接被接受，
 *    不需要先把图传到公网。省一步，也不用引入对象存储依赖。
 *
 * 2. **响应声明 `fileformat: "glb"`，但 `file_url` 给的是 `.zip`。**
 *    两者不一致！zip 内部才是 `pbr/mesh_textured_pbr.glb`（deflate 压缩）。
 *    所以：
 *      · 只按 `fileformat` 把 zip 改名成 .glb → **交付的文件是坏的**
 *      · 只按 URL 扩展名交付 .zip → 用户拿到压缩包，不是模型
 *    正确做法是**解包并校验 GLB 魔数**后再落盘（见 extractModelFromArchive）。
 *
 * 3. 耗时较长（实测约 7.5 分钟，30k tokens 计费），必须走轮询而不是单次查询。
 *
 * 4. 本次实测**只验证了 glb**。其它 `file_format`（obj/usdz 等）的响应形态未验证，
 *    所以这里对未知容器采取"如实报错"而不是猜着解 —— 猜错会交付坏文件。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'
import { requestBytes, requestJson } from './http.mjs'
import { resolveMediaReference } from './ark-video.mjs'
import { probeModelFile } from './artifacts.mjs'

/** 默认模型（实测该账号可直接提交）。 */
export const DEFAULT_3D_MODEL = 'doubao-seed3d-2-0-260328'

/** 3D 任务的默认轮询参数：比视频更慢，所以给更长的总预算。 */
const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000

/** 认得的模型扩展名，按优先级（多文件时取第一个命中的）。 */
const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'fbx', 'usdz', 'stl', 'ply']

/** 扩展名 → MIME（3D 相关）。 */
export const MIME_BY_MODEL_EXT = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  fbx: 'application/octet-stream',
  usdz: 'model/vnd.usdz+zip',
  stl: 'model/stl',
  ply: 'model/ply',
}

/**
 * 解析 ZIP，列出中央目录里的条目。**手工解析，不引第三方库**
 * （本项目零运行时依赖，且只需读 `zip` 这一种容器）。
 *
 * 支持 stored(0) 与 deflate(8) 两种压缩方式 —— 实测 Seed3D 用 deflate。
 * ZIP64 不支持：3D 产物在几十 MB 量级，远达不到 4GB 阈值，真遇到会明确报错而不是猜。
 *
 * @param {Buffer} buf
 * @returns {Array<{ name: string, method: number, compSize: number, uncompSize: number, dataStart: number }>}
 */
export function parseZipEntries(buf) {
  // 从尾部回扫 EOCD 签名 0x06054b50（注释最长 65535，所以只回扫这么多）
  let eocd = -1
  const minStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, '产物不是有效的 ZIP：找不到中央目录结束记录（EOCD）。')
  }

  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  if (off === 0xffffffff || total === 0xffff) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      '产物疑似 ZIP64（3D 产物不该这么大）—— 本实现未支持，请人工核对。',
    )
  }
  if (off + 46 > buf.length) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, '产物 ZIP 中央目录偏移越界，文件可能被截断。')
  }

  const entries = []
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const uncompSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')

    // 局部头：30 字节固定 + nameLen + extraLen（extraLen 以局部头为准，可能不同于中央目录）
    let dataStart = -1
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const s = localOff + 30 + lNameLen + lExtraLen
      if (s + compSize <= buf.length) dataStart = s
    }
    entries.push({ name, method, compSize, uncompSize, dataStart })
    off += 46 + nameLen + extraLen + commentLen
  }

  if (entries.length === 0) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, '产物 ZIP 里没有任何条目。')
  }
  return entries
}

/**
 * 从 ZIP 里取出模型文件（优先第一个认得的扩展名，跳过目录项）。
 * @param {Buffer} buf
 * @returns {{ name: string, bytes: Buffer }}
 */
export function extractModelFromZip(buf) {
  const entries = parseZipEntries(buf).filter((e) => !e.name.endsWith('/') && e.dataStart >= 0)

  const pick =
    MODEL_EXTENSIONS.map((ext) => entries.find((e) => e.name.toLowerCase().endsWith(`.${ext}`))).find(Boolean) ||
    null
  if (!pick) {
    const names = entries.map((e) => e.name).slice(0, 8).join(', ')
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `产物 ZIP 里没有可识别的 3D 模型文件（认得的扩展名：${MODEL_EXTENSIONS.join('/')}）。`
        + `实际条目：${names || '(空)'}`,
    )
  }
  if (![...MODEL_EXTENSIONS].some((ext) => pick.name.toLowerCase().endsWith(`.${ext}`))) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, `产物条目 ${pick.name} 不是可识别的 3D 格式。`)
  }

  const raw = buf.subarray(pick.dataStart, pick.dataStart + pick.compSize)
  let bytes
  if (pick.method === 0) {
    bytes = Buffer.from(raw)
  } else if (pick.method === 8) {
    try {
      bytes = inflateRawSync(raw)
    } catch (err) {
      throw new ArkError(
        ARK_ERROR_CODES.BAD_RESPONSE,
        `解压 ${pick.name} 失败（deflate 数据损坏）：${err.message}`,
        { cause: err },
      )
    }
  } else {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `产物条目 ${pick.name} 使用了不支持的压缩方式 method=${pick.method}（仅支持 0=stored / 8=deflate）。`,
    )
  }

  if (bytes.length === 0) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, `解出的模型 ${pick.name} 是空文件。`)
  }
  // 大小一致性校验：不一致说明解析错了，宁可报错也不要交付不可信的文件
  if (pick.uncompSize > 0 && pick.uncompSize !== bytes.length) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `解出的模型大小与 ZIP 记录不符（记录 ${pick.uncompSize}，实际 ${bytes.length} 字节）—— 产物可能损坏。`,
    )
  }
  return { name: path.basename(pick.name), bytes }
}

/**
 * 把上游产物归一成"真正的模型字节"。
 *
 * 上游有两种可能：直接给模型文件，或给一个 zip（**实测 Seed3D 走的是 zip**）。
 * 按**内容**判断而不是按 URL 扩展名 —— 因为实测二者不一致（声明 glb、实则 zip）。
 *
 * @param {Buffer} buf
 * @param {string} url 仅用于报错信息
 * @returns {{ bytes: Buffer, ext: string, fromArchive: boolean, entryName?: string }}
 */
export function unwrapModelPayload(buf, url = '') {
  // ZIP：魔数 PK\x03\x04
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const { name, bytes } = extractModelFromZip(buf)
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase()
    const probed = probeModelFile(bytes)
    if (probed.format) {
      return { bytes, ext: probed.ext, fromArchive: true, entryName: name }
    }
    return { bytes, ext: ext || 'bin', fromArchive: true, entryName: name }
  }

  // 非 ZIP：当作模型本身，用魔数判定真实格式
  const probed = probeModelFile(buf)
  if (!probed.format) {
    const head = buf.subarray(0, 8).toString('hex')
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `产物既不是 ZIP 也不是可识别的 3D 模型（头 8 字节 ${head}）。${url ? `来源 ${url.slice(0, 120)}` : ''}`,
    )
  }
  return { bytes: buf, ext: probed.ext, fromArchive: false }
}

/** 收集产物 URL：实测形态是 `content.file_url`；同时兼容若干别名以便上游微调。 */
export function pickModelUrls(raw) {
  const urls = []
  const push = (v) => {
    if (typeof v === 'string' && v) urls.push(v)
  }
  push(raw?.content?.file_url)
  push(raw?.content?.url)
  push(raw?.file_url)
  push(raw?.output_url)
  if (Array.isArray(raw?.output_urls)) raw.output_urls.forEach(push)
  if (Array.isArray(raw?.content)) {
    for (const c of raw.content) {
      push(c?.file_url)
      push(c?.url)
    }
  }
  return [...new Set(urls)]
}

/** 归一化任务状态（与视频一致：兼容字符串与 {phase} 两种形态）。 */
export function normalize3dTask(raw) {
  const rawStatus = raw?.status
  const status =
    rawStatus && typeof rawStatus === 'object'
      ? String(rawStatus.phase || rawStatus.status || '')
      : String(rawStatus || '')
  return {
    taskId: String(raw?.id || raw?.task_id || ''),
    status,
    modelUrls: pickModelUrls(raw),
    failureReason:
      raw?.failure_reason ||
      raw?.error?.message ||
      raw?.error ||
      (rawStatus && typeof rawStatus === 'object' ? rawStatus.message : undefined) ||
      undefined,
  }
}

/**
 * 组装请求体。纯函数，便于单测。
 *
 * @param {{ image: string, model?: string, subdivisionLevel?: string, fileFormat?: string }} input
 */
export function build3dRequestBody(input) {
  const image = String(input.image ?? '').trim()
  if (!image) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, '缺少 image：图生 3D 需要一张参考图。')
  }
  const body = {
    model: String(input.model || DEFAULT_3D_MODEL).trim(),
    content: [{ type: 'image_url', image_url: { url: image } }],
  }
  // 下面两个是实测响应里回显的字段名（subdivisionlevel / fileformat）。
  // 请求侧我只传用户显式给的值 —— 不确定的字段不主动填，让服务端用默认。
  if (input.subdivisionLevel) body.subdivisionlevel = String(input.subdivisionLevel)
  if (input.fileFormat) body.fileformat = String(input.fileFormat)
  return body
}

/**
 * 把本地图片读成 data URI（实测该形态被上游接受）。
 *
 * ⚠️ 走 `resolveMediaReference` 而不是自己 readFile —— 那个函数里含着两层路径安全判定
 * （词法 + realpath，挡工作区内 junction 逃逸）与内联大小上限。自己实现一份就会多一个
 * 可能漏掉校验的入口，而"工作区外的文件被读进请求体"是一条真实的数据外泄通道。
 * 本项目已经因为"同一条判定内联四处、漏了一处"踩过落盘越界的坑，这里不再重犯。
 */
export async function resolveInputImage(ref, cwd) {
  return resolveMediaReference({ ref, cwd, label: '输入图片', kind: 'image' })
}

/** 提交 3D 生成任务。**这是一次计费动作**：只发一次 POST，调用方必须持久化 taskId。 */
export async function create3dTask(input, opts = {}) {
  const { config, creds } = input
  const apiKey = await creds.require(config.ark.credential, '3D 生成需要方舟 API Key。')

  // 图片引用统一在这里解析成 url/data URL，再进请求体。
  const image = await resolveInputImage(input.image, input.cwd || process.cwd())

  const body = build3dRequestBody({
    image,
    // 模型优先级：调用参数 > 配置 > 内置默认。三处都在，且 config.model3d 真的会被用到
    // （声明了配置项却不读，是那种"改了配置没反应"的隐性 BUG）。
    model: input.model || config?.ark?.model3d || DEFAULT_3D_MODEL,
    subdivisionLevel: input.subdivisionLevel,
    fileFormat: input.fileFormat,
  })

  const { json, requestId } = await requestJson({
    url: `${String(config.ark.baseUrl).replace(/\/+$/, '')}/contents/generations/tasks`,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: opts.signal,
    timeoutMs: config.ark.requestTimeoutMs,
    // 仅限流退避重试（此时上游未建任务，不会重复计费）；参数错误绝不重试
    retries: config.ark.rateLimitRetries,
    retryBackoffMs: config.ark.rateLimitBackoffMs,
    provider: 'ark',
    fetchImpl: opts.fetchImpl,
  })

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ArkError(ARK_ERROR_CODES.BAD_RESPONSE, `提交 3D 任务返回了非任务对象：${JSON.stringify(json)?.slice(0, 200)}`, {
      provider: 'ark',
      requestId,
    })
  }
  const normalized = normalize3dTask(json)
  if (!normalized.taskId) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      '上游接受了 3D 任务但没有返回任务 id，无法后续查询；请凭 request_id 到控制台核对，**不要重复提交**。',
      { provider: 'ark', requestId },
    )
  }
  return { ...normalized, requestId, raw: json }
}

/** 查询一次 3D 任务。 */
export async function get3dTask(input, opts = {}) {
  const { config, creds, taskId } = input
  if (!taskId) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, 'taskId 必填：查询 3D 任务必须带任务 id。')
  }
  const apiKey = await creds.require(config.ark.credential, '查询 3D 任务需要方舟 API Key。')
  const { json, requestId } = await requestJson({
    url: `${String(config.ark.baseUrl).replace(/\/+$/, '')}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 30_000,
    provider: 'ark',
    fetchImpl: opts.fetchImpl,
  })
  return { ...normalize3dTask(json), requestId, raw: json }
}

/** 下载 3D 产物并落盘（解包 + 魔数校验后再交付）。下载失败不上抛 —— taskId 不能丢。 */
export async function save3dModel({ input, modelUrls, opts = {}, hint }) {
  const { config, store } = input
  const models = []
  const warnings = []

  for (const url of modelUrls) {
    try {
      const got = await requestBytes({
        url,
        signal: opts.signal,
        timeoutMs: config.ark.downloadTimeoutMs,
        fetchImpl: opts.fetchImpl,
      })
      const unwrapped = unwrapModelPayload(got.bytes, url)
      const saved = await store.save({
        bytes: unwrapped.bytes,
        hint,
        ext: unwrapped.ext,
        mime: MIME_BY_MODEL_EXT[unwrapped.ext],
      })
      models.push({
        ...saved,
        fromArchive: unwrapped.fromArchive,
        entryName: unwrapped.entryName,
        archiveBytes: unwrapped.fromArchive ? got.bytes.length : undefined,
      })
    } catch (err) {
      warnings.push(`产物下载或解析失败：${err?.message || err}`)
    }
  }
  return { models, warnings }
}

/**
 * 提交并等待 3D 生成完成。
 *
 * `once: true` 时只查一次（用于 status 语义，绝不重新提交）。
 */
export async function waitFor3d(input, opts = {}) {
  const { config, taskId } = input
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const once = opts.once === true
  const started = Date.now()

  let last = { status: 'unknown', modelUrls: [], raw: undefined, requestId: undefined }

  for (;;) {
    if (opts.signal?.aborted) {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '3D 生成等待已被取消。')
    }
    last = await get3dTask({ config, creds: input.creds, taskId }, opts)
    const status = last.status
    const terminalSuccess = status === 'succeeded' || status === 'success'
    const terminalFailure = ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)

    if (terminalSuccess || terminalFailure || once) {
      const done = terminalSuccess || terminalFailure
      if (!done) {
        // 非终态 + once：不下载，交给调用方继续查
        return { ...last, taskId, timedOut: false, models: [], warnings: [] }
      }
      if (terminalFailure) {
        return { ...last, taskId, timedOut: false, models: [], warnings: [] }
      }
      const hint = String(input.prompt || input.hint || 'model')
      const { models, warnings } = await save3dModel({
        input: { config, store: input.store },
        modelUrls: last.modelUrls,
        opts,
        hint,
      })
      return { ...last, taskId, timedOut: false, models, warnings }
    }

    if (Date.now() - started > timeoutMs) {
      return { ...last, taskId, timedOut: true, models: [], warnings: [] }
    }
    await sleep(pollIntervalMs, opts.signal)
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ArkError(ARK_ERROR_CODES.ABORTED, '等待已被取消。', { cause: signal.reason }))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
