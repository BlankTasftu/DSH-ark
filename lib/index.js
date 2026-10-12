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
// ⚠️ `node:fs/promises` 的命名空间里**没有** `writeFileSync`（实测 `typeof === 'undefined'`）。
// 排障探针最初写的就是 `fs.writeFileSync(...)`，于是每次都抛 TypeError 被 catch 吞掉 ——
// 探针**从未落盘过一次**，而当时以为是别的原因，白追了一整轮。
// 同步写在这里就叫 `writeFileSync`，与 promises 版分开导入，避免再混。
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ARK_ERROR_CODES, ArkError, toArkError } from './errors.mjs'
import { ArtifactStore } from './artifacts.mjs'
import { Config, createCredentialResolver, resolveCapabilities, resolveConfig } from './config.mjs'
import { CAPABILITY_BY_TOOL } from './config.mjs'
import { generateImage } from './ark-image.mjs'
// ⚠️ 只 import 真正用到的：`getVideoTask` 曾在这里但从未被使用
// （视频的 status 查询走 `waitForVideo({ once: true })`）。
// 死 import 不会报错，但会让人以为存在一条独立的"查询"代码路径。
import { createVideoTask, waitForVideo } from './ark-video.mjs'
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
 * 预览响应的 MIME 白名单（安全审计 F5）。
 *
 * 只放行"浏览器会当成媒体/文件来渲染、而不会当成文档执行"的类型。
 * 任何不在名单里的（尤其 `text/html`、`image/svg+xml`、`application/xhtml+xml`）
 * 一律降级成 `application/octet-stream` —— 配合 `nosniff` 与 `attachment`，
 * 即使上游或配置把 MIME 篡改成可执行类型，也不会在 DSH 同源上被渲染。
 *
 * @param {unknown} mime - 登记表里的 MIME（可能来自上游响应头）
 * @returns {string} 可安全用于响应的 MIME
 */
function safePreviewMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  if (/^image\/(png|jpeg|jpg|webp|gif|bmp|avif)$/.test(m)) return m
  if (/^(video|audio)\/[a-z0-9.+-]+$/.test(m)) return m
  if (/^model\/[a-z0-9.+-]+$/.test(m)) return m
  if (m === 'application/octet-stream' || m === 'application/zip') return m
  return 'application/octet-stream'
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

    /**
     * 先看**连接来源**，再看 Host 头（安全审计 F4）。
     *
     * 只看 Host 是"客户端自报家门"：任何能连到这个端口的进程都能写
     * `Host: 127.0.0.1:19387` 通过校验。加上 `req.socket.remoteAddress`
     * 后变成"与"关系 —— 两者都必须是回环。这是纵深防御：当前 DSH 只监听
     * 127.0.0.1，所以远程本来连不上，但本地其它进程、以及将来宿主监听地址
     * 变化的情形，都能被这一条挡住。
     */
    const remote = req.socket?.remoteAddress
    if (typeof remote === 'string' && remote) {
      // IPv4-mapped IPv6（`::ffff:127.0.0.1`）与 IPv6 回环（`::1`）都要认。
      const normalized = remote.startsWith('::ffff:') ? remote.slice(7) : remote
      if (!(normalized === '::1' || isLoopbackHostname(normalized))) return 403
    }

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

/**
 * 追加到每个**产出文件**的工具描述末尾的一句交付指令。
 *
 * ## 为什么需要它
 *
 * 实测反馈：生成完图片后，会话窗口里只看到图片，用户拿不到文件。
 * 原因是产物虽然已落盘、路径也回传了，但"把文件交付给用户"这一步
 * **取决于调用方有没有把文件登记为交付物** —— 而那一步没有任何地方提醒它做。
 *
 * 工具描述是模型**每次调用都会看到**的文本，所以把这条指令写在这里，
 * 比写进文档（要靠人记得读）或靠"下次记得"（换个会话就失效）都可靠。
 *
 * ## 为什么加"报告路径"这半句
 *
 * 交付动作本身可能失败或不被支持。路径是**不依赖任何机制**的兜底：
 * 只要把绝对路径写出来，用户至少能自己去打开。
 * 两句话一起给，才不会出现"卡片没出来、路径也没给"的真空。
 */
