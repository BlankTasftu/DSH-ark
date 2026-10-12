/**
 * 配置解析 + 凭据解析。
 *
 * 两条硬规则：
 *  1. **密钥永远不落配置文件**。配置里只写“凭据名”（credential ref），实际值走
 *     DSH 凭据服务（ctx.credentials.resolve）或进程环境变量兜底。
 *  2. 配置来源优先级：profile patch 的 config 块 > 内置默认值。
 */

import z from '@deepseek-ai/schemastery'

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'

/**
 * 凭据名的合法形状。
 *
 * ## 为什么要有这个校验（安全审计 F2）
 *
 * `config.ark.credential` / `config.speech.apiKeyCredential` 是**用户可编辑的自由字符串**
 * （README 明确说"可以改成别的名字"）。于是有一个真实且常见的误操作方向：
 * **把密钥值填进"凭据名"字段**（尤其是让模型代改 profile 配置时）。
 *
 * 掩码只保护**值**、不保护**名字**，而凭据名会被原样打印进两处**面向模型**的文本：
 *   · `ark_credential_status` 的自检输出；
 *   · `MISSING_CREDENTIAL` 的错误文案。
 *
 * 结果是：**恰恰是那个用来排障的免费工具**把密钥逐字打印给了模型（审计已实测复现）。
 *
 * ## 形状要收到多紧（这是踩过一轮的点）
 *
 * 第一版写成 `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`，看着合理，实际**放行了
 * `sk-CANARY1234567890abcdefghijklmnop`** —— 因为密钥同样"字母开头、含连字符"。
 * 那等于没修。收紧要收在**能区分两者的真实特征**上：凭据名是人起的环境变量式名字，
 * 而密钥是机器生成的随机串。所以要求：
 *
 *   · 至少含一个 `_` 或 `.`（`ARK_API_KEY`、`VOLCENGINE_SPEECH_API_KEY`、
 *     `A.b` 都有；`sk-CANARY1234567890abcdefghijklmnop` 没有）；
 *   · **不允许出现小写字母紧邻大写字母的驼峰**（`sk-CANARY…` 里 `kC` 就是），
 *     这是"随机串"的强特征，而环境变量式名字都是大写下划线或小写点分；
 *   · 只看单个点分段时，段内不得大小写混排。
 *
 * 结论：宁可偶尔拒绝一个奇怪的合法名字（用户改用规范名字即可），
 * 也不能放行一个密钥 —— 前者是可用性问题，后者是泄露。
 */
const REF_SHAPE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
/** 驼峰（小写紧邻大写）= 随机串特征，凭据名不该有。 */
const CAMEL_BUMP = /[a-z][A-Z]/
/** 纯 hex 且够长 = 密钥特征（凭据名不会长这样）。 */
const HEXLIKE = /^[0-9a-fA-F]{16,}$/

/**
 * 把凭据名安全化：形状合法才原样返回，否则用说明性占位符代替。
 *
 * 报错/自述文案里**一律**用它，不要直接用裸 `ref`。
 *
 * @param {unknown} ref - 配置里读到的凭据名
 * @returns {string} 可安全展示的凭据名
 */
