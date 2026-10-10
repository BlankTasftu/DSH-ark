/**
 * Seedream 图像生成客户端（Ark 数据面同步端点 `POST /images/generations`）。
 *
 * 为什么这个模块要单独存在：
 *  1. `size` 是本接口最容易踩的坑——方舟对总像素有下限（约 3,686,400 = 2560x1440），
 *     `1024x1024` 这类小尺寸会被 InvalidParameter 直接拒绝（见 docs/ARK-API-CONTRACT.md §1.1）。
 *     所以把「档位/宽高比 → 合法像素尺寸」收敛成一个**纯函数**，可以被单测穷举验证。
 *  2. 图片产物是 TOS 预签名直链，24h 失效（契约 §3.4）⇒ 拿到 URL 必须立刻下载落盘；
 *     上游也可能按 response_format 直接回 `b64_json`。两条路径都要走 ArtifactStore.save()，
 *     否则模型拿到一个过期 URL 等于没拿到产物。
 *  3. 图像是**计费**接口 ⇒ 重试策略必须保守：只有限流（429 / *RateLimit*）才退避重试，
 *     参数错误重试等于重复计费。这条策略由 lib/http.mjs 统一实现，这里只负责把
 *     config.ark.rateLimitRetries / rateLimitBackoffMs 传下去。
 *
 * 依赖注入契约见 docs/MODULE-INTERFACES.md：只通过参数拿 config / creds / store / fetchImpl，
 * 不 import 插件层、不读环境变量、不碰 ctx，因此可以全量注入 mock fetch 做单测。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { ARK_ERROR_CODES, ArkError, toArkError } from './errors.mjs'
import { DEFAULT_TIMEOUT_MS, requestBytes, requestJson } from './http.mjs'
import { probeImage } from './artifacts.mjs'

/**
 * 档位边长。档位语义是「总像素 ≈ 边长²」：
 * 1K → 1024² = 1,048,576；2K → 2048²；4K → 4096²（= 上限）。
 * 这与方舟 size="1K|2K|4K" 的口径一致，而不是「长边等于档位值」。
 */
export const SIZE_TIERS = Object.freeze({ '1K': 1024, '2K': 2048, '4K': 4096 })

/** 总像素下限：2560x1440 = 1920x1920 = 3,686,400（契约 §1.1 的实测口径）。 */
export const MIN_TOTAL_PIXELS = 3_686_400

/** 单边上限 4096，总像素上限即 4096x4096。 */
export const MAX_SIDE = 4096
export const MAX_TOTAL_PIXELS = MAX_SIDE * MAX_SIDE

/** 宽高比合法域 [1/16, 16]。 */
export const MIN_ASPECT_RATIO = 1 / 16
export const MAX_ASPECT_RATIO = 16

const DEFAULT_TIER = '2K'
const DEFAULT_ASPECT_RATIO = 1

/**
 * `size: 'auto'` 哨兵：请求体里**不带** size，画布交给服务端与 prompt 共同决定。
 * 为什么留这个逃生舱：实测结论是「图片任务硬填 1:1 常量会覆盖 prompt 里说清的画幅」——
 * 该结论来自 ark-cli v1.0.37 随包 Skills（`arkcli-gen/SKILL.md`），
 * 那份镜像已不再随仓库分发，此处保留结论以便核对。
 * 工具层想把比例判断权交给模型时可以用它。
 */
const AUTO_SIZE = 'auto'

/**
 * 本地参考图内联上限。契约只约束了「本地路径必须在 cwd 内」，没给体积上限；
 * 这里设 8MB 是因为内联素材要 base64 进 JSON 请求体（体积 ×4/3），超大文件会撑爆内存与请求体。
 */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
})

/** 显式尺寸："2560x1440"，容忍 4096 X 2304 这类写法与全角乘号。 */
const EXPLICIT_SIZE_RE = /^(\d+)\s*[x×*]\s*(\d+)$/i
/** 长得像尺寸（含分隔符）却解析失败时要明确报错，而不是当档位去猜。 */
const SIZE_SHAPE_RE = /[x×*]/i
const DATA_URL_RE = /^data:/i
const DATA_IMAGE_RE = /^data:image\//i
/** 绝对 URL（http/https/tos…）：原样透传给服务端抓取，我们不代抓，避免多一层 SSRF 面。 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

// --------------------------------------------------------------- 尺寸换算

/**
 * 档位/宽高比 → 合法像素尺寸。纯函数，不读全局。
 *
 * @param {{ size?: string, aspectRatio?: string|number }} [input]
 *   size: '1K' | '2K' | '4K' | '宽x高' | 'auto'（'auto' 由 generateImage 消费，这里不认）
 *   aspectRatio: '1:1' | '16:9' | '9:16' | '21:9' … 或直接给数字比值
 * @returns {{ size: string, width: number, height: number }}
 */