const DELIVERY_NOTE =
  '【交付要求】产出文件后，除了报告工作区相对路径，'
  + '还要把文件登记为交付物展示给用户（例如调用 present 工具），'
  + '让用户在会话里能直接打开 —— 只贴一行路径或预览地址不算交付。'
  + '若无法登记，必须把**绝对路径**完整写在回复里，用户据此自行打开。'
  + '**把交付卡片放在回复的最后**，让用户一眼能看到，不要夹在中间。';

/**
 * 生成"预览地址"那一行。
 *
 * ## 为什么必须放在结果的**最后一行**
 *
 * 实测反馈：预览卡片要放在最后，用户才能直接看到。
 * 卡片是宿主对**预览地址**这一行的渲染结果，而渲染顺序跟着文本顺序走 ——
 * 所以只要预览地址不是最后一行（例如后面还跟着 `request_id`），
 * 卡片就会被顶到中间，用户得往下翻才看得到。
 *
 * 因此：**任何产出文件的工具，返回文本的最后一行都必须是它**。
 * 这一条由 `tests/plugin.test.mjs` 的回归测试守着（断言每份输出以预览地址结尾）。
 *
 * @param {Array<{previewUrl: string}>} artifacts - 带 previewUrl 的产物
 * @returns {string} 预览地址行；没有产物时返回空串（配合 .filter(Boolean) 用）
 */
function previewLine(artifacts) {
  const urls = (artifacts || []).map((a) => a && a.previewUrl).filter(Boolean)
  if (urls.length === 0) return ''
  return `预览地址（仅本机可访问）：${urls.join('、')}`
}

/**
 * 仍在进行中的任务状态集合。
 *
 * 为什么需要它：`timedOut` 只表示"本地等待超时"，而**单次 `action: "status"` 查询**
 * 天生就是 `timedOut: false` 配一个 `status: 'running'`。原实现只判 `timedOut`，
 * 于是这种查询会被渲染成"任务未成功" —— 而 README 与模块注释反复强调"仍在渲染"
 * 与"失败"必须严格区分。这个措辞会**诱导模型重新提交任务，造成重复计费**
 * （视频按秒、单价最高）。
 *
 * 涵盖上游各接口可能用的措辞：方舟视频用 `running`/`queued`，
 * 语音与 3D 侧还可能出现 `processing`/`pending`/`in_progress`。
 */
const IN_PROGRESS_STATUSES = new Set(['running', 'queued', 'processing', 'pending', 'in_progress', 'created', 'submitted'])

/** 该状态是否表示"任务还在跑"（而非失败或完成）。 */
function isInProgress(status) {
  return IN_PROGRESS_STATUSES.has(String(status || '').toLowerCase())
}