export function safeRef(ref) {
  const s = String(ref ?? '')
  const looksLikeSecret = CAMEL_BUMP.test(s) || HEXLIKE.test(s) || !/[_.]/.test(s)
  if (REF_SHAPE.test(s) && !looksLikeSecret) return s
  return '<非法凭据名（疑似把密钥填到了"凭据名"字段，请检查配置）>'
}

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
    // ⚠️ 注意：模型出现在 GET /api/v3/models 里**不代表**账号能调用它 ——
    // seedance-2-0 在列表里状态为空却报 ModelNotOpen（未开通），
    // 而 seed3d-2-0 同样状态为空却可直接调用。列表状态既不能证明可用也不能证明不可用。
    // 本值已实测可提交（图生 3D），换值前请先实际调一次。
    model3d: 'doubao-seed3d-2-0-260328',
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
    /**
     * 语音资源 id。**只有这两个是本插件真正验证过的**：
     *   · `seed-tts-2.0`      TTS 2.0 音色（实测出音频）
     *   · `seed-icl-2.0`      声音克隆（资源存在，用非克隆音色会报 mismatch）
     *
     * 这里曾有一个 `resourceTtsV1: volc.service_type.10029`，是我按"1.0 代音色"的
     * 假设加的。实测证明该资源不存在（用可用音色照样 `45000030 not granted`），
     * 已删除。**不要再凭"代"的推测添加资源 id** —— 拿不准就用 `seed-tts-2.0`，
     * 让上游报准确的 mismatch，而不是照着不存在的资源报"未授权"。
     */
    resourceTts: 'seed-tts-2.0',
    resourceTtsClone: 'seed-icl-2.0',
    resourceAsr: 'volc.seedasr.sauc.duration',
    voice: 'zh_female_shuangkuaisisi_uranus_bigtts',
    format: 'mp3',
    sampleRate: 24_000,
    maxCharsPerRequest: 200,
  },
  output: {
    dir: 'ark-output',
    previewRoute: true,
    /**
     * 是否接受**沙箱 iframe** 的预览请求（`Origin: null`）。
     *
     * 默认 `false`：`Origin: null` 无法自证来源，本地 `file://` / `data:` 页面
     * 发的也是它，所以默认一律拒绝（fail-closed）。
     *
     * 打开后仍不放松任何其它条件，只多接受一种情形：`Sec-Fetch-Site` 为
     * `same-origin` / `same-site` 且带 `Sec-Fetch-Mode` —— 这组头由**浏览器生成**，
     * 页面 JS 无法伪造，因此能区分"同源的沙箱 iframe"与"file:// 页面"。
     *
     * 什么时候需要打开：DSH 的文档预览用沙箱 iframe 渲染，那种上下文里
     * 预览地址会带 `Origin: null`，默认设置下会被 403。
     */
    allowSandboxedPreview: false,
    /**
     * 是否把排障探针写到**插件自身目录**（工作区之外）。
     *
     * 默认 `false`：本插件唯一一处工作区外的写入，平时不该发生。
     * 需要排查"改了代码到底生效没有"时（宿主侧 ESM 被 Node 缓存，
     * 重载插件不重读文件，只有重启才生效）再打开。
     *
     * 探针内容只有能力开关与配置键名，**不含凭据**。
     */
    writeProbe: false,
  },
})

/**
 * 能力开关：一个能力对应一个（或多个）工具，以及它依赖的凭据。
 *
 * ## 为什么用"单一事实来源"的表
 *
 * 开关要在**三处**保持一致：① 默认值 ② host 侧注册工具时的过滤 ③ 设置页的勾选项。
 * 三处各写一份必然漂移 —— 症状是"页面上关了，工具却还在"或"新加了工具，页面没得关"。
 * 所以这里只声明一次，其余两处都从它派生。
 *
 * `tools` 是**工具名数组**而不是单个：将来一个能力可能对应多个工具（例如图像能力
 * 若拆出"编辑"工具），那时不用改结构。
 *
 * `credential` 用于设置页给用户提示"关掉它可省下哪把密钥的配置"；
 * `null` 表示不需要凭据（如产物相关能力）。
 */
export const CAPABILITIES = Object.freeze({
  image: {
    label: '图像生成',
    hint: 'Seedream 文生图 / 参考图生图 / 指令编辑',
    tools: ['ark_generate_image'],
    credential: 'ark',
  },
  video: {
    label: '视频生成',
    hint: 'Seedance 文生视频 / 图生视频（按秒计费，单价最高）',
    tools: ['ark_generate_video'],
    credential: 'ark',
  },
  threeD: {
    label: '图生 3D',
    hint: 'Seed3D 从一张图生成 3D 模型（glb，按次计费，约 7~8 分钟）',
    tools: ['ark_generate_3d'],
    credential: 'ark',
  },
  speech: {
    label: '语音合成',
    hint: '豆包语音合成 2.0（TTS），长文本自动分句',
    tools: ['ark_speak'],
    credential: 'speech',
  },
  audio: {
    label: '音频生成',
    hint: 'SeedAudio 1.0 按描述生成音频（音效 / 配音 / 氛围音）',
    tools: ['ark_generate_audio'],
    credential: 'speech',
  },
  transcribe: {
    label: '语音转写',
    hint: '语音识别（ASR），返回全文与毫秒级分句时间戳',
    tools: ['ark_transcribe'],
    credential: 'speech',
  },
  credentialStatus: {
    label: '凭据自检工具',
    hint: '只读自检工具 ark_credential_status（零计费、零网络），排障时有用，一般不必关',
    tools: ['ark_credential_status'],
    credential: null,
  },
})