export function resolveSize({ size, aspectRatio } = {}) {
  const spec = parseSizeSpec(size)
  if (spec.kind === 'explicit') return validateExplicitSize(spec.width, spec.height)
  return fitTierToRatio(SIZE_TIERS[spec.tier], parseAspectRatio(aspectRatio))
}

function parseSizeSpec(size) {
  // 缺省 = 契约 §1.1 示例里的 2K；调用方完全没说尺寸时给一个确定值，比让服务端猜更好预测。
  if (size === undefined || size === null || (typeof size === 'string' && !size.trim())) {
    return { kind: 'tier', tier: DEFAULT_TIER }
  }
  if (typeof size !== 'string') throw invalidSize(size)
  const text = size.trim()

  const explicit = EXPLICIT_SIZE_RE.exec(text)
  if (explicit) return { kind: 'explicit', width: Number(explicit[1]), height: Number(explicit[2]) }
  // "2560x" / "axb" / "1x2x3" 这类既不是档位也不是合法尺寸，必须报错而不是当成档位。
  if (SIZE_SHAPE_RE.test(text)) throw invalidSize(size)

  const tier = text.toUpperCase()
  if (Object.prototype.hasOwnProperty.call(SIZE_TIERS, tier)) return { kind: 'tier', tier }
  throw invalidSize(size)
}

function invalidSize(size) {
  return new ArkError(
    ARK_ERROR_CODES.INVALID_PARAMETER,
    `无法识别的 size：${JSON.stringify(size)}。可用值：'1K' | '2K' | '4K' | 'auto' | '宽x高'（如 '2560x1440'）。`,
    { provider: 'ark' },
  )
}

/**
 * 显式 "宽x高" 是调用方的硬约束：只校验、不换算。
 * 为什么不在这里「帮忙」等比放大：用户点名 1024x1024 时，静默给一张 1920x1920 比直接报错更糟
 * （尺寸变化会直接影响构图与下游对齐）；报错信息里给出建议值，让调用方自己决定。
 */
function validateExplicitSize(width, height) {
  if (width < 1 || height < 1) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `非法尺寸 ${width}x${height}：宽高必须是 ≥1 的整数像素。`,
      { provider: 'ark' },
    )
  }

  const ratio = width / height
  let problem
  if (width > MAX_SIDE || height > MAX_SIDE) {
    problem = `单边不得超过 ${MAX_SIDE}`
  } else if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) {
    problem = `宽高比必须落在 [1/16, 16]（当前 ${ratio.toFixed(4)}）`
  } else if (width * height < MIN_TOTAL_PIXELS) {
    problem = `总像素不得低于 ${MIN_TOTAL_PIXELS}（当前 ${width * height}），建议从 1920x1920 或 2560x1440 起`
  } else if (width * height > MAX_TOTAL_PIXELS) {
    problem = `总像素不得超过 ${MAX_TOTAL_PIXELS}`
  }
  if (problem) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `非法尺寸 ${width}x${height}：${problem}。`,
      { provider: 'ark' },
    )
  }
  return { size: `${width}x${height}`, width, height }
}

function parseAspectRatio(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return DEFAULT_ASPECT_RATIO
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw invalidAspectRatio(value)
    assertAspectRatioInDomain(value, value)
    return value
  }
  if (typeof value !== 'string') throw invalidAspectRatio(value)

  const parts = value.trim().split(/[:/]/)
  if (parts.length !== 2) throw invalidAspectRatio(value)
  const numerator = Number(parts[0].trim())
  const denominator = Number(parts[1].trim())
  // Number('') === 0，所以 '16:' / ':9' 会在这里被挡掉。
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    throw invalidAspectRatio(value)
  }
  const ratio = numerator / denominator
  assertAspectRatioInDomain(ratio, value)
  return ratio
}

function assertAspectRatioInDomain(ratio, raw) {
  if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `宽高比 ${JSON.stringify(raw)} 超出合法域 [1/16, 16]。`,
      { provider: 'ark' },
    )
  }
}

