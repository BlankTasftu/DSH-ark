/**
 * 统一错误模型。
 *
 * 所有对外抛出的错误都是 ArkError：带稳定 code（供模型与上层路由判断）、可选
 * httpStatus、可选 requestId（方舟返回的 x-request-id，排障关键）、可选 retryable。
 *
 * 设计要点：
 *  - code 是**稳定字符串**，不把上游文案拼进 code，避免文案变化影响判断。
 *  - message 面向模型可读，必须包含足够定位信息（状态码 + 上游 message + request_id）。
 *  - 凭据缺失是 MISSING_CREDENTIAL（不是 401），因为这是本地配置问题而非鉴权失败。
 */

export const ARK_ERROR_CODES = Object.freeze({
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  AUTHENTICATION: 'AUTHENTICATION',
  PERMISSION: 'PERMISSION',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  MODEL_NOT_AVAILABLE: 'MODEL_NOT_AVAILABLE',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  HTTP: 'HTTP',
  BAD_RESPONSE: 'BAD_RESPONSE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  ABORTED: 'ABORTED',
  FILE: 'FILE',
})

/**
 * 把一个 URL 压成**可安全写进模型可见文本**的形式：保留 host + path，丢掉 query。
 *
 * ## 为什么必须丢 query（安全审计 F9）
 *
 * 上游返回的产物直链是 **TOS 预签名 URL** —— query 里带着签名，
 * **24 小时内谁拿到都能直接取走产物**。而"产物下载失败（<url>）"这类警告会进
 * `warnings` → 工具返回值 → 模型上下文 → 会话记录，而会话记录是可导出、可分享的。
 * 等于把产物的临时凭据写进日志。
 *
 * 排障只需要知道"哪个 host、哪条路径失败了"，query 没有诊断价值。
 *
 * @param {unknown} url - 原始 URL（可能带签名）
 * @returns {string} `https://host/path?<签名已省略>`；解析失败时返回占位符
 */
export function safeUrlForDisplay(url) {
  const raw = String(url ?? '')
  if (!raw) return '<空地址>'
  try {
    const u = new URL(raw)
    const path = u.pathname.length > 80 ? `${u.pathname.slice(0, 80)}…` : u.pathname
    return `${u.origin}${path}${u.search ? '?<签名已省略>' : ''}`
  } catch {
    // 不是合法 URL：不要把原文带出去（可能就是一段被误当 URL 的敏感串）。
    return '<地址不可解析>'
  }
}