/** 能力开关的默认值：**全开**，与加入本开关之前的行为完全一致。 */
export const DEFAULT_CAPABILITIES = Object.freeze(
  Object.fromEntries(Object.keys(CAPABILITIES).map((k) => [k, true])),
)

/**
 * 解包 cosmokit 的 **volatile 引用**。
 *
 * ## 为什么必须有这一步（这是本插件最贵的一个 bug）
 *
 * `.volatile()` 字段在**运行中的 config 里不是普通值，而是一个引用对象**：
 *
 *     { get: () => <当前值>, [Symbol(cosmokit.volatile.write)]: <写入器> }
 *
 * 它由 schemastery 的 `init()` 建好，Loader 在配置变更时**原地更新这个引用**
 * （`updateVolatile(ref, source)`）。所以 `config.capabilities.video` 拿到的是
 * **引用对象**，不是 `false`。
 *
 * 而 `resolveCapabilities` 的规则是"只有显式 `false` 才关闭"，于是
 * `ref === false` 恒不成立 → **7 项全判成开启** → 用户在设置页关掉能力后
 * 工具照旧注册、照旧可调用，且没有任何报错。
 *
 * 症状极具误导性：`JSON.stringify(ref)` 得到 `{}`，看起来像"空对象/没配置"，
 * 完全看不出真实值是 `false`。实测确认：
 *
 *     isVolatile(caps.video) === true
 *     caps.video.get()       === false      ← 用户关掉的就是它
 *
 * 判据用**结构化鸭子类型**（`get` 方法 + `cosmokit.volatile.write` 符号），
 * 而不是 `import { isVolatile } from '@deepseek-ai/cosmokit'`：
 * 本插件只声明了 `@deepseek-ai/schemastery` 这一个 peer 依赖，直接 import
 * 一个没声明的传递依赖在打包/解析场景下会碎；而鸭子判据不依赖包解析。
 *
 * @param {unknown} value - 可能是 volatile 引用，也可能是普通值
 * @returns {unknown} 解包后的普通值
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
export function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value
  const isRef =
    typeof value.get === 'function' &&
    (VOLATILE_WRITE in value || Object.getOwnPropertySymbols(value).some((s) => String(s).includes('volatile.write')))
  return isRef ? unwrapVolatile(value.get()) : value
}

/**
 * 归一化能力开关。
 *
 * 关键取舍：**未知键忽略、缺省键补 true**。
 *  - 只有 `false` 才表示"关闭"，其余（未设置 / 写错类型）一律当开启 ——
 *    否则配置里一个拼写错误就会静默禁掉能力，而用户以为它开着。
 *  - 未知键不报错也不保留：旧版本写下的键降级后不该让插件崩，
 *    但保留它会让"页面显示的"和"实际生效的"不一致。
 *
 * ⚠️ 每个值都要先 `unwrapVolatile`：运行中的 `.volatile()` 字段是引用对象，
 * 直接比 `=== false` 会让**所有开关都判成开启**（见 `unwrapVolatile` 的注释）。
 */
export function resolveCapabilities(provided) {
  const out = { ...DEFAULT_CAPABILITIES }
  if (!provided || typeof provided !== 'object') return out
  for (const key of Object.keys(CAPABILITIES)) {
    if (!(key in provided)) continue
    if (unwrapVolatile(provided[key]) === false) out[key] = false
  }
  return out
}

/** 某个能力是否启用（未提供时视为启用）。 */
export function isCapabilityEnabled(capabilities, name) {
  if (!(name in CAPABILITIES)) return true
  return capabilities?.[name] !== false
}

/**
 * 能力开关的 **Config schema** —— 插件设置页据此渲染。
 *
 * ## 为什么用 `capabilities.<name>` 这个路径
 *
 * DSH 的设置表单把字段路径直接写进插件的 config 块，所以**字段名必须与
 * `resolveCapabilities` 读的位置一致**：`config.capabilities.<name>`。
 * 写成扁平的同级键（`image: true`）就会存到一个 `resolveCapabilities` 不读的地方
 * —— 表现为"页面勾了、工具却照旧"，而且没有任何报错。
 *
 * ## 为什么 `.default(true)`
 *
 * 默认全开，且让表单知道"未设置 = 开启"，页面才能正确显示"已覆盖 / 恢复默认"。
 *
 * ## 为什么 `.volatile()`
 *
 * DSH 把 volatile 字段当作"用户级、可实时改"的偏好（区别于随插件行固定的普通配置）。
 * 参考 `@deepseek-ai/dsh-client-locale` 的 `Config`：它也只有一个 volatile 字段，
 * 客户端同样通过 `ctx.configForms.get(ns)` 绑定。
 */