function invalidAspectRatio(value) {
  return new ArkError(
    ARK_ERROR_CODES.INVALID_PARAMETER,
    `无法识别的 aspectRatio：${JSON.stringify(value)}。可用值形如 '1:1' | '16:9' | '9:16' | '4:3' | '21:9'。`,
    { provider: 'ark' },
  )
}

/**
 * 档位 + 宽高比 → 像素尺寸：先在总像素域内钳制，再受单边上限约束。
 *
 * 顺序很重要（契约 §1.1：低于下限等比放大、超上界等比缩小）：
 *  - 1K 的面积（1,048,576）低于下限 ⇒ 放大到 3,686,400，于是 1:1 → 1920x1920、16:9 → 2560x1440，
 *    正好是实测可用的最小尺寸；
 *  - 4K 在 1:1 时刚好等于上限 4096x4096；16:9 时总像素虽在上限内，但长边会到 5461 ⇒ 必须等比缩到 4096x2304。
 */
function fitTierToRatio(edge, ratio) {
  let total = edge * edge
  if (total < MIN_TOTAL_PIXELS) total = MIN_TOTAL_PIXELS
  else if (total > MAX_TOTAL_PIXELS) total = MAX_TOTAL_PIXELS

  let width = Math.sqrt(total * ratio)
  let height = Math.sqrt(total / ratio)

  // 单边上限是硬约束（超了必被 400 拒绝）。
  // 注意：极端宽高比（如 1:16）下「总像素下限」与「单边上限 4096」在数学上不可兼得——
  // 此时以单边上限为准，面积会落在下限之下，这是该域内唯一不被直接拒掉的可行解。
  const longest = Math.max(width, height)
  if (longest > MAX_SIDE) {
    const k = MAX_SIDE / longest
    width *= k
    height *= k
  }

  // 取整方向：面积下限是服务端的硬校验，四舍五入可能恰好掉到下限之下（如 2955.6 x 1247.1），
  // 所以一旦取整后面积不达标就改用向上取整——宁可多几个像素，也不能让请求被 InvalidParameter 拒掉。
  let w = Math.round(width)
  let h = Math.round(height)
  if (w * h < MIN_TOTAL_PIXELS) {
    w = Math.ceil(width)
    h = Math.ceil(height)
  }
  return { size: `${w}x${h}`, width: w, height: h }
}

// ----------------------------------------------------------------- 生成

/**
 * 文本生图 / 参考图生图 / 指令编辑。
 *
 * @param {object} input
 * @param {object} input.config resolveConfig() 的产物
 * @param {{ require: (ref: string, hint?: string) => Promise<string> }} input.creds
 * @param {import('./artifacts.mjs').ArtifactStore} input.store
 * @param {string} input.prompt
 * @param {string} [input.model]
 * @param {string} [input.size] '1K' | '2K' | '4K' | '宽x高' | 'auto'
 * @param {string} [input.aspectRatio]
 * @param {string[]} [input.referenceImages] 本地路径（限 cwd 内）/ http(s) URL / data URL
 * @param {number} [input.count] >1 ⇒ sequential_image_generation=auto + max_images
 * @param {number} [input.guidanceScale]
 * @param {boolean} [input.watermark]
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ images: object[], model: string, size: string, requestId?: string, usage?: unknown }>}
 */
