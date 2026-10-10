/**
 * 配置解析 + 凭据解析。
 *
 * 两条硬规则：
 *  1. **密钥永远不落配置文件**。配置里只写“凭据名”（credential ref），实际值走
 *     DSH 凭据服务（ctx.credentials.resolve）或进程环境变量兜底。
 *  2. 配置来源优先级：profile patch 的 config 块 > 内置默认值。
 */

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'

export const DEFAULT_CONFIG = Object.freeze({
  ark: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    credential: 'ARK_API_KEY',
    // ⚠️ 默认模型 ID 必须选"当前在售"的版本化 ID。
    // `doubao-seedream-5-0-260128` 已被官方标记 Retiring，调用会返回
    // HTTP 404 InvalidEndpointOrModel.NotFound —— 这与"没开通"报错相同，
    // 极易被误判成权限问题。换默认值前请先用 GET /api/v3/models 确认状态。
    imageModel: 'doubao-seedream-5-0-pro-260628',
    videoModel: 'doubao-seedance-2-0-260128',
    requestTimeoutMs: 300_000,
    rateLimitRetries: 2,
    rateLimitBackoffMs: 25_000,
    downloadTimeoutMs: 300_000,
  },
  speech: {
    mode: 'sse',
    baseUrl: 'https://openspeech.bytedance.com/api/v3',
    /**
     * 鉴权**只用新版 API Key**（`X-Api-Key`）。
     *
     * 为什么不再支持旧版 App ID + Access Token：官方文档明确 App ID 是"请求/应用配置"、
     * **不是鉴权因子**；而实测确认新版 API Key 已覆盖本插件用到的全部语音能力
     * （TTS 2.0 / ASR 极速版 / SeedAudio 1.0 音频生成）。留着双方案只会让配置面
     * 变复杂、并制造"填了 App ID 却不通"的困惑。
     */
    apiKeyCredential: 'VOLCENGINE_SPEECH_API_KEY',
    resourceTts: 'seed-tts-2.0',
    resourceTtsClone: 'seed-icl-2.0',
    resourceTtsV1: 'volc.service_type.10029',
    resourceAsr: 'volc.seedasr.sauc.duration',
    voice: 'zh_female_shuangkuaisisi_uranus_bigtts',
    format: 'mp3',
    sampleRate: 24_000,
    maxCharsPerRequest: 200,
  },
  output: {
    dir: 'ark-output',
    previewRoute: true,
  },
})

function mergeSection(defaults, provided) {
  if (!provided || typeof provided !== 'object') return { ...defaults }
  const out = { ...defaults }
  for (const [k, v] of Object.entries(provided)) {
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

/** 把外部 config（可能缺字段、可能带噪音）规范化。 */
export function resolveConfig(provided) {
  const p = provided && typeof provided === 'object' ? provided : {}
  return {
    ark: mergeSection(DEFAULT_CONFIG.ark, p.ark),
    speech: mergeSection(DEFAULT_CONFIG.speech, p.speech),
    output: mergeSection(DEFAULT_CONFIG.output, p.output),
  }
}

/**
 * 凭据解析器：先 DSH 凭据服务，再进程环境变量。
 *
 * @param {object} options
 * @param {() => ({ resolve?: (ref: string) => Promise<{ value?: string } | string | undefined> } | undefined)} [options.getCredentials]
 *   **每次解析时现取**凭据服务的回调。不要传一个固定对象：插件 apply 可能早于
 *   credentials 服务就绪，固化快照会把"当时还没有服务"永久钉住，导致凭据文件里的值
 *   永远读不到（而环境变量兜底仍然生效，症状因此非常难查）。
 * @param {Record<string, string|undefined>} [options.env]
 */
export function createCredentialResolver({ getCredentials, credentials, env = process.env } = {}) {
  /** 取当前可用的凭据服务：优先现取回调，其次兼容直接传对象的老用法。 */
  function currentCredentials() {
    if (typeof getCredentials === 'function') {
      try {
        return getCredentials()
      } catch {
        return undefined
      }
    }
    return credentials
  }

  /**
   * @param {string} ref 凭据名（如 ARK_API_KEY）
   * @returns {Promise<string | undefined>}
   */
  async function resolve(ref) {
    if (!ref) return undefined
    const service = currentCredentials()
    if (service && typeof service.resolve === 'function') {
      try {
        const got = await service.resolve(ref)
        const value = typeof got === 'string' ? got : got && got.value
        if (value) return String(value)
      } catch {
        // 凭据服务不可用/未配置时静默回落到环境变量。
      }
    }
    const fromEnv = env[ref]
    return fromEnv ? String(fromEnv) : undefined
  }

  /** 取不到就抛 MISSING_CREDENTIAL，并在信息里给出可执行指引。 */
  async function require(ref, hint) {
    const value = await resolve(ref)
    if (!value) {
      throw new ArkError(
        ARK_ERROR_CODES.MISSING_CREDENTIAL,
        `缺少凭据 ${ref}。${hint || '请在「插件 → 已安装 → 火山方舟工具包」里填入，或设置同名环境变量。'}`,
      )
    }
    return value
  }

  /**
   * 只问凭据服务、不看环境变量 —— 供自检区分"服务里有没有"与"环境变量里有没有"。
   * 排查时这两者混在一起就会得出错误结论（"明明配了却读不到"多半是分层问题）。
   * @param {string} ref
   * @param {{ resolve?: (ref: string) => Promise<{ value?: string } | string | undefined> }} service
   * @returns {Promise<string | undefined>}
   */
  async function resolveVia(ref, service) {
    if (!ref || !service || typeof service.resolve !== 'function') return undefined
    try {
      const got = await service.resolve(ref)
      const value = typeof got === 'string' ? got : got && got.value
      return value ? String(value) : undefined
    } catch {
      return undefined
    }
  }

  return { resolve, require, resolveVia }
}

/**
 * 解析语音服务的鉴权凭据 —— **只支持新版 API Key**（`X-Api-Key`）。
 *
 * 为什么不支持旧版 App ID + Access Token：
 *  1. 官方文档明确 App ID 是"请求/应用配置"，**不是鉴权因子**；`X-Api-Key` 才是。
 *  2. 实测确认新版 API Key 覆盖本插件全部语音能力：TTS 2.0（`seed-tts-2.0`）、
 *     ASR 极速版（`volc.seedasr.sauc.duration`）、SeedAudio 1.0 音频生成。
 *  3. 容易踩的坑：把 Access Token 当 `X-Api-Key` 发会被判 `45000010 Invalid X-Api-Key`，
 *     而旧版双头在 ASR / 音频生成上直接 `45000000 resourceId is not allowed`。
 *     只留一条路，就没有"填错了看起来像没开通"的空间。
 *
 * 返回的对象保留 `scheme` 字段（恒为 'apiKey'），以便调用方与日志继续用统一口径描述。
 *
 * @returns {Promise<{ scheme: 'apiKey', apiKey: string }>}
 */
export async function resolveSpeechCredentials(config, creds) {
  const ref = config.speech.apiKeyCredential
  const apiKey = await creds.resolve(ref)
  if (!apiKey) {
    throw new ArkError(
      ARK_ERROR_CODES.MISSING_CREDENTIAL,
      `缺少语音服务凭据：请配置 API Key（凭据名 ${ref}）。`
        + '获取位置：火山引擎控制台 → 语音技术 → API Key 管理。'
        + '注意：App ID + Access Token 那套旧凭据本插件已不再使用；'
        + '方舟的 ARK_API_KEY 也不能用于语音。',
    )
  }
  return { scheme: 'apiKey', apiKey }
}
