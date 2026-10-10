/**
 * 共享 HTTP 调用层：JSON 请求、限流退避重试、取消传播、请求 id 采集。
 *
 * 为什么要自己写这一层（而不是直接 fetch）：
 *  1. 方舟与火山语音都靠 `x-request-id` / `X-Tt-Logid` 排障，必须统一采集。
 *  2. 429 需要退避重试（方舟限流错误码形如 ModelAccountIpmRateLimitExceeded）。
 *  3. 凭据请求必须 `redirect: 'error'`，避免 Authorization 被重定向带走。
 *  4. 取消语义要收敛：调用方取消 → ABORTED，网关超时 → TIMEOUT，其余 → NETWORK。
 */

import {
  ARK_ERROR_CODES,
  ArkError,
  classifyHttpStatus,
  isAbortError,
  readUpstreamError,
  toArkError,
} from './errors.mjs'

/** 默认请求超时（与 cordis.patch.yml 的默认值保持一致口径）。 */
export const DEFAULT_TIMEOUT_MS = 300_000

/** 请求 id 相关响应头，按优先级取第一个非空值。 */
const REQUEST_ID_HEADERS = ['x-request-id', 'x-tt-logid', 'x-tt-log-id', 'x-requestid']

export function readRequestId(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined
  for (const name of REQUEST_ID_HEADERS) {
    const v = headers.get(name)
    if (v) return v
  }
  return undefined
}

/** 把调用方 signal 与超时 signal 合成一个；Node 22+ 有 AbortSignal.any。 */
function combineSignals(callerSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return { signal: timeoutSignal, timedOut: () => timeoutSignal.aborted }
  const signal = AbortSignal.any([callerSignal, timeoutSignal])
  return { signal, timedOut: () => timeoutSignal.aborted && !callerSignal.aborted }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      // 抛 ArkError(ABORTED) 而不是裸的 DOMException：
      // MODULE-INTERFACES 的取消约定要求调用方只看错误码就能判断，不依赖 name 字符串。
      reject(
        new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消（退避等待期间）。', {
          cause: signal.reason,
        }),
      )
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 发一个 JSON 请求并解析 JSON 响应。
 *
 * @param {object} options
 * @param {string} options.url 完整 URL
 * @param {'GET'|'POST'|'DELETE'} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {unknown} [options.body] 会被 JSON.stringify
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] 限流重试次数（仅 429/限流码重试）
 * @param {number} [options.retryBackoffMs]
 * @param {string} [options.provider] 'ark' | 'speech'，仅用于错误标注
 * @param {typeof fetch} [options.fetchImpl] 便于测试注入
 * @returns {Promise<{ json: any, response: Response, requestId?: string }>}
 */
export async function requestJson(options) {
  const {
    url,
    method = 'POST',
    headers = {},
    body,
    signal: callerSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
    retryBackoffMs = 25_000,
    provider,
    fetchImpl = globalThis.fetch,
  } = options

  let attempt = 0
  for (;;) {
    const { signal, timedOut } = combineSignals(callerSignal, timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        // 凭据不跟随重定向：避免 Authorization 被带到第三方主机。
        redirect: 'error',
      })
    } catch (err) {
      if (isAbortError(err) || (callerSignal && callerSignal.aborted)) {
        throw new ArkError(ARK_ERROR_CODES.ABORTED, '调用已被取消。', { provider, cause: err })
      }
      if (timedOut()) {
        throw new ArkError(
          ARK_ERROR_CODES.TIMEOUT,
          `请求超过 ${timeoutMs} ms 未返回。`,
          { provider, retryable: true, cause: err },
        )
      }
      throw new ArkError(
        ARK_ERROR_CODES.NETWORK,
        `网络请求失败：${err && err.message ? err.message : String(err)}`,
        { provider, retryable: true, cause: err },
      )
    }

    const requestId = readRequestId(response.headers)
    const text = await response.text()

    if (response.ok) {
      if (!text.trim()) return { json: undefined, response, requestId }
      try {
        return { json: JSON.parse(text), response, requestId }
      } catch (err) {
        throw new ArkError(
          ARK_ERROR_CODES.BAD_RESPONSE,
          `上游返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 300)}`,
          { provider, httpStatus: response.status, requestId, cause: err },
        )
      }
    }

    const upstream = readUpstreamError(text)
    const code = classifyHttpStatus(response.status, upstream.code)
    // 仅限流重试；其余错误直接上抛，避免把参数错误重试成多次计费（图片/视频为计费接口）。
    if (code === ARK_ERROR_CODES.RATE_LIMITED && attempt < retries) {
      attempt += 1
      await sleep(retryBackoffMs * attempt, callerSignal)
      continue
    }
    throw new ArkError(
      code,
      `上游返回 HTTP ${response.status}${upstream.code ? ` (${upstream.code})` : ''}${upstream.message ? `：${upstream.message}` : ''}`,
      {
        provider,
        httpStatus: response.status,
        requestId,
        retryable: code === ARK_ERROR_CODES.RATE_LIMITED,
      },
    )
  }
}

/**
 * 发一个请求并返回原始字节（用于下载图片/视频/音频产物）。
 * @returns {Promise<{ bytes: Uint8Array, contentType?: string, requestId?: string }>}
 */
export async function requestBytes(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    signal: callerSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options

  const { signal, timedOut } = combineSignals(callerSignal, timeoutMs)
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      signal,
      // 产物直链可能来自 CDN/对象存储，允许重定向；这里不带任何凭据。
      redirect: 'follow',
    })
  } catch (err) {
    if (isAbortError(err) || (callerSignal && callerSignal.aborted)) {
      throw new ArkError(ARK_ERROR_CODES.ABORTED, '下载已被取消。', { cause: err })
    }
    if (timedOut()) {
      throw new ArkError(ARK_ERROR_CODES.TIMEOUT, `下载超过 ${timeoutMs} ms 未完成。`, {
        retryable: true,
        cause: err,
      })
    }
    throw toArkError(err, ARK_ERROR_CODES.NETWORK)
  }

  const requestId = readRequestId(response.headers)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const upstream = readUpstreamError(text)
    throw new ArkError(
      classifyHttpStatus(response.status, upstream.code),
      `下载产物失败：HTTP ${response.status}${upstream.message ? `：${upstream.message}` : ''}`,
      { httpStatus: response.status, requestId },
    )
  }
  const buf = new Uint8Array(await response.arrayBuffer())
  return { bytes: buf, contentType: response.headers.get('content-type') || undefined, requestId }
}