export const Config = z.object({
  capabilities: z
    .object(
      Object.fromEntries(
        Object.keys(CAPABILITIES).map((k) => [k, z.boolean().default(true).volatile()]),
      ),
    )
    .default({}),
})

/** 工具名 → 能力名。用于"关掉的能力里的工具不得注册"这条判定。 */
export const CAPABILITY_BY_TOOL = Object.freeze(
  Object.fromEntries(
    Object.entries(CAPABILITIES).flatMap(([cap, def]) => def.tools.map((t) => [t, cap])),
  ),
)

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
    capabilities: resolveCapabilities(p.capabilities),
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
   * 凭据值的**来源侧清洗**：去首尾空白，并拒绝含控制字符的值。
   *
   * ## 为什么必须在这里拦
   *
   * 安全审计 F1 实测：凭据里混进 `\r` 或 `\x00` 时，undici 会抛
   *
   * ```
   * Headers.append: "Bearer <完整密钥>…" is an invalid header value.
   * ```
   *
   * —— **整把密钥被逐字写进异常消息**，然后经 `toSummary()` 进模型上下文与会话记录。
   * 而 `\r` 极容易带进来（Windows 剪贴板、脚本里 `"…\r\n"`、YAML 里手写转义）。
   *
   * `lib/errors.mjs` 的 `redactSecrets()` 已经在出口做了兜底，这里是**源头**拦截：
   * 与其让密钥先去 undici 绕一圈再被脱敏，不如根本不让它进请求头。
   *
   * 报错文案**不回显凭据值**（只给长度），否则"修一个泄露"变成"造一个泄露"。
   *
   * @param {unknown} value - 凭据服务或环境变量给出的原始值
   * @param {string} ref - 凭据名（仅用于报错定位）
   * @returns {string | undefined}
   */
  function sanitizeCredential(value, ref) {
    if (value === undefined || value === null) return undefined
    const raw = String(value)
    if (raw === '') return undefined
    // 控制字符（含 \r \n \t \x00 与 DEL）一律拒：合法 header 值里不该出现。
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      throw new ArkError(
        ARK_ERROR_CODES.MISSING_CREDENTIAL,
        `凭据 ${ref} 含控制字符（换行/回车/制表等，长度 ${raw.length}），`
          + '浏览器或脚本复制时容易带进来。请在凭据服务里删除后重新粘贴一次，'
          + '只保留密钥本身。',
      )
    }
    const trimmed = raw.trim()
    return trimmed === '' ? undefined : trimmed
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
        if (value) return sanitizeCredential(value, safeRef(ref))
      } catch (err) {
        // 凭据服务不可用/未配置时静默回落到环境变量 —— 但**清洗失败不能静默**：
        // 那是"凭据本身有问题"，回落到环境变量只会让同一个坏值再炸一次，
        // 而且用户看不到原因。清洗错误直接上抛。
        if (err instanceof ArkError) throw err
      }
    }
    const fromEnv = env[ref]
    return fromEnv ? sanitizeCredential(fromEnv, safeRef(ref)) : undefined
  }

  /** 取不到就抛 MISSING_CREDENTIAL，并在信息里给出可执行指引。 */
  async function require(ref, hint) {
    const value = await resolve(ref)
    if (!value) {
      throw new ArkError(
        ARK_ERROR_CODES.MISSING_CREDENTIAL,
        `缺少凭据 ${safeRef(ref)}。${hint || '请在「插件 → 已安装 → 火山方舟工具包」里填入，或设置同名环境变量。'}`,
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
      // `safeRef`：凭据名会被打印给模型，形状不合法时不回显原文（见 safeRef 的注释）。
      `缺少语音服务凭据：请配置 API Key（凭据名 ${safeRef(ref)}）。`
        + '获取位置：火山引擎控制台 → 语音技术 → API Key 管理。'
        + '注意：App ID + Access Token 那套旧凭据本插件已不再使用；'
        + '方舟的 ARK_API_KEY 也不能用于语音。',
    )
  }
  return { scheme: 'apiKey', apiKey }
}