/**
 * 把文本里可能出现的**凭据值**擦掉。
 *
 * ## 为什么必须有，而且必须放在这里
 *
 * 这是一个**真实发生过的泄露路径**（安全审计 F1，实测复现）：底层 fetch 抛出的
 * 异常消息里可能**逐字包含请求头的值**。例如凭据里混进一个 `\r`（Windows 剪贴板
 * 或脚本里 `"…\r\n"` 很容易带进来）时，undici 会抛：
 *
 * ```
 * Headers.append: "Bearer <完整密钥>\r\nX-Injected: 1" is an invalid header value.
 * ```
 *
 * 这条消息经 `ArkError.message` → `toSummary()` → `guard()` 成为**工具返回值**，
 * 于是整把密钥进入模型上下文与会话记录（会话记录可被导出/分享）。
 *
 * 单靠"清洗凭据"挡不住所有同类情形（未来可能出现别的把 header 值带进消息的路径），
 * 所以这里再加一层**与具体来源无关**的兜底：任何经过 `toSummary()` 的文本都会
 * 被擦一遍。`toSummary()` 是所有面向模型的错误文本的唯一出口，放在这里覆盖面最大。
 *
 * 擦除规则刻意保守（宁可多擦）：认证头模式、`Bearer`/`X-Api-Key` 后面的值、
 * 以及长的高熵串。不追求"精确识别密钥"，只要求"不可能原样带出去"。
 *
 * @param {unknown} text - 任意文本
 * @returns {string} 擦除后的文本
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  // ① 认证头：`Authorization: Bearer xxx` / `X-Api-Key: xxx` / `Api-Key: xxx`
  //
  //    ⚠️ 必须把「方案 + 值」**整体**当值擦掉。第一版写成
  //    `(name)(sep)(值)` 并让值匹配 `[^\s",;]{4,}`，于是
  //    `Authorization: Bearer <密钥>` 里值只匹配到 `Bearer` 一个词，
  //    密钥**原样留在后面** —— 还带着"已脱敏"标记，比不擦更能骗人。
  //    所以值部分要允许可选的方案前缀。
  out = out.replace(
    /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token)\b(\s*[:=]\s*)("?)((?:bearer|basic)\s+)?([^\s",;]{4,})\3/gi,
    (_m, name, sep) => `${name}${sep}<已脱敏>`,
  )
  // ② 裸的 Bearer / Basic 之后的凭证 —— 这条覆盖 F1 实测的形状
  //    （`Headers.append: "Bearer <完整密钥>…"`，消息里只有 `Bearer` 没有头名）。
  out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{6,}/gi, (_m, scheme) => `${scheme} <已脱敏>`)
  // ③ 高熵长串兜底 —— **刻意收得很紧**。
  //
  //    第一版写成"连续 24 位以上字母数字"就擦，结果把模型 ID
  //    `doubao-seedream-5-0-pro-260628`（31 位）也擦成了 `<已脱敏>`，
  //    排障信息被毁。这是本项目"宁可多擦"与"别把有用信息擦掉"之间的取舍点：
  //    ①② 已经覆盖了真实泄露路径，③ 只是纵深防御，**不该误伤标识符**。
  //
  //    所以要求同时满足：无连字符（标识符几乎都有）、长度 ≥ 32、且大小写字母
  //    与数字**三类齐全**（随机密钥的典型特征）。火山密钥（`ark-` 前缀 + 长串）
  //    命中；模型 ID、request_id（纯 hex）、URL 片段都不会被误擦。
  out = out.replace(/\b(?![A-Za-z0-9]*[-_])[A-Za-z0-9]{32,}\b/g, (token) => {
    const hasLower = /[a-z]/.test(token)
    const hasUpper = /[A-Z]/.test(token)
    const hasDigit = /[0-9]/.test(token)
    return hasLower && hasUpper && hasDigit ? '<已脱敏>' : token
  })
  return out
}

export class ArkError extends Error {
  /**
   * @param {string} code 稳定错误码（ARK_ERROR_CODES 之一）
   * @param {string} message 面向模型的可读信息
   * @param {object} [info]
   * @param {number} [info.httpStatus]
   * @param {string} [info.requestId]
   * @param {boolean} [info.retryable]
   * @param {unknown} [info.cause]
   * @param {string} [info.provider] 'ark' | 'speech'
   */
  constructor(code, message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.name = 'ArkError'
    this.code = code
    this.httpStatus = info.httpStatus
    this.requestId = info.requestId
    this.retryable = info.retryable === true
    this.provider = info.provider
  }

  /**
   * 供工具层直接展示的一行摘要。
   *
   * ⚠️ 这里对 message 做一次 `redactSecrets()` **兜底脱敏**，不是可选项：
   * 底层库抛出的异常消息可能逐字包含请求头的值（= 完整密钥），而本方法是所有
   * 面向模型的错误文本的**唯一出口**。详见 `redactSecrets` 的注释与安全审计 F1。
   */
  toSummary() {
    const bits = [this.code]
    if (this.httpStatus !== undefined) bits.push(`HTTP ${this.httpStatus}`)
    if (this.requestId) bits.push(`request_id=${this.requestId}`)
    return `${bits.join(' · ')} — ${redactSecrets(this.message)}`
  }

  /**
   * 序列化白名单 —— **必须存在，且绝不能加 `cause`**。
   *
   * 背景：`cause` 里挂的是原始底层错误（fetch/undici 抛出的对象）。当前代码从不序列化
   * 整个 error（全仓无 logger、工具层只输出 `toSummary()` 字符串），所以今天没有泄露路径。
   * 但 `cause` 是**不可枚举**属性，一旦有人写出 `JSON.stringify(err)`、或把 `.cause` 交给
   * 某个序列化 logger，底层错误对象就可能被整体带出去。
   *
   * 加这个白名单是"结构性防御"：即便将来有人那样写，`JSON.stringify(err)` 也只会得到
   * 下面这几个安全字段，而不是把 cause 链一并展开。
   * 审计依据见 docs/AUDIT-INDEPENDENT.md §P3-2。
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
      retryable: this.retryable,
      provider: this.provider,
      message: this.message,
    }
  }
}

/** 把任意抛出物归一成 ArkError。 */
export function toArkError(err, fallbackCode = ARK_ERROR_CODES.HTTP, info = {}) {
  if (err instanceof ArkError) return err
  if (isAbortError(err)) {
    return new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { ...info, cause: err })
  }
  const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
  return new ArkError(fallbackCode, msg, { ...info, cause: err })
}

