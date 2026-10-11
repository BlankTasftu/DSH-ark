/**
 * dsh-ark —— 火山方舟能力插件入口。
 *
 * 对外提供 7 个模型可调用的工具：
 *   ark_generate_image   图像资产生成（Seedream）
 *   ark_generate_video   视频生成（Seedance，异步任务）
 *   ark_speak            语音合成（豆包语音 2.0）
 *   ark_generate_audio   音频生成（SeedAudio 1.0）
 *   ark_transcribe       语音转写（ASR 极速版）
 *   ark_credential_status 凭据自检（只读、免费）
 *
 * 注：**不做多模态理解**（看图问答 / OCR）—— 宿主模型本身已具备视觉能力，
 * 再包一层视觉模型只会多花一次 token 且更容易与宿主能力混淆。
 *
 * 设计约束（本文件是所有安全与成本决策的收口处）：
 *  1. **密钥只走 ctx.credentials**：配置文件里只存"凭据名"，任何日志与返回值都不回显密钥。
 *  2. **产物一律落盘**：上游直链 24h 失效，工具返回的是工作区文件路径。
 *  3. **计费接口不自动重试**：只有限流退避在 http.mjs 里做，参数错误直接上抛，
 *     避免把一次误操作重试成多次扣费。
 *  4. **本文件不做业务逻辑**：解析、拼接、换算都在 lib/*.mjs 里，各自可单测。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ARK_ERROR_CODES, ArkError, toArkError } from './errors.mjs'
import { ArtifactStore } from './artifacts.mjs'
import { createCredentialResolver, resolveConfig } from './config.mjs'
import { generateImage } from './ark-image.mjs'
import { createVideoTask, getVideoTask, waitForVideo } from './ark-video.mjs'
import { create3dTask, DEFAULT_3D_MODEL, waitFor3d } from './ark-3d.mjs'
import { synthesizeSpeech } from './volc-tts.mjs'
import { DEFAULT_AUDIO_FORMAT, generateAudio } from './volc-audio.mjs'
import { transcribe } from './volc-asr.mjs'

/**
 * 产物预览路由的 pathname。
 *
 * ⚠️ 这个常量有**两个消费方**，改形态时必须一起改：
 *   1. 本文件下方 `ctx.webServer.register({ kind: 'exact', path: ASSET_ROUTE })`；
 *   2. `storeFor()` 传给 `ArtifactStore` 的 `previewBase`（它据此拼出回传给模型的 URL）。
 * 两者不一致时的表现是：路由本身能工作（手拼 `?id=` 能取到图），但**模型拿到的地址命不中路由**
 * —— DSH 的 exact 路由按 **pathname** 精确匹配，所以 `…/asset/<id>` 这种路径段形态会 404。
 * `tests/plugin.test.mjs` 里有一条"URL → 路由"的往返用例专门钉住这一点。
 */
const ASSET_ROUTE = '/dsh-ark/asset'

/** 产物登记表的容量上限（见 registrySet 的注释）。 */
const REGISTRY_LIMIT = 512

/**
 * 从 Host 头里取出主机名（不带端口、不带用户信息）。
 *
 * 为什么不直接用 `new URL('http://' + host)`：URL 解析器会把 `127.0.0.1#evil.com`
 * 里 `#` 之后的部分当 **fragment** 丢掉，于是"主机名合法"这个结论来自一个被截断的输入。
 *
 * 更关键的是：**带 `#` / `?` / `/` / 空白的 Host 头本身就是畸形输入**（Host 只能有
 * 主机名 + 可选端口），不该被"尽力解析"。因为不同消费方对畸形 Host 的解读并不一致
 * （浏览器截断、代理不截断），继续解析等于把安全性建立在"大家都按同一种方式截断"上。
 * 所以这里一律判为不可信 → 返回 undefined（fail-closed）。
 */
function hostnameOfHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim()
  if (!raw) return undefined
  // 用户信息、fragment、query、路径、内嵌空白：任何一种出现都说明这个 Host 头不可信。
  if (/[@#?/\\\s]/.test(raw)) return undefined
  if (raw.startsWith('[')) {
    // IPv6 字面量：[::1] 或 [::1]:port
    const end = raw.indexOf(']')
    if (end < 0) return undefined
    const rest = raw.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return undefined
    return raw.slice(0, end + 1)
  }
  const colon = raw.lastIndexOf(':')
  if (colon < 0) return raw
  const port = raw.slice(colon + 1)
  // 端口必须是纯数字；`127.0.0.1:` 这类空端口也判畸形。
  if (!/^\d{1,5}$/.test(port)) return undefined
  return raw.slice(0, colon)
}

/**
 * 判定主机名是否为回环地址。
 *
 * 必须挡住 `2130706433` 这类**十进制/十六进制整数形式**的回环地址：
 * `new URL('http://2130706433')` 解析出的 hostname 是 `127.0.0.1`，但字符串比较看它是别的名字；
 * 而浏览器对整数形式的解读并不一致，把它当成"可信本机"会让白名单形同虚设。
 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  if (h === '0:0:0:0:0:0:0:1') return true

  // 纯数字形式：可能是十进制整数（2130706433）或十六进制。
  // 注意八进制写法（如 0177.0.0.1）不在支持之列 —— 浏览器已不再按八进制解释，
  // 把它当回环等于替浏览器做一个它自己都不做的假设。
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) {
    const value = /^0x/.test(h) ? Number.parseInt(h, 16) : Number.parseInt(h, 10)
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return false
    // 127.0.0.0/8
    return (value >>> 24) === 127
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (m.slice(1).some((part) => Number(part) > 255)) return false
  return Number(m[1]) === 127
}

/** 从请求头判定是否来自本机回环地址（fail-closed：解析不出来就当作非本机）。 */
function isLoopbackRequest(req) {
  const hostname = hostnameOfHostHeader((req.headers || {}).host)
  return isLoopbackHostname(hostname)
}

/**
 * 产物预览路由的信任校验。
 * 生成的图片/音频可能含有用户私有内容，因此只允许本机访问；
 * 若宿主提供了 connection.requestRejection，则同时委托它。
 *
 * @returns {number|null} 需要拒绝时返回状态码，放行返回 null
 */
function assetRequestRejected(ctx, req) {
  try {
    const headers = req.headers || {}
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403

    // Origin 校验：只接受与 Host 同源的 http(s) Origin。
    // `Origin: null`（沙箱 iframe / data: / file: 页面）一律拒绝 —— 它无法证明同源，
    // 而产物可能包含用户私有内容，宁可让这类页面拿不到，也不放行一个不可验证的来源。
    const origin = headers.origin
    if (typeof origin === 'string' && origin) {
      if (origin === 'null') return 403
      if (!/^https?:\/\//i.test(origin)) return 403
      let originAuthority
      try {
        const originUrl = new URL(origin)
        originAuthority = `${originUrl.hostname}${originUrl.port ? `:${originUrl.port}` : ''}`.toLowerCase()
      } catch {
        return 403
      }
      const hostHeader = String(headers.host || '').toLowerCase()
      if (originAuthority !== hostHeader) return 403
    }

    if (!isLoopbackRequest(req)) return 403
    const conn = ctx.get('connection')
    if (conn && typeof conn.requestRejection === 'function') {
      const code = conn.requestRejection(req)
      if (code !== undefined && code !== null && code !== false) {
        return typeof code === 'number' ? code : 403
      }
    }
    return null
  } catch {
    return 403
  }
}

/**
 * `render(args, value)` 用的包装：把工具返回的字符串值变成模型可读的内容块。
 *
 * ⚠️ 方向不能搞反，搞反了在真实运行时报
 * `tool "…" returned invalid output: "value" must be a string`：
 *   · `execute()` 返回**规范化 JSON 值**，受 `output.schema` 校验 —— 本插件是
 *     `{ type: 'string' }`，所以 execute **必须返回字符串**；
 *   · `render()` 收到那个值，负责把它变成**内容块数组**。
 * 因此 execute 里不要拼内容块（那是 render 的活），render 里也不要再返回字符串。
 * 这个区分由 tests/host-harness.mjs 的 output 校验复刻，写错会在单测里当场失败。
 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 人类可读的体量描述，用于在结果里让模型知道产物多大。 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 把视频任务状态渲染成稳定文本（提交 / 查询 / 轮询共用）。 */
function renderVideoStatus(result) {
  if (result.timedOut) {
    return [
      `视频任务仍在渲染：task_id=${result.taskId}，状态 ${result.status}。`,
      '这不代表失败——任务在服务端继续执行。',
      '请稍后用 ark_generate_video({ action: "status", taskId }) 再次查询，**不要重新提交**。',
    ].join('\n')
  }
  if (result.status !== 'succeeded') {
    return `视频任务未成功：task_id=${result.taskId}，状态 ${result.status}。`
  }
  // 成功了但一个产物都没落盘：必须说清楚，不能让"已下载"配一个空列表（静默的假成功）。
  if (!result.videos || result.videos.length === 0) {
    return [
      `视频任务已完成（task_id=${result.taskId}），但本次没有取到产物文件。`,
      ...(result.warnings || []).map((w) => `⚠️ ${w}`),
      '可能的产物直链已过期（预签名 URL 24 小时失效）。',
      '若直链仍有效，请用 ark_generate_video({ action: "status", taskId }) 重试下载；',
      '**不要重新提交任务**——那会另建一个计费任务。',
    ].join('\n')
  }
  const lines = result.videos.map((v, i) => `  ${i + 1}. ${v.relativePath}（${humanSize(v.bytes)}）`)
  return [`视频已生成并下载到工作区（task_id=${result.taskId}）：`, ...lines].join('\n')
}

/** 把 3D 任务状态渲染成稳定文本（提交 / 查询 / 轮询共用）。 */
function render3dStatus(result) {
  if (result.timedOut) {
    return [
      `3D 生成仍在进行：task_id=${result.taskId}，状态 ${result.status}。`,
      '这不代表失败——任务在服务端继续执行（实测约 7~8 分钟）。',
      '请稍后用 ark_generate_3d({ action: "status", taskId }) 再次查询，**不要重新提交**。',
    ].join('\n')
  }
  if (result.status !== 'succeeded' && result.status !== 'success') {
    const reason = result.failureReason ? `\n失败原因：${String(result.failureReason).slice(0, 300)}` : ''
    return `3D 生成未成功：task_id=${result.taskId}，状态 ${result.status}。${reason}`
  }
  if (!result.models || result.models.length === 0) {
    return [
      `3D 任务已完成（task_id=${result.taskId}），但本次没有取到模型文件。`,
      ...(result.warnings || []).map((w) => `⚠️ ${w}`),
      '产物直链会过期（预签名 URL）。若仍有效，请用 ark_generate_3d({ action: "status", taskId }) 重试下载；',
      '**不要重新提交任务**——那会另建一个计费任务。',
    ].join('\n')
  }
  const lines = result.models.map((m, i) => {
    const extra = m.fromArchive
      ? `（自 ZIP 内 ${m.entryName} 解出，原始压缩包 ${humanSize(m.archiveBytes)}）`
      : ''
    return `  ${i + 1}. ${m.relativePath}（${humanSize(m.bytes)}）${extra}`
  })
  return [
    `3D 模型已生成并下载到工作区（task_id=${result.taskId}）：`,
    ...lines,
    ...(result.warnings || []).map((w) => `⚠️ ${w}`),
  ].join('\n')
}

export default {
  name: 'dsh-ark',

  /**
   * 硬依赖：凭据服务。
   *
   * 声明它有两个作用：① 服务缺失时根本不调用 apply（而不是带着 undefined 硬跑）；
   * ② 服务晚于插件挂载时，Cordis 会在它就绪后重跑 apply。
   *
   * 但**不能只靠这个声明**：`tools` / `webServer` 是可选依赖（缺失时静默降级），
   * 所以下面仍用 `root.inject([...])` 分开等各自就绪 —— 这与 DSH 官方工具插件的
   * 做法一致（数组式 inject 会整体延迟 apply，可选依赖不该有那个语义）。
   */
  inject: ['credentials'],

  apply(root, config) {
    const cfg = resolveConfig(config)
    /**
     * 凭据解析器**每次调用现取** `ctx.credentials`，而不是在 apply 时抓一次快照。
     *
     * 为什么：插件的 apply 可能早于 credentials 服务就绪（DSH 的服务是渐进挂载的）。
     * 若在这里把 `root.get('credentials')` 的结果固化下来，那一刻拿到 `undefined`，
     * 之后服务就绪也永远用不上 —— 症状极具误导性：**凭据文件里明明有值，
     * 工具却一直报 MISSING_CREDENTIAL，而环境变量方式却正常**（因为兜底路径不走服务）。
     * 现取还顺带覆盖了服务被替换（热重载）的情形。
     */
    const creds = createCredentialResolver({ getCredentials: () => root.get('credentials') })

    /**
     * 产物登记表：id → 绝对路径 + MIME。预览路由只读这张表，不接外部传入的路径，
     * 因此不可能被用来读工作区之外的任意文件。
     */
    const registry = new Map()

    /**
     * 登记产物并维持容量上限。
     *
     * 为什么要上限：插件生命周期内可能生成成千上万个产物，无界增长会一直占着内存。
     * 超限时按插入序（Map 保持插入顺序）淘汰最旧的，只影响"老产物还能不能预览"，
     * 磁盘上的文件不受影响。
     */
    function registrySet(id, value) {
      registry.set(id, value)
      while (registry.size > REGISTRY_LIMIT) {
        const oldest = registry.keys().next()
        if (oldest.done) break
        registry.delete(oldest.value)
      }
    }

    /**
     * 每次调用建一个 store：产物目录跟随**调用时**的工作目录，而不是插件加载时的
     * 进程目录（同一进程里可能有多个工作区）。
     *
     * 用 Proxy 拦 save 做登记，而不是要求每个客户端模块自觉回报 —— 客户端模块
     * 只需要专心生成产物，登记这件事在插件层收口，漏登记的可能性为零。
     */
    function storeFor(exec) {
      const cwd = exec?.agent?.session?.header?.cwd || process.cwd()
      // previewBase 必须与注册的路由形态一致（query 形式），否则模型拿到的地址命不中路由。
      const inner = new ArtifactStore({ cwd, dir: cfg.output.dir, previewBase: ASSET_ROUTE })
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'save') {
            return async (input) => {
              const saved = await target.save(input)
              registrySet(saved.id, { entry: { path: saved.path, mime: saved.mime }, cwd })
              return saved
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    }

    // —— 工具注册：等 tools 服务就绪后再挂载，避免在未组合 tools 的 profile 上报错 ——
    root.inject(['tools'], (ctx) => {
      /**
       * ctx.tools.register 返回的 disposer 会被 DSH 的 fiber 作用域自动回收。
       * 这里只是**持有**它们（不主动调用），语义与官方工具插件一致。
       */
      const registeredToolDisposers = []

      /**
       * 工具执行失败时返回**模型可读的失败文本**，而不是抛异常。
       *
       * 为什么：DSH 把抛出异常的工具调用统一折叠成 `UNKNOWN_TOOL` 这类结构化错误，
       * 模型看不到 request_id 与修复指引，只能盲目重试——对按量计费的生成接口，
       * 盲目重试就是重复扣费。所以这里把 ArkError 的稳定 code + request_id +
       * 可执行指引一起交给模型，让它自己决定换参数还是停手。
       */
      const failureText = (name, err) => {
        const ark = toArkError(err)
        const lines = [`[${name}] 调用失败`, ark.toSummary()]
        if (ark.code === ARK_ERROR_CODES.ABORTED) {
          lines.push('（调用方已取消；若已提交计费任务，取消不会退款，请先用 status 查询任务状态。）')
        }
        return (lines.join('\n'))
      }

      /** 包一层：把失败收敛成文本。所有工具的 execute 都必须经由它。 */
      const guard = (name, body) => async (args, exec) => {
        try {
          return await body(args, exec)
        } catch (err) {
          return failureText(name, err)
        }
      }

      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_generate_image',
            description:
              '用火山方舟 Seedream 模型生成图像（文生图 / 参考图生图 / 指令编辑），产物落盘到工作区并返回文件路径。'
              + '按张计费：count > 1 会生成多张并**按张数翻倍计费**，不确定时保持 1。'
              + '尺寸默认 2K；方舟对总像素有下限（约 2560x1440），给过小的尺寸会被拒绝。',
            parameters: {
              prompt: { type: 'string', required: true, description: '画面描述（中文或英文均可）' },
              size: { type: 'string', description: '尺寸档位 1K/2K/4K，或显式 "宽x高"（如 2048x2048）' },
              aspectRatio: { type: 'string', description: '宽高比，如 1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9' },
              referenceImages: {
                type: 'array',
                items: { type: 'string' },
                description: '参考图路径（相对工作目录，必须在工作区内）或 http(s) URL；用于图生图 / 指令编辑',
              },
              count: { type: 'number', description: '生成张数，默认 1；大于 1 时走组图模式并相应计费' },
              guidanceScale: { type: 'number', description: '提示词引导强度（部分模型支持）' },
              watermark: { type: 'boolean', description: '是否加水印，默认 false' },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: false,
            execute: guard('ark_generate_image', async (args, exec) => {
              const store = storeFor(exec)
              const result = await generateImage(
                { config: cfg, creds, store, cwd: exec?.agent?.session?.header?.cwd, ...args },
                { signal: exec.signal },
              )
              const lines = result.images.map(
                (img, i) => `  ${i + 1}. ${img.relativePath}（${humanSize(img.bytes)}，${img.mime}）`,
              )
              return [
                `已生成 ${result.images.length} 张图像（模型 ${result.model}，尺寸 ${result.size}）：`,
                ...lines,
                `预览地址（仅本机可访问）：${result.images.map((i) => i.previewUrl).join('、')}`,
                result.requestId ? `request_id: ${result.requestId}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
        ),
      )

      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_speak',
            description:
              '把文本合成为语音（豆包语音合成 2.0），产物落盘为工作区音频文件。按字符计费。'
              + '长文本会自动按标点分句后串行合成并拼接。'
              + '注意：语音服务使用独立的凭据（语音技术 App ID / Access Token），'
              + '与 Ark API Key 不是同一个。',
            parameters: {
              text: { type: 'string', required: true, description: '要合成的文本' },
              voice: { type: 'string', description: '音色，默认使用配置里的音色；克隆音色以 S_ 开头' },
              format: {
                type: 'string',
                description: '音频格式 mp3 / ogg_opus / wav，默认 mp3（pcm 无容器头、无法做完整性校验，故不支持）',
              },
              sampleRate: { type: 'number', description: '采样率，默认 24000' },
              speedRatio: { type: 'number', description: '语速，1.0 为原速' },
              volumeRatio: { type: 'number', description: '音量，1.0 为原始音量' },
              pitchRatio: { type: 'number', description: '音调，1.0 为原始音调' },
              emotion: { type: 'string', description: '情感（部分音色支持），如 happy / sad / neutral' },
              explicitLanguage: { type: 'string', description: '克隆音色所需语种，如 zh / en；普通音色可省略' },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: false,
            execute: guard('ark_speak', async (args, exec) => {
              const store = storeFor(exec)
              const result = await synthesizeSpeech(
                { config: cfg, creds, store, ...args },
                { signal: exec.signal },
              )
              return [
                `已合成语音：${result.audio.relativePath}（${humanSize(result.audio.bytes)}，`
                  + `${result.format}/${result.sampleRate}Hz，${result.segments} 段拼接，通道 ${result.channel}）`,
                `预览地址（仅本机可访问）：${result.audio.previewUrl}`,
                // 非致命的完整性问题必须让模型看见，否则"没抛错"会被误当成"完全正常"。
                ...(result.warnings || []).map((w) => `⚠️ ${w}`),
                result.requestId ? `request_id: ${result.requestId}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
        ),
      )

      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_generate_audio',
            description:
              '用火山 SeedAudio 1.0 生成音频（**音频生成**模型，与 ark_speak 的语音合成是两条产品线）：'
              + '给一段**自然语言描述**，直接生成音频，可用于音效、配音、有声书、氛围音。按音频时长计费。'
              + '**注意：这个模型没有"音色"参数** —— 想指定音色请用 ark_speak（TTS）。'
              + '想影响生成结果只有两条路：① 在 textPrompt 里用文字描述声音（如"温柔清澈的少女嗓音"）；'
              + '② 传参考素材（音频最多 3 条，或一张图）让模型照着生成。'
              + '输出内容带随机性，同一描述每次结果都不同。需要语音 API Key（X-Api-Key 鉴权）。',
            parameters: {
              textPrompt: {
                type: 'string',
                required: true,
                description:
                  '描述要生成的音频，例如"用温柔清澈的少女嗓音，轻快地说出：你好呀"。'
                  + '无参考时描述目标声音；有音频参考时可用 @音频1 / @音频2 / @音频3 指代；'
                  + '有图片参考时这里只能是"要念出来的文本"。',
              },
              format: {
                type: 'string',
                description: `输出格式 ${DEFAULT_AUDIO_FORMAT}（默认）/ wav / ogg_opus / pcm`,
              },
              sampleRate: { type: 'number', description: '采样率，默认 24000' },
              referenceAudioUrls: {
                type: 'array',
                items: { type: 'string' },
                description: '参考音频 URL（最多 3 条，每条 ≤30 秒、≤10MB）。与参考图不能混用。',
              },
              referenceImageUrl: {
                type: 'string',
                description: '参考图 URL（与参考音频不能混用）',
              },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: false,
            execute: guard('ark_generate_audio', async (args, exec) => {
              const store = storeFor(exec)
              /**
               * 参考素材里**不含 speaker**：音频生成模型没有音色概念，
               * 传 TTS 音色会被上游以 45001115 明确拒绝（不是忽略）。
               */
              const references = []
              for (const url of args.referenceAudioUrls || []) {
                if (url) references.push({ audioUrl: url })
              }
              if (args.referenceImageUrl) references.push({ imageUrl: args.referenceImageUrl })

              const result = await generateAudio(
                {
                  config: cfg,
                  creds,
                  store,
                  textPrompt: args.textPrompt,
                  format: args.format,
                  sampleRate: args.sampleRate,
                  references,
                },
                { signal: exec.signal },
              )
              return [
                `已生成音频：${result.audio.relativePath}（${humanSize(result.audio.bytes)}，`
                  + `${result.format}/${result.requestedFormat}，时长 ${result.durationSeconds ?? '?'} 秒）`,
                `预览地址（仅本机可访问）：${result.audio.previewUrl}`,
                result.referenceCount > 0 ? `参考素材：${result.referenceCount} 条` : '',
                result.requestId ? `request_id: ${result.requestId}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
        ),
      )

      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_transcribe',
            description:
              '把音频文件转写成文字（语音识别 / ASR），返回全文与分句时间戳。按音频时长计费。'
              + '音频路径必须在工作区内。需要新版语音 API Key（X-Api-Key 鉴权）。'
              + '支持 mp3 / wav / ogg / pcm 等常见容器。',
            parameters: {
              audioPath: {
                type: 'string',
                required: true,
                description: '音频文件路径（相对工作目录，必须在工作区内）',
              },
              language: { type: 'string', description: '语种提示，如 zh-CN / en-US（可选，模型自判为主）' },
              enablePunctuation: { type: 'boolean', description: '是否输出标点，默认 true' },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: true,
            execute: guard('ark_transcribe', async (args, exec) => {
              const result = await transcribe(
                { config: cfg, creds, cwd: exec?.agent?.session?.header?.cwd, ...args },
                { signal: exec.signal },
              )
              const lines = [result.text]
              if (result.durationMs !== undefined) {
                lines.push(`\n（音频 ${(result.durationMs / 1000).toFixed(2)} 秒，${result.segments.length} 段）`)
              }
              if (result.requestId) lines.push(`request_id: ${result.requestId}`)
              return lines.join('\n')
            }),
          }),
        ),
      )

      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_generate_video',
            description:
              '用火山方舟 Seedance 模型生成视频（文生视频 / 图生视频）。**按秒计费且单价高**，'
              + '提交即产生费用。任务默认异步：立即返回 taskId，再用 action="status" 查询进度'
              + '（查询不产生新费用，且会在任务完成时把产物下载到工作区）。'
              + '视频直链 24 小时失效，所以成功后会自动下载。',
            parameters: {
              // prompt 不做 schema 级 required：action="status" 的纯查询不需要它。
              // 提交路径在 execute 里显式校验（见下），所以不会出现"缺 prompt 也提交"。
              prompt: { type: 'string', description: '视频内容描述（action=submit 时必填）' },
              action: {
                type: 'string',
                description: 'submit（默认，提交新任务）| status（查询已有任务，不产生新费用）',
              },
              taskId: { type: 'string', description: 'action=status 时要查询的任务 id' },
              wait: { type: 'boolean', description: '提交后是否阻塞等待完成（默认 false）' },
              resolution: { type: 'string', description: '分辨率 480p / 720p / 1080p' },
              ratio: { type: 'string', description: '宽高比，如 16:9、9:16、1:1、adaptive' },
              duration: { type: 'number', description: '时长（秒）' },
              frames: { type: 'number', description: '帧数（支持的模型上覆盖 duration；与 duration 互斥）' },
              firstFrame: { type: 'string', description: '首帧图片路径（工作区内）或 URL' },
              lastFrame: { type: 'string', description: '尾帧图片路径（工作区内）或 URL' },
              referenceImages: {
                type: 'array',
                items: { type: 'string' },
                description: '参考图路径（工作区内）或 URL',
              },
              referenceVideo: {
                type: 'string',
                description:
                  '参考视频 URL。注意：本地视频不能内联（数据面会 400 拒绝 data URL），'
                  + '需先上传到可公网访问的位置',
              },
              referenceAudio: { type: 'string', description: '参考音频 URL（同上，本地文件不能内联）' },
              allowLocalVideoAudio: {
                type: 'boolean',
                description:
                  '是否允许把本地视频/音频内联成 data URL（默认 false）。方舟数据面通常直接 400 拒绝'
                  + '视频/音频的 data URL，所以默认关闭；仅在确认账号/模型接受内联时才开启。',
              },
              cameraFixed: { type: 'boolean', description: '是否固定镜头' },
              watermark: { type: 'boolean', description: '是否加水印，默认 false' },
              generateAudio: { type: 'boolean', description: '是否生成音频' },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: false,
            execute: guard('ark_generate_video', async (args, exec) => {
              const cwd = exec?.agent?.session?.header?.cwd
              const action = args.action || 'submit'

              if (action === 'status') {
                if (!args.taskId) return '[ark_generate_video] action=status 需要提供 taskId。'
                // 用 waitForVideo 的**单次模式**：查一次，若已完成就把产物下载下来。
                // 为什么不用 timeoutMs: 0 —— 那是"elapsed 预算"语义，第一次迭代就会返回
                // timedOut，导致这次查询根本不发、产物也拿不到。`once` 才是"只查一次"的正确表达。
                // 单次模式绝不提交任务，所以查询不会产生新费用。
                const result = await waitForVideo(
                  { config: cfg, creds, store: storeFor(exec), taskId: args.taskId, cwd, once: true },
                  { signal: exec.signal },
                )
                return renderVideoStatus(result)
              }

              // schema 层没把 prompt 标 required（status 查询不需要它），
              // 所以这里必须自己兜住：绝不发出一次"没有内容描述"的计费提交。
              if (!args.prompt || !String(args.prompt).trim()) {
                return (
                  '[ark_generate_video] action=submit 需要提供 prompt（视频内容描述）。'
                  + '若只是想查询已有任务进度，请用 { action: "status", taskId } —— 那不会产生新费用。'
                )
              }

              const submitted = await createVideoTask(
                { config: cfg, creds, cwd, ...args },
                { signal: exec.signal },
              )
              if (!args.wait) {
                return (
                  [
                    `视频任务已提交（**已开始计费**）：task_id=${submitted.taskId}，状态 ${submitted.status}。`,
                    '渲染可能需要数分钟到十几分钟。用 ark_generate_video({ action: "status", taskId }) 查询进度，',
                    '**不要重复提交**——重复提交会创建新的计费任务。',
                    submitted.requestId ? `request_id: ${submitted.requestId}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                )
              }

              const result = await waitForVideo(
                { config: cfg, creds, store: storeFor(exec), taskId: submitted.taskId, cwd },
                { signal: exec.signal },
              )
              return (renderVideoStatus(result))
            }),
          }),
        ),
      )

      /**
       * 图生 3D（Seed3D）。
       *
       * 与视频工具同构：同样是任务式 API（提交 → 轮询），所以同样坚持"提交一次、
       * 之后一律查询"的纪律 —— 3D 生成按次计费，重复提交就是重复花钱。
       *
       * 落盘前会**解包并校验**：实测上游声明 `fileformat: "glb"` 却给了 `.zip`，
       * 直接改名会交付坏文件，所以统一解 zip + 校验 GLB 魔数后再交付（见 lib/ark-3d.mjs）。
       */
      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_generate_3d',
            description:
              '用火山方舟 Seed3D 模型从**一张图片**生成 3D 模型（图生 3D）。按次计费，提交即产生费用。'
              + '任务异步：立即返回 taskId，再用 action="status" 查询进度（查询不产生新费用，'
              + '且会在完成时把模型下载到工作区）。实测耗时约 7~8 分钟；产物为 glb，'
              + '上游以 ZIP 打包返回，本工具会自动解包并校验后再落盘。',
            parameters: {
              // 与视频同理：prompt 不标 required，status 查询不需要它；提交路径在 execute 里兜住。
              image: {
                type: 'string',
                description:
                  '输入图片：工作区内的相对路径（会自动内联为 base64），或 http(s) URL。action=submit 时必填。',
              },
              action: {
                type: 'string',
                description: 'submit（默认，提交新任务）| status（查询已有任务，不产生新费用）',
              },
              taskId: { type: 'string', description: 'action=status 时要查询的任务 id' },
              wait: { type: 'boolean', description: '提交后是否阻塞等待完成（默认 false）' },
              model: { type: 'string', description: `模型 id，默认 ${DEFAULT_3D_MODEL}` },
              subdivisionLevel: {
                type: 'string',
                description: '细分级别（上游响应字段 subdivisionlevel，如 low / medium / high）。不填则用服务端默认。',
              },
              fileFormat: {
                type: 'string',
                description: '目标格式（上游响应字段 fileformat，如 glb）。不填则用服务端默认。**仅 glb 经过实测**。',
              },
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: false,
            execute: guard('ark_generate_3d', async (args, exec) => {
              const cwd = exec?.agent?.session?.header?.cwd
              const action = args.action || 'submit'

              if (action === 'status') {
                if (!args.taskId) return '[ark_generate_3d] action=status 需要提供 taskId。'
                // 单次模式：查一次，若已完成就下载产物。绝不提交任务，所以不产生新费用。
                const result = await waitFor3d(
                  { config: cfg, creds, store: storeFor(exec), taskId: args.taskId, cwd, once: true },
                  { signal: exec.signal },
                )
                return render3dStatus(result)
              }

              // 绝不发出一次"没有输入图"的计费提交。
              if (!args.image || !String(args.image).trim()) {
                return (
                  '[ark_generate_3d] action=submit 需要提供 image（输入图片的工作区相对路径或 URL）。'
                  + '若只是想查询已有任务进度，请用 { action: "status", taskId } —— 那不会产生新费用。'
                )
              }

              const submitted = await create3dTask(
                { config: cfg, creds, cwd, ...args },
                { signal: exec.signal },
              )
              if (!args.wait) {
                return [
                  `3D 生成任务已提交（**已开始计费**）：task_id=${submitted.taskId}，状态 ${submitted.status}。`,
                  '实测耗时约 7~8 分钟。用 ark_generate_3d({ action: "status", taskId }) 查询进度，',
                  '**不要重复提交**——重复提交会创建新的计费任务。',
                  submitted.requestId ? `request_id: ${submitted.requestId}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              }

              const result = await waitFor3d(
                { config: cfg, creds, store: storeFor(exec), taskId: submitted.taskId, cwd },
                { signal: exec.signal },
              )
              return render3dStatus(result)
            }),
          }),
        ),
      )

      // 引用一下，表明这些 disposer 是**故意持有**而不是漏用。
      void registeredToolDisposers

      /**
       * 凭据自检（只读、零计费、零网络）。
       *
       * 为什么值得单独做一个工具：这条链路上有一段是插件看不见的 ——
       * 密钥可能存在凭据文件里、可能来自环境变量、也可能两边都没有；而"读不到"
       * 与"没配"在报错上长得一模一样（都是 MISSING_CREDENTIAL）。有了它，
       * 排查第一步就能确定是**配置问题**还是**插件读取问题**，不必靠猜。
       *
       * 它只回报"是否已配置 / 来自哪一层 / 值的长度与前后各 2 个字符"，
       * 不打印完整密钥；长度与前缀足以判断"填对了没有"。
       */
      registeredToolDisposers.push(
        ctx.tools.register(
          defineTool({
            name: 'ark_credential_status',
            description:
              '检查火山方舟插件所需的凭据是否已配置、来自哪一层（凭据服务/环境变量）。'
              + '只读自检：不发任何网络请求、不产生任何费用。'
              + '当图像/语音工具报"缺少凭据"时，先用它判断是没填，还是插件读取链路有问题。',
            parameters: {},
            output: {
              schema: { type: 'string' },
              render: (_args, value) => textBlock(value),
            },
            isConcurrencySafe: true,
            execute: guard('ark_credential_status', async () => {
              const service = root.get('credentials')
              const lines = [
                '# 火山方舟插件凭据自检',
                `凭据服务 ctx.credentials：${service ? '已挂载' : '**未挂载**（此时只能靠环境变量）'}`,
                '',
              ]
              /**
               * 掩码函数：**短值必须完全不显示**。
               *
               * 原实现是 `${value.slice(0,2)}…${value.slice(-2)}`，在长度 ≤ 3 时会**退化成回显**：
               * 2 字符的值会打印成 `MN…MN`（等于原文），3 字符会泄 2/3。
               * 真实火山密钥远超 4 字符，所以当前不可利用；但这个输出会进会话记录，
               * 一旦换用短 token 就会把密钥写进可分享的日志 —— 属于"迟早会踩"的坑。
               *
               * 因此按长度分级：≥12 才给首尾各 2 位；更短的一律只报长度，不给任何字符。
               */
              const maskSecret = (value) => {
                const v = String(value)
                return v.length >= 12
                  ? `${v.slice(0, 2)}…${v.slice(-2)}（${v.length} 字符）`
                  : `已配置（${v.length} 字符，过短不予显示）`
              }
              for (const item of [
                { ref: cfg.ark.credential, use: '图像 / 视频' },
                { ref: cfg.speech.apiKeyCredential, use: '语音（合成 / 识别 / 音频生成）' },
              ]) {
                const viaService = service ? await creds.resolveVia(item.ref, service) : undefined
                const viaEnv = process.env[item.ref]
                const value = viaService || viaEnv
                const source = viaService ? '凭据服务' : viaEnv ? '环境变量' : '未配置'
                lines.push(`- ${item.ref}（${item.use}）：${source} ${value ? maskSecret(value) : '—'}`)
              }
              // 直接给出结论，省得用户自己拼。
              const hasApiKey = Boolean(
                (service ? await creds.resolveVia(cfg.speech.apiKeyCredential, service) : undefined)
                || process.env[cfg.speech.apiKeyCredential],
              )
              lines.push('')
              lines.push(`语音能力（合成 / 识别 / 音频生成）：${hasApiKey ? '可用' : '**缺少 API Key，会失败**'}`)
              lines.push(
                '说明：两套凭据彼此独立且互不通用 —— '
                  + '`ARK_API_KEY`（`ark-` 开头）只用于图像/视频；'
                  + '语音则需要语音技术控制台的 API Key。旧版 App ID + Access Token 已不再支持。',
              )
              return lines.join('\n')
            }),
          }),
        ),
      )
    })

    // —— 产物预览路由：只在 webServer 就绪时注册 ——
    root.inject(['webServer'], (ctx) => {
      if (cfg.output.previewRoute === false) return
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: ASSET_ROUTE,
        handler: async (req, res) => {
          const denied = assetRequestRejected(ctx, req)
          if (denied !== null) {
            res.statusCode = denied
            res.end()
            return
          }
          try {
            const url = new URL(req.url || ASSET_ROUTE, 'http://localhost')
            const id = url.searchParams.get('id') || ''
            const found = registry.get(id)
            if (!found || !found.entry) {
              res.statusCode = 404
              res.end('not found')
              return
            }
            const bytes = await fs.readFile(found.entry.path)
            res.writeHead(200, {
              'Content-Type': found.entry.mime || 'application/octet-stream',
              'Content-Length': String(bytes.byteLength),
              // 产物是本地缓存内容，允许浏览器缓存但只在本机。
              'Cache-Control': 'private, max-age=600',
            })
            res.end(bytes)
          } catch (err) {
            res.statusCode = 500
            res.end(err instanceof ArkError ? err.toSummary() : 'read failed')
          }
        },
      })
      // webServer.register 返回的 disposer 会在 fiber 卸载时被调用；这里显式挂到
      // 插件 ctx 的 effect 上，保证热重载不残留旧路由。
      ctx.effect(() => () => {
        try {
          dispose()
        } catch {
          // 路由注销失败无副作用。
        }
      })
    })
  },
}
