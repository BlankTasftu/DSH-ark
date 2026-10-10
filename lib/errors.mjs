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

  /** 供工具层直接展示的一行摘要。 */
  toSummary() {
    const bits = [this.code]
    if (this.httpStatus !== undefined) bits.push(`HTTP ${this.httpStatus}`)
    if (this.requestId) bits.push(`request_id=${this.requestId}`)
    return `${bits.join(' · ')} — ${this.message}`
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