/** 把视频任务状态渲染成稳定文本（提交 / 查询 / 轮询共用）。 */
function renderVideoStatus(result) {
  if (result.timedOut || isInProgress(result.status)) {
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
  return [
    `视频已生成并下载到工作区（task_id=${result.taskId}）：`,
    ...lines,
    // 视频也能预览（浏览器可直接播放），放最后一行让卡片落到最下面。
    previewLine(result.videos),
  ]
    .filter(Boolean)
    .join('\n')
}

/** 把 3D 任务状态渲染成稳定文本（提交 / 查询 / 轮询共用）。 */
function render3dStatus(result) {
  // 同 renderVideoStatus：单次 status 查询天生 timedOut=false 而 status='running'，
  // 只判 timedOut 会把"仍在跑"说成"未成功"，诱导模型重复提交（重复计费）。
  if (result.timedOut || isInProgress(result.status)) {
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
    // 3D 模型浏览器里没法直接"看"，但保留预览地址（可下载 .glb 到本地用别的软件打开），
    // 且**必须最后一行**以保持"预览地址永远在末尾"这条不变量。
    previewLine(result.models),
  ]
    .filter(Boolean)
    .join('\n')
}

export default {
  name: 'dsh-ark',

  /**
   * ⚠️ **Config 必须挂在这个默认导出对象上，不能只写 `export { Config }`。**
   *
   * 这一条踩过坑，而且症状极具误导性：设置页的「能力开关」整排是灰的、点了没反应，
   * 没有任何报错。原因是 Cordis 的插件运行记录是这么建的
   * （`@deepseek-ai/cordis/lib/index.js`，`Registry.plugin()`）：
   *
   * ```js
   * runtime = { name, callback, fibers, Config: plugin.Config }
   * ```
   *
   * 而 `plugin` 是 Loader 归一化后的**默认导出对象**
   * （`cordis-plugin-loader` 的 `unwrapExports(exports)`：`exports.default ?? exports`）：
   * 它先把 ESM 命名空间拆成默认导出，命名导出就**不再可见**了。
   *
   * 于是 `plugin.Config` 为 `undefined` → `runtime.Config` 为空 →
   * 宿主 `settings.describe()` 跳过本条目（`if (schema === undefined) return []`）→
   * 客户端 `configForms.get('dsh-ark')` 拿到的 scope **永远不 ready** →
   * 按设计不发写请求 → 开关全灰、点击无反应。
   *
   * 所以这里同时做两件事：具名导出（`export { Config }`，供 `configForms` 一侧的
   * 约定与测试引用）**并且**挂到默认导出对象上（真正被读到的那条路）。
   */
  Config,

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
     * 收到过的事件名（诊断）。
     *
     * 存在的理由：`loader/volatile-update` 到底有没有送到本插件，是这一串问题里
     * **唯一只能靠猜**的一格 —— 事件没送到与配置没读到，在页面上长得完全一样
     * （工具照旧在）。Cordis 的事件派发带 fiber 过滤
     * （`dispatch()`：`filter.call(thisArg, hook.ctx)`），监听注册在哪个 ctx 上
     * 会决定收不收得到，从文档看不出来，只能实测。
     */
    const eventsSeen = new Set()

    /**
     * 排障探针：把「这一次 apply / 重建看到的开关与结果」落到插件包目录里。
     *
     * ```
     * { at, reason, configKeys, rawCapabilities, capabilities, rebuildCount, eventsSeen }
     * ```
     *
     * ## 为什么它不是调试残留
     *
     * 能力开关"没生效"有四种失败模式，而它们在页面上**长得完全一样**（工具照旧在）：
     * ① 设置页没写进 profile 补丁；② 插件读到的 config 不对；
     * ③ `loader/volatile-update` 没收到；④ 收到了但注册表没换。
     * 只看现象无法区分，翻宿主日志又要用户去操作。落一个小文件就能一眼定位。
     *
     * ## 它还回答了一个更隐蔽的问题
     *
     * **改完 `lib/index.js` 之后到底生效了没有。** 宿主侧的 ESM 模块被 Node 缓存，
     * "重载插件"（dispose + 重新 mount）**不会重新读文件** —— 只有重启 DSH 才会。
     * `at` 时间戳就是判据：改了代码又重载插件，若时间戳不动，说明跑的还是旧模块。
     * （本项目为此浪费过一整轮排查：拿着没生效的改动去下结论。）
     *
     * 写到插件包目录内（`import.meta.url` 推导），**不是** `process.cwd()`：
     * 宿主的 cwd 是安装目录而不是工作区，写过去根本找不到。
     * 文件名以 `.` 开头且已进 `.gitignore`。写入失败一律吞掉。
     *
     * @param {string} reason - 触发写入的时机（`apply` / `rebuild`）
     * @param {object} [caps] - 当时结算出的能力开关
     * @param {number} [count] - 当时的重建次数
     */
    function writeProbe(reason, caps, count) {
      try {
        writeFileSync(
          fileURLToPath(new URL('../.apply-probe.json', import.meta.url)),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              reason,
              // 宿主传给 apply 的原始 config：键 + capabilities 的**原始值**。
              // 这两项能直接区分"配置没传进来"与"传进来了但门控没跑"。
              configKeys: config && typeof config === 'object' ? Object.keys(config) : typeof config,
              rawCapabilities: config?.capabilities ?? null,
              // 结算后的开关（缺省补 true 之后）—— 注意这里已经是普通布尔值，
              // volatile 引用在 resolveCapabilities 里被解包过了。
              capabilities: caps ?? cfg.capabilities,
              rebuildCount: count ?? null,
              eventsSeen: [...eventsSeen],
            },
            null,
            2,
          ),
        )
      } catch {
        // 诊断写入失败不影响功能。
      }
    }
    writeProbe('apply', undefined, 0)

    /**
     * 设置页的呈现策略。
     *
     * `auto: false` 表示**不要**让 DSH 由 Config schema 自动生成页面 ——
     * 本插件的设置页由 `lib/client.js` 自己渲染（要把两把密钥的录入与七项能力开关
     * 放在一起，自动页面做不到）。这与 `@deepseek-ai/dsh-client-locale` 的做法一致：
     * 它同样声明了 Config，也把呈现策略设为 auto:false，然后由自己的浏览器半绑定表单。
     *
     * 用可选依赖（`root.inject`）而不是硬 inject：`settings` 服务缺失时插件其余部分
     * 照常工作，只是没有设置页 —— 不该因为一个可选服务就让整插件挂掉。
     */
    root.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, root.fiber))
    })
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
       * 能力开关：**只注册被启用的能力所对应的工具**。
       *
       * 为什么用"不注册"而不是"注册后拒绝执行"：工具 schema 会进模型上下文，
       * 关掉的能力若仍注册，模型仍会看到并可能去调它 —— 既浪费 token，
       * 也让它以为该能力可用。不注册是唯一能真正把它从模型视野里移除的做法。
       *
       * 注册时机**不是** apply 一次定死：见下面 `liveCaps` 与
       * `loader/volatile-update` 监听 —— 翻开关会当场重建工具表，无需重载插件。
       */
      /**
       * 能力开关的**活值读取**。
       *
       * ⚠️ 不要在 apply 时把结果缓存下来（例如
       * `const caps = resolveCapabilities(config.capabilities)` 只算一次），
       * 那正是本插件犯过的错：`capabilities.*` 是 **volatile** 字段，而 Loader 对
       * "只改了 volatile 值"的配置变更走**快速路径**
       * （`cordis-plugin-loader`：`volatileOnly ? this.fiber._config = ... : changes`），
       * 它**只更新运行中的引用，不重启插件、不再调 apply()**。
       *
       * 于是"在设置页关掉能力"这件事对缓存过的 `caps` 毫无影响 —— 工具照旧注册，
       * 用户看到的是"关了没用"。症状与"配置没写进去"完全一样，极难区分。
       *
       * 所以每次判定都现读；配合下面的 `loader/volatile-update` 监听重建注册表。
       *
       * ⚠️ 读的必须是 **`config.capabilities`**，不是 `cfg.capabilities`：
       * `resolveConfig()` 里的 `resolveCapabilities(p.capabilities)` 会**复制**出一份
       * 普通对象，而 Loader 更新的是 `config` 上那个 volatile 引用本身 ——
       * 读 `cfg` 等于读一份永不更新的死快照，症状与缓存 `caps` 完全一样。
       * （这一点是写这条注释时复查 `resolveConfig` 才发现的，否则会以另一种形式重蹈覆辙。）
       */
      const liveCaps = () => resolveCapabilities(config?.capabilities)

      /**
       * 当前已注册的工具：名字 → disposer。
       *
       * 用 Map 而不是数组，是为了"重建"时能精确注销上一批 —— 重建的语义是
       * **让注册表等于当前开关所允许的集合**，而不是往上叠。
       */
      const activeTools = new Map()

      /**
       * 重建计数与时刻。
       *
       * 这两个值是"`loader/volatile-update` 到底有没有触发过重建"的**唯一**直接证据：
       * apply 时是 1；用户在设置页每翻一次开关应当 +1。若翻过开关但计数仍是 1，
       * 说明事件没收到 —— 而这与"配置没传到插件"在页面上长得一模一样。
       */
      let rebuildCount = 0
      let lastRebuildAt = ''

      /** 已注册的工具名快照（供启动自检/测试对账）。 */
      let registeredNames = []

      /**
       * 能力关闭时跳过该工具的注册，并留一条可对账的日志。
       *
       * 每次现读开关（`liveCaps()`），不看任何缓存 —— 见上面 `liveCaps` 的注释。
       */
      const enabled = (capability) => {
        const on = liveCaps()[capability] !== false
        if (!on) {
          root.logger?.info?.('[dsh-ark] 能力已关闭，跳过工具注册：%s', capability)
        }
        return on
      }

      /**
       * 重建工具注册表：**先全部注销，再按当前开关注册应注册的**。
       *
       * 这就是"关掉能力后工具真的消失"能成立的地方。之前把注册当成
       * apply 的一次性副作用，而 volatile 变更不会重跑 apply —— 于是永远不生效。
       *
       * 幂等、可重复调用：重复调用只是把同一集合重新算一遍。
       */
      const rebuildTools = () => {
        for (const [, dispose] of activeTools) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // 注销失败不该让重建中断（例如 fiber 已在回收途中）。
          }
        }
        activeTools.clear()
        registeredNames = []
        rebuildCount += 1
        lastRebuildAt = new Date().toISOString()
        const capsNow = liveCaps()
        for (const [toolName, definition] of Object.entries(toolDefinitions)) {
          const capability = CAPABILITY_BY_TOOL[toolName]
          if (capability && capsNow[capability] === false) continue
          activeTools.set(toolName, ctx.tools.register(definition))
          registeredNames.push(toolName)
        }
        writeProbe('rebuild', capsNow)
      }

      /**
       * 工具定义表：**只声明，不注册**。
       *
       * 拆出来的理由：注册时机现在由开关决定（见 `rebuildTools`），
       * 定义与"何时注册"必须解耦。下面每个条目都是 `defineTool({...})`，
       * 保持原有的字面量结构与注释。
       */
      const toolDefinitions = {}

      /** 登记一个工具定义（apply 期间调用，之后由 rebuildTools 决定是否注册）。 */
      const defineArkTool = (toolName, definition) => {
        toolDefinitions[toolName] = definition
      }

      /**
       * 能力开关（供设置页与日志对账）。
       *
       * 只做**展示与对账**：注册与否一律走 `rebuildTools` 里那次现读。
       *
       * 这条日志是刻意留的排障手段，不是调试残留：能力开关"没生效"的可能原因
       * 分布在三层（设置页没写进配置 / 插件没读到配置 / 读到了但门控没跑），
       * 而三种原因在页面上长得**一模一样**（工具照旧在）。把结算结果打出来，
       * 一眼就能定位到底是哪一层：
       *
       *   · 日志里 capabilities 已是 `{video:false,...}`，工具却仍在 →
       *     重建链路坏了（没收到 `loader/volatile-update`，或 rebuildTools 没生效）；
       *   · 日志里 capabilities 全 true → 配置没读进来（配置写错了位置）；
       *   · **根本没有这条日志** → apply 没跑到这里（插件没加载）。
       */
      {
        const caps = liveCaps()
        const off = Object.keys(caps).filter((k) => caps[k] === false)
        root.logger?.info?.(
          '[dsh-ark] apply：能力开关 %s；已关闭 [%s]',
          JSON.stringify(caps),
          off.length > 0 ? off.join(', ') : '无',
        )
      }

      /**
       * volatile 配置更新 → 重建工具注册表。
       *
       * `cordis-plugin-loader` 在只改 volatile 值时
       * `fiber.ctx.emit(self, 'loader/volatile-update', paths)`，事件是发给
       * **插件自己的 ctx** 的，所以这里能收到。多个 DSH 官方插件都这么做
       * （`dsh-experimental-speech-to-text` / `dsh-llm-pi-ai` / `dsh-client-product-analytics`）。
       *
       * ⚠️ **注册在 `root` 上、不是那个 inject 出来的 child ctx。**
       * 这一条是实测出来的，不是照抄官方插件就能对：Cordis 的事件派发带 fiber 过滤
       * （`dispatch()`：`filter.call(thisArg, hook.ctx)`），Loader 用
       * `Object.create(fiber.ctx)` 造了个带 `[Context.filter]` 的 thisArg，只放行
       * `owner.fiber === fiber` 的监听器。`root` 的 fiber 就是这个 fiber，所以能收到。
       *
       * （实测记录：注册在 `root` 上时自述显示
       * `收到过的事件：root:loader/volatile-update`，重建次数随每次翻开关 +1。）
       *
       * 收到就重建：这是"翻开关后工具表立刻变"真正生效的时刻。
       */
      root.on('loader/volatile-update', (paths) => {
        eventsSeen.add(`loader/volatile-update(${JSON.stringify(paths ?? null)})`)
        rebuildTools()
      })

      /**
       * 登记一个工具定义。
       *
       * ## 为什么按"工具名 → 能力"映射，而不是往 defineTool 里塞字段
       *
       * 最初的做法是在每个 `defineTool({...})` 字面量里加 `enabled: enabled('image')`，
       * 然后在注册处读它。**这个做法静默失效了**：`defineTool()` 会构造并返回
       * 自己的对象，字面量里它不认识的键**在返回时就被丢掉了** —— 注册处读到的
       * `definition.enabled` 永远是 `undefined`，于是 `!== false` 恒真、
       * 所有工具照常注册。测试当场抓到了这个 bug。
       *
       * 现在改为在**调用点**显式传工具名，用 `CAPABILITY_BY_TOOL` 查它属于哪个能力。
       * 好处是不依赖 defineTool 保留未知字段（那是实现细节，不该被依赖），
       * 而且"某工具没登记在能力表里"会保守放行 —— 新加工具忘了登记
       * 只会"关不掉"，不会"凭空消失"。
       */
      const gateTool = defineArkTool

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

      gateTool('ark_generate_image',
          defineTool({
            name: 'ark_generate_image',
            description:
              '用火山方舟 Seedream 模型生成图像（文生图 / 参考图生图 / 指令编辑），产物落盘到工作区并返回文件路径。'
              + '按张计费：count > 1 会生成多张并**按张数翻倍计费**，不确定时保持 1。'
              + '尺寸默认 2K；方舟对总像素有下限（约 2560x1440），给过小的尺寸会被拒绝。' + DELIVERY_NOTE,
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
                // request_id 必须在预览地址**之前**：预览地址是最后一行，
                // 卡片才会落在最下面（见 previewLine 的注释）。
                result.requestId ? `request_id: ${result.requestId}` : '',
                previewLine(result.images),
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
      )

      gateTool('ark_speak',
          defineTool({
            name: 'ark_speak',
            description:
              '把文本合成为语音（豆包语音合成 2.0），产物落盘为工作区音频文件。按字符计费。'
              + '长文本会自动按标点分句后串行合成并拼接。'
              // ⚠️ 这里**不要**再写 "App ID / Access Token"：那套旧凭据已整体移除，
              // 只支持 X-Api-Key。模型读到旧措辞会去**问用户要 App ID**（用户根本不需要），
              // 属误导性文案（安全审计 F14）。
              + '注意：语音服务的凭据与 Ark API Key 不是同一个，'
              + '需要在火山「语音技术」控制台单独申请 API Key。' + DELIVERY_NOTE,
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
                // 非致命的完整性问题必须让模型看见，否则"没抛错"会被误当成"完全正常"。
                ...(result.warnings || []).map((w) => `⚠️ ${w}`),
                result.requestId ? `request_id: ${result.requestId}` : '',
                // 预览地址**永远最后一行**（见 previewLine 注释）
                previewLine([result.audio]),
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
      )

      gateTool('ark_generate_audio',
          defineTool({
            name: 'ark_generate_audio',
            description:
              '用火山 SeedAudio 1.0 生成音频（**音频生成**模型，与 ark_speak 的语音合成是两条产品线）：'
              + '给一段**自然语言描述**，直接生成音频，可用于音效、配音、有声书、氛围音。按音频时长计费。'
              + '**注意：这个模型没有"音色"参数** —— 想指定音色请用 ark_speak（TTS）。'
              + '想影响生成结果只有两条路：① 在 textPrompt 里用文字描述声音（如"温柔清澈的少女嗓音"）；'
              + '② 传参考素材（音频最多 3 条，或一张图）让模型照着生成。'
              + '输出内容带随机性，同一描述每次结果都不同。需要语音 API Key（X-Api-Key 鉴权）。' + DELIVERY_NOTE,
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
                result.referenceCount > 0 ? `参考素材：${result.referenceCount} 条` : '',
                result.requestId ? `request_id: ${result.requestId}` : '',
                // 预览地址**永远最后一行**（见 previewLine 注释）
                previewLine([result.audio]),
              ]
                .filter(Boolean)
                .join('\n')
            }),
          }),
      )

      gateTool('ark_transcribe',
          defineTool({
            name: 'ark_transcribe',
            description:
              '把音频文件转写成文字（语音识别 / ASR），返回全文与分句时间戳。按音频时长计费。'
              + '音频路径必须在工作区内。需要新版语音 API Key（X-Api-Key 鉴权）。'
              + '支持 mp3 / wav / ogg / pcm 等常见容器。' + DELIVERY_NOTE,
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
      )

      gateTool('ark_generate_video',
          defineTool({
            name: 'ark_generate_video',
            description:
              '用火山方舟 Seedance 模型生成视频（文生视频 / 图生视频）。**按秒计费且单价高**，'
              + '提交即产生费用。任务默认异步：立即返回 taskId，再用 action="status" 查询进度'
              + '（查询不产生新费用，且会在任务完成时把产物下载到工作区）。'
              + '视频直链 24 小时失效，所以成功后会自动下载。' + DELIVERY_NOTE,
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
      gateTool('ark_generate_3d',
          defineTool({
            name: 'ark_generate_3d',
            description:
              '用火山方舟 Seed3D 模型从**一张图片**生成 3D 模型（图生 3D）。按次计费，提交即产生费用。'
              + '任务异步：立即返回 taskId，再用 action="status" 查询进度（查询不产生新费用，'
              + '且会在完成时把模型下载到工作区）。实测耗时约 7~8 分钟；产物为 glb，'
              + '上游以 ZIP 打包返回，本工具会自动解包并校验后再落盘。' + DELIVERY_NOTE,
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
      )

      // 引用一下，表明这些 disposer 是**故意持有**而不是漏用。

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
      gateTool('ark_credential_status',
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

              /**
               * 能力开关的**运行时自述**。
               *
               * 为什么把它放进这个只读工具、而不是只写日志：能力开关"没生效"的
               * 失败模式有四种，在页面上长得**完全一样**（工具照旧在）。把它们
               * 自述出来，就能用一次零计费调用直接判定，不必让用户翻日志或找文件。
               *
               * `rebuiltAt` / `rebuildCount` 是关键：它们证明
               * `loader/volatile-update` 到底有没有触发过重建。
               */
              lines.push('')
              lines.push('# 能力开关（运行时自述）')
              const capsNow = liveCaps()
              for (const [key, on] of Object.entries(capsNow)) {
                lines.push(`- ${key}：${on === false ? '**关闭**' : '开启'}`)
              }
              lines.push(`- 当前已注册工具：${registeredNames.join(', ') || '（无）'}`)
              lines.push(`- 重建次数：${rebuildCount}（apply 时 1 次；每次开关变更 +1）`)
              lines.push(`- 最后一次重建：${lastRebuildAt || '—'}`)
              /**
               * 收到过的事件名 —— 这一格是"事件链路有没有通"的唯一直接证据。
               *
               * 为什么必须自述出来：`loader/volatile-update` 没送到插件，与
               * "配置没读到"，在页面上长得**完全一样**（工具照旧在），
               * 而 Cordis 的事件派发带 fiber 过滤，监听注册在哪个 ctx 上
               * 会决定收不收得到 —— 从文档看不出来，只能实测。
               */
              lines.push(
                `- 收到过的事件：${eventsSeen.size > 0 ? [...eventsSeen].join(' | ') : '（一个都没有）'}`,
              )
              lines.push(
                `- 宿主传入的原始 capabilities：${JSON.stringify(config?.capabilities ?? null)}`
                + `（config 键：${config && typeof config === 'object' ? Object.keys(config).join(', ') : typeof config}）`,
              )
              return lines.join('\n')
            }),
          }),
      )

      /**
       * 定义登记完了，按当前开关注册第一批。
       *
       * 之后每次 `loader/volatile-update`（用户在设置页翻开关）都会再调一次
       * `rebuildTools()` —— 那才是"关掉的能力其工具真的消失"生效的时刻。
       */
      rebuildTools()
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
              // ⚠️ MIME 必须走白名单（安全审计 F5）。
              //
              // `found.entry.mime` 最终可能来自**上游响应头**（视频/图片路径在魔数认不出时
              // 会直接用上游 content-type），而本路由与 DSH GUI **同源**
              // （http://127.0.0.1:19387）。若登记表里出现一个 `text/html` 的产物，
              // 用户点开预览地址就是在 DSH 源上渲染上游内容 → 对 harness 的存储型 XSS
              // （可经同源 API 操作会话与配置）。
              //
              // 触发需要上游被控制/劫持，属纵深防御缺口，但修起来只要一行，没理由不修。
              'Content-Type': safePreviewMime(found.entry.mime),
              'Content-Length': String(bytes.byteLength),
              // nosniff：即便 MIME 判断出错，也不让浏览器改按内容嗅探成可执行类型。
              'X-Content-Type-Options': 'nosniff',
              // attachment：预览走的是 <img>/<video> 这类子资源，不需要内联渲染 HTML；
              // 对非媒体类型强制下载语义，进一步掐掉"在源上渲染"的可能。
              'Content-Disposition': 'attachment',
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

/**
 * 插件 Config schema 的**具名导出**。
 *
 * DSH 用它来定义"这个插件有哪些可配置字段"，设置页的表单绑定也以它为契约：
 * 字段名必须与 `resolveCapabilities` 读的路径一致（`capabilities.<name>`），
 * 否则页面把值写到 A、host 从 B 读，**两边都不报错**，表现为"勾了没反应"。
 *
 * ⚠️ 但**光有具名导出不够** —— 真正被 Cordis 读到的是**默认导出对象上的
 * `Config` 属性**（见上面 `export default` 里 `Config,` 那一行的长注释）。
 * 这行具名导出保留，是为了让本模块"导出了 Config"这件事在源码和测试里显式可见；
 * 只写它、不挂到默认对象上，正是曾经导致设置页开关全灰的那个 bug。
 */
export { Config }