/** 判定是否为“调用方取消了”的异常（AbortSignal 触发）。 */
export function isAbortError(err) {
  if (!err) return false
  if (err.name === 'AbortError') return true
  // undici / Node fetch 在部分版本上抛 TimeoutError/TypeError，这里只认显式取消语义。
  return err.code === 'ABORT_ERR'
}

/**
 * 把 HTTP 状态码 + 上游错误体映射为稳定 code。
 * 上游错误体形如 { error: { code, message, type } } 或 { code, message }。
 */
export function classifyHttpStatus(status, upstreamCode) {
  const raw = String(upstreamCode || '').toLowerCase()
  if (raw.includes('ratelimit') || raw.includes('rate_limit') || raw.includes('ipm')) {
    return ARK_ERROR_CODES.RATE_LIMITED
  }
  if (raw.includes('contentrisk') || raw.includes('sensitive') || raw.includes('blocked')) {
    return ARK_ERROR_CODES.CONTENT_BLOCKED
  }
  if (raw.includes('modelnot') || raw.includes('model_not') || raw.includes('notfound')) {
    return ARK_ERROR_CODES.MODEL_NOT_AVAILABLE
  }
  if (raw.includes('invalidparameter') || raw.includes('invalid_parameter')) {
    return ARK_ERROR_CODES.INVALID_PARAMETER
  }
  if (status === 401) return ARK_ERROR_CODES.AUTHENTICATION
  if (status === 403) return ARK_ERROR_CODES.PERMISSION
  if (status === 404) return ARK_ERROR_CODES.MODEL_NOT_AVAILABLE
  if (status === 429) return ARK_ERROR_CODES.RATE_LIMITED
  if (status === 400 || status === 422) return ARK_ERROR_CODES.INVALID_PARAMETER
  if (status === 408 || status === 504) return ARK_ERROR_CODES.TIMEOUT
  return ARK_ERROR_CODES.HTTP
}

/**
 * 从上游错误体里抽取可读 message 与上游 code。
 * 兼容方舟/语音两套返回：{error:{code,message}}、{code,message}、纯文本。
 */
export function readUpstreamError(bodyText) {
  const text = typeof bodyText === 'string' ? bodyText : ''
  if (!text.trim()) return { code: undefined, message: '' }
  try {
    const json = JSON.parse(text)
    const err = json && typeof json === 'object' ? json.error || json : {}
    const message = err.message || err.msg || json.message || ''
    const code = err.code !== undefined ? err.code : json.code
    return { code: code === undefined ? undefined : String(code), message: String(message || '') }
  } catch {
    return { code: undefined, message: text.slice(0, 500) }
  }
}