export async function generateImage(input, opts = {}) {
  const {
    config,
    creds,
    store,
    prompt,
    model,
    size,
    aspectRatio,
    referenceImages,
    count,
    guidanceScale,
    watermark,
  } = input || {}
  const { signal, fetchImpl } = opts || {}

  const ark = config && config.ark
  if (!ark || typeof ark.baseUrl !== 'string') {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'generateImage 需要 config.ark（由 lib/config.mjs 的 resolveConfig 产出）。',
      { provider: 'ark' },
    )
  }
  if (!creds || typeof creds.require !== 'function') {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'generateImage 需要 creds（由 lib/config.mjs 的 createCredentialResolver 产出）。',
      { provider: 'ark' },
    )
  }
  if (!store || typeof store.save !== 'function') {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      'generateImage 需要 store（lib/artifacts.mjs 的 ArtifactStore）：产物必须落盘，不能只回传 24h 直链。',
      { provider: 'ark' },
    )
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, 'prompt 不能为空。', { provider: 'ark' })
  }

  const imageCount = count === undefined || count === null ? 1 : count
  if (!Number.isInteger(imageCount) || imageCount < 1) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `count 必须是 ≥1 的整数（收到 ${JSON.stringify(count)}）。`,
      { provider: 'ark' },
    )
  }
  if (guidanceScale !== undefined && guidanceScale !== null && !Number.isFinite(guidanceScale)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `guidanceScale 必须是数字（收到 ${JSON.stringify(guidanceScale)}）。`,
      { provider: 'ark' },
    )
  }
  if (referenceImages !== undefined && referenceImages !== null && !Array.isArray(referenceImages)) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, 'referenceImages 必须是数组。', { provider: 'ark' })
  }

  const wantsAutoSize = typeof size === 'string' && size.trim().toLowerCase() === AUTO_SIZE
  // 'auto' 的语义只是「不锁像素总量」；调用方另外给了宽高比时，比例仍要落成具体尺寸，
  // 否则等于静默丢掉一个显式参数（比例一变，构图就全变了）。
  const autoSize = wantsAutoSize && !hasValue(aspectRatio)
  const resolvedSize = autoSize
    ? undefined
    : resolveSize({ size: wantsAutoSize ? undefined : size, aspectRatio })

  // 先要凭据：密钥缺失是最常见的前置失败，不该先做一堆 IO 再报错。
  const credential = await creds.require(ark.credential)

  // 参考图在发请求前全部解析完：参数错误（逃逸、不存在、超大）必须在计费请求之前失败。
  const root = await realWorkspaceRoot(store.cwd)
  const references = await Promise.all((referenceImages || []).map((ref) => toReferenceUrl(ref, root)))

  const body = {
    model: model || ark.imageModel,
    prompt,
    // 默认要 url：拿到直链我们自己下载落盘；上游若按其它格式回 b64_json，下面的保存分支同样接得住。
    response_format: 'url',
    // 显式关闭水印：产物是交付给用户的素材，需要水印时由调用方显式打开（默认值不确定就别依赖服务端默认）。
    watermark: watermark === true,
  }
  if (resolvedSize) body.size = resolvedSize.size
  // 组图：契约规定 count>1 走 sequential auto + max_images（图像接口没有 n 参数）。
  if (imageCount > 1) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: imageCount }
  }
  if (guidanceScale !== undefined && guidanceScale !== null) body.guidance_scale = guidanceScale
  if (references.length) body.image = references

  const { json, requestId } = await requestJson({
    url: `${ark.baseUrl.replace(/\/+$/, '')}/images/generations`,
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}` },
    body,
    signal,
    timeoutMs: ark.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 只把限流退避的额度交给 http 层；参数错误等非限流错误 http 层不会重试。
    retries: ark.rateLimitRetries ?? 0,
    retryBackoffMs: ark.rateLimitBackoffMs ?? 25_000,
    provider: 'ark',
    fetchImpl,
  })

  const items = json && Array.isArray(json.data) ? json.data : []
  if (!items.length) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      `图像接口没有返回任何图片（响应：${previewJson(json)}）。`,
      { provider: 'ark', httpStatus: 200, requestId },
    )
  }

  const images = []
  // 串行保存：组图有先后语义，串行才能保证返回顺序与上游 data 顺序一致；也避免并发打满 CDN。
  for (const item of items) {
    images.push(await saveImageItem({ item, store, hint: prompt, ark, signal, fetchImpl, requestId }))
  }

  return {
    images,
    model: body.model,
    size: resolvedSize ? resolvedSize.size : AUTO_SIZE,
    requestId,
    usage: json ? json.usage : undefined,
  }
}

/** 把一个返回项（url 或 b64_json）落盘。两条产物路径都必须过 ArtifactStore.save()。 */
async function saveImageItem({ item, store, hint, ark, signal, fetchImpl, requestId }) {
  const url = item && typeof item.url === 'string' && item.url.trim() ? item.url.trim() : undefined
  const b64 = item && typeof item.b64_json === 'string' && item.b64_json.trim() ? item.b64_json : undefined
  if (!url && !b64) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      '上游结果项既没有 url 也没有 b64_json，无法落盘。',
      { provider: 'ark', requestId },
    )
  }

  let bytes
  let contentType
  if (b64) {
    bytes = Buffer.from(b64, 'base64')
  } else {
    // 直链 24h 失效（契约 §3.4）：拿到就下载，绝不把 URL 当成交付物返回。
    const got = await requestBytes({
      url,
      signal,
      timeoutMs: ark.downloadTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl,
    })
    bytes = got.bytes
    contentType = got.contentType
  }

  if (!bytes || bytes.byteLength === 0) {
    throw new ArkError(
      ARK_ERROR_CODES.BAD_RESPONSE,
      '图片产物为空（0 字节），疑似上游或 CDN 截断。',
      { provider: 'ark', requestId },
    )
  }

  // 魔数优先于 content-type：CDN 常把图片标成 application/octet-stream，
  // 由 probeImage 定 MIME 才能给文件正确扩展名，预览路由也才认得出来。
  const mime = probeImage(bytes).mime || normalizeMime(contentType)
  return store.save({ bytes, hint, mime })
}

function normalizeMime(contentType) {
  if (typeof contentType !== 'string') return undefined
  const value = contentType.split(';')[0].trim().toLowerCase()
  return value || undefined
}

/** 判断一个可选参数字段是否真的被调用方提供（'' 与 null/undefined 都视为未提供）。 */
function hasValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function previewJson(json) {
  try {
    const text = JSON.stringify(json)
    return text === undefined ? String(json) : text.slice(0, 300)
  } catch {
    return String(json)
  }
}

// ------------------------------------------------------------- 参考图解析

/**
 * 把一条参考图引用变成请求体 `image[]` 里的元素。
 *  - http(s)/tos 等绝对 URL：原样透传（由服务端抓取，我们不代抓，少一层 SSRF 面）；
 *  - data URL：只接受 `data:image/...`；
 *  - 其它：当本地路径处理，必须位于工作区（cwd）内，读成 data URL 内联。
 */
async function toReferenceUrl(ref, root) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, '参考图引用必须是非空字符串。', { provider: 'ark' })
  }
  const value = ref.trim()

  if (DATA_URL_RE.test(value)) {
    if (!DATA_IMAGE_RE.test(value)) {
      throw new ArkError(
        ARK_ERROR_CODES.INVALID_PARAMETER,
        `参考图 data URL 必须是 data:image/... 形式（收到 ${value.slice(0, 32)}…）。`,
        { provider: 'ark' },
      )
    }
    return value
  }
  if (ABSOLUTE_URL_RE.test(value)) return value

  // 本地路径：realpath 同时解决「文件不存在」和「符号链接指向工作区外」两种逃逸。
  const abs = path.resolve(root, value)
  let real
  try {
    real = await fs.realpath(abs)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ArkError(
        ARK_ERROR_CODES.INVALID_PARAMETER,
        `本地参考图不存在：${value}（解析为 ${abs}）。`,
        { provider: 'ark', cause: err },
      )
    }
    throw toArkError(err, ARK_ERROR_CODES.FILE, { provider: 'ark' })
  }

  // 逃逸检查放在 realpath 之后：先归一真实路径，才能挡住 `..` 与符号链接两种绕过方式。
  if (!isInside(root, real)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `本地参考图必须位于工作区 ${root} 内（收到 ${value}），拒绝路径逃逸。`,
      { provider: 'ark' },
    )
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) {
    throw new ArkError(ARK_ERROR_CODES.INVALID_PARAMETER, `本地参考图不是文件：${value}。`, { provider: 'ark' })
  }
  if (stat.size > MAX_REFERENCE_BYTES) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `本地参考图 ${value} 为 ${stat.size} 字节，超过内联上限 ${MAX_REFERENCE_BYTES} 字节；`
        + '请改用可公网访问的 https URL，避免 base64 撑爆请求体。',
      { provider: 'ark' },
    )
  }

  const bytes = await fs.readFile(real)
  const mime = probeImage(bytes).mime
    || MIME_BY_EXT[path.extname(real).slice(1).toLowerCase()]
    || 'application/octet-stream'
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 判断 target 是否真的在 root 之内（逐段比较，避免 "..foo" 这类同名前缀的误判）。 */
function isInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel.split(path.sep)[0] !== '..'
}

/**
 * 工作区根目录的真实路径。
 * 为什么要 realpath：Windows 上工作区/临时目录常通过 junction 或符号链接访问，
 * 不把 root 归一就会出现「明明在 cwd 内却被判成逃逸」的误伤。
 */
async function realWorkspaceRoot(cwd) {
  const base = path.resolve(cwd || process.cwd())
  try {
    return await fs.realpath(base)
  } catch {
    return base
  }
}
