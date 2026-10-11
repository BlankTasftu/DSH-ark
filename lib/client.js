/**
 * dsh-ark 的浏览器半侧：插件设置页，用来填三把密钥。
 *
 * ─── 为什么长这样（几处不显然但必须遵守的约定）────────────────────────────
 * 1. **文件形态是约定，不是打包产物。** DSH 的客户端模块系统按
 *    `window.__ModuleLoader__.load({ id, factory })` 收取每个插件 bundle：执行它
 *    只注册 factory，模块副作用留到真正 import 时。`dsh.client.platform = 'web'`
 *    指向本文件，宿主在 `/plugins` 下按包名提供它。
 * 2. **只能 require externals 里声明过的东西。** 基座（React、Cordis、静态 UI 库）
 *    之外每个请求都必须在 `dsh.client.inject` 里点名，否则组合阶段会拒绝：
 *    请求被解析到"指定的动态包 row 或完全匹配的静态表键"，两者都不是就报错。
 *    本文件只 require 三个：`react`、`react/jsx-runtime`、
 *    `@deepseek-ai/dsh-client-ui-primitives`（后者的表单控件是官方配置页同款）。
 *    注意 `configForms` 是 **Cordis 服务**（`inject:` 数组里声明、`ctx` 上取用），
 *    不是 require 的模块 —— 两者别混。
 * 3. **页面挂在 bundle 自己的详情页上。** `plugins.item` 是"官方"分组，第三方
 *    注册进去会冒充官方插件；自己的配置要注册 `plugins.bundle.config`
 *    （以安装的包名为键），页面上显示在「插件 → 已安装 → 本插件」详情页里。
 * 4. **密钥走凭据域，不进设置文件。** `remote.credentials.set(ref, value)` 写、
 *    `describe([ref])` 只回"是否已配置/是否可写"，明文永不出现在任何响应里。
 * 5. **能力开关走 `configForms`，写进 profile 补丁的 config 块。** 持久化、
 *    revision 栅栏、断线重连后的重读都由 DSH 的配置表单负责，本文件不自建。
 *
 * ─── 两个凭据名 ────────────────────────────────────────────────────────────
 * 必须与宿主半侧 `lib/config.mjs` 的默认值完全一致，否则页面填的密钥工具读不到：
 *   ARK_API_KEY                  方舟：图像 / 视频
 *   VOLCENGINE_SPEECH_API_KEY    语音技术：合成 / 识别 / 音频生成
 * 二者是**不同产品**的凭据，互不通用（方舟的 Key 不能用于语音）。
 * 这里刻意**硬编码**而不是从宿主读：客户端包不能依赖宿主包（官方注释明确要求），
 * 而这两个名字是插件的对外契约，改它们属于破坏性变更。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ark',

  factory: (require) => {
    var __modules = Object.create(null)
    var __cache = Object.create(null)

    __modules['./index.js'] = function (module, exports, require, __load_) {
      'use strict'
      Object.defineProperty(exports, '__esModule', { value: true })

      const jsxRuntime = require('react/jsx-runtime')
      const React = require('react')
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      const h = jsxRuntime.jsx
      const hs = jsxRuntime.jsxs

      // ────────────────────────────────────────────────────────────── 常量

      /** 本 bundle 的展示名与 i18n 命名空间。 */
      const NS = 'dshArk'
      /** 本 bundle 的包名：`plugins.bundle.config` 按它派发。 */
      const PACKAGE_NAME = 'dsh-ark'
      /**
       * 本 bundle 在 profile 补丁里的**行 id**（`cordis.patch.yml` 的 `id: dsh-ark`）。
       *
       * ⚠️ 这个值与 `PACKAGE_NAME` 恰好相同，但**语义不同，别合并**：
       *   · `PACKAGE_NAME` 用于 `plugins.bundle.config` 的派发键；
       *   · `ENTRY_ID` 用于 `ctx.configForms.get()` 的 namespace。
       *
       * 而且命名空间**只能是它**，不能换成加载器的 entry id。加载器里这一行是
       * `{ id: 'include:dsh-ark', patchId: 'dsh-ark' }`，而宿主 `settings` 服务
       * 一律按 **`entry.options.id`**（= `patchId` = `dsh-ark`）登记表单与解析写入：
       *
       * ```js
       * describe() { ... return [{ ns: entry.options.id, ... }] }
       * write(ns) { configEditor.entries().find((row) => row.options.id === ns) }
       * ```
       *
       * 传 `'include:dsh-ark'` 不会报错，只会拿到一个**永远不会 ready** 的 scope ——
       * 页面显示"插件当前未加载"，看起来像插件坏了。所以这里保留独立常量。
       */
      const ENTRY_ID = 'dsh-ark'

      /**
       * 两把密钥的定义。`required: true` 的缺失会让整页显示一个醒目标记，
       * 因为缺它对应的一整类工具都用不了（图像/视频 vs 语音）。
       *
       * 注意两者是**不同产品**的凭据，互不通用：
       *  - ARK_API_KEY：方舟，管图像与视频
       *  - VOLCENGINE_SPEECH_API_KEY：语音技术，管合成 / 识别 / 音频生成
       */
      const SECRETS = [
        {
          field: 'arkKey',
          ref: 'ARK_API_KEY',
          labelKey: 'arkKey',
          hintKey: 'arkKeyHint',
          group: 'ark',
          required: true,
        },
        {
          // 语音只走新版鉴权：只发 X-Api-Key
          field: 'speechApiKey',
          ref: 'VOLCENGINE_SPEECH_API_KEY',
          labelKey: 'speechApiKey',
          hintKey: 'speechApiKeyHint',
          group: 'speech',
          required: true,
        },
      ]

      /**
       * 设置页的能力开关清单。
       *
       * ⚠️ **必须与宿主侧 `lib/config.mjs` 的 `CAPABILITIES` 键一一对应。**
       * 这不是重复声明图省事，而是客户端包**不能**依赖宿主包（DSH 官方注释明确
       * 要求：client package must not depend on a Host package），所以两边各写一份。
       * `tests/capabilities.test.mjs` 会从两端各自"提取"键名再比对，少一个/多一个
       * 都会失败 —— 否则症状是"页面关不掉某个工具"或"页面上有一项点了没用"。
       *
       * 只写 `key`：label/hint 走 i18n 字典（`cap_<key>` / `cap_<key>_hint`），
       * 这样中文说明能随字典一起改，而不是像宿主那样把中文焊在代码里。
       */
      const CAPABILITY_KEYS = [
        'image',
        'video',
        'threeD',
        'speech',
        'audio',
        'transcribe',
        'credentialStatus',
      ]

      // ──────────────────────────────────────────────────────────── 文案

      const zh = {
        title: '火山方舟',
        description: '配置图像/视频生成与语音能力（合成、识别、音频生成）所需的密钥。',
        summary: '密钥在插件详情页里配置。',

        arkSection: '方舟（图像 / 视频）',
        arkSectionHint: '一个 API Key 覆盖 Seedream 图像与 Seedance 视频。',
        speechSection: '语音（合成 / 识别 / 音频生成）',
        speechSectionHint:
          '语音走火山「语音技术」，需要它自己的 API Key —— 与方舟的 Key 是两套，互不通用。'
          + '合成、识别、音频生成三项能力都由这一个 Key 覆盖。',
        speechApiKey: '语音 API Key',
        speechApiKeyHint:
          '语音技术控制台 → API Key 管理。只发 X-Api-Key（App ID + Access Token 那套旧凭据已不再使用）。',

        arkKey: 'Ark API Key',
        arkKeyHint: '火山方舟控制台 → API Key 管理。保存后不回显。',

        configured: '已配置',
        missing: '未配置',
        readOnlyValue: '该密钥由启动进程的环境变量提供，只能在启动 DSH 的终端里修改。',
        storageReadOnly: '本部署的凭据存储是只读的，无法在此保存。',
        unavailable: '插件当前未加载，暂时无法配置。',

        save: '保存',
        saving: '保存中…',
        saveFailed: '没有保存成功，输入已保留，请检查后重试。',
        savedHint: '已保存，立即生效，无需重启。',
        nothingToSave: '还没有填写任何内容。',
        blankKeeps: '留空表示保持现有密钥不变。',
        secretScopeHint: '这个按钮只保存上面的密钥。能力开关是点一下即存，不受它影响。',

        warningMissingArk: '缺少 Ark API Key：图像、视频、3D 三类工具都会失败。',
        warningMissingSpeech: '缺少语音凭据：语音合成、音频生成、语音转写工具都会失败。',

        capSection: '能力开关',
        capSectionHint:
          '关掉用不到的能力，它的工具就**不会被注册**，也就不进模型的工具表 —— '
          + '省 token，也让模型不会去调一个你不想付费的能力。'
          + '开关是**点一下即存**，与上面的「保存」按钮无关。',
        capOn: '已开启',
        capOff: '已关闭',
        capUnavailable:
          '插件当前未加载它的配置行，暂时无法保存开关（下面的状态可能不是最新的）。',
        capReadOnly: '本部署的插件配置不可写，开关无法保存。',
        capBusy: '正在保存…',
        capSaved: '开关已保存。',
        capFailed: '保存失败，显示的是仍生效的值。',
        capWriteFailed: '保存没有成功，显示的是仍生效的值。',
        capNoChange: '点一下开关即可保存，无需其他操作。',
        capLive: '已保存，工具表已即时更新（不需要重启或重载插件）。',

        cap_image: '图像生成',
        cap_image_hint: 'Seedream 文生图 / 参考图生图 / 指令编辑',
        cap_video: '视频生成',
        cap_video_hint: 'Seedance 文生视频 / 图生视频（按秒计费，单价最高）',
        cap_threeD: '图生 3D',
        cap_threeD_hint: 'Seed3D 从一张图生成 glb 模型（按次计费，约 7~8 分钟）',
        cap_speech: '语音合成',
        cap_speech_hint: '豆包语音合成 2.0（TTS），长文本自动分句',
        cap_audio: '音频生成',
        cap_audio_hint: 'SeedAudio 1.0 按描述生成音频（音效 / 配音 / 氛围音）',
        cap_transcribe: '语音转写',
        cap_transcribe_hint: '语音识别（ASR），返回全文与毫秒级分句时间戳',
        cap_credentialStatus: '凭据自检工具',
        cap_credentialStatus_hint: '只读自检（零计费、零网络），排障时有用，一般不必关',

        howTo: '也可以直接写入 DSH 凭据文件',
        // ⚠️ 数量由 SECRETS **算出来**，不要写死。
        // 这里曾写"加三行"，而凭据早已只剩两把（App ID / Access Token 那套被移除）——
        // 写死的数字必然随改动过期，而用户会照着它去找第三个名字。
        howToBody:
          `在 $DSH_HOME/.credentials.yaml 的 refs: 段下加 ${SECRETS.length} 行`
          + '（名字必须与上面一致）。',
      }

      const en = {
        title: 'Volcengine Ark',
        description: 'Configure the keys used by image/video generation and speech (synthesis, recognition, audio generation).',
        summary: 'Keys are configured on this plugin’s detail page.',

        arkSection: 'Ark (image / video)',
        arkSectionHint: 'One API key covers Seedream images and Seedance video.',
        speechSection: 'Speech (synthesis / recognition / audio generation)',
        speechSectionHint:
          'Speech uses Volcengine Speech, which needs its own API key — a different credential from the Ark key. '
          + 'One key covers synthesis, recognition and audio generation.',

        speechApiKey: 'Speech API key',
        speechApiKeyHint:
          'Volcengine Speech console → API keys. Only X-Api-Key is sent (the legacy App ID + Access Token pair is no longer used).',
        arkKey: 'Ark API key',
        arkKeyHint: 'Volcengine Ark console → API keys. Never echoed back after saving.',
        configured: 'Configured',
        missing: 'Not configured',
        readOnlyValue: 'This key comes from the launching process environment; change it there.',
        storageReadOnly: 'This deployment stores credentials read-only.',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'Nothing was saved; your input was kept for you to correct.',
        savedHint: 'Saved. It takes effect immediately, no restart needed.',
        nothingToSave: 'Nothing has been entered yet.',
        blankKeeps: 'Leave blank to keep the current key.',
        secretScopeHint: 'This button saves only the keys above. Capability switches save on the spot and do not use it.',

        warningMissingArk: 'No Ark API key: image, video and 3D tools will fail.',
        warningMissingSpeech: 'No speech API key: synthesis, audio generation and transcription will fail.',

        capSection: 'Capabilities',
        capSectionHint:
          'Turn off what you do not use: its tools are then not registered at all, so they stay out of '
          + 'the model’s tool list — fewer tokens, and no way to trigger a capability you do not want to pay for. '
          + 'Each switch saves on the spot; the Save button above does not apply to them.',
        capOn: 'On',
        capOff: 'Off',
        capUnavailable: 'This plugin’s configuration row is not loaded, so toggles cannot be saved.',
        capReadOnly: 'This deployment stores plugin configuration read-only; toggles cannot be saved.',
        capBusy: 'Saving…',
        capSaved: 'Capabilities saved.',
        capFailed: 'Save failed; the values shown are the ones still in effect.',
        capWriteFailed: 'Nothing was saved; the values shown are the ones still in effect.',
        capNoChange: 'Flip a switch to save it — nothing else to do.',
        capLive: 'Saved — the tool table updated immediately (no restart or reload needed).',

        cap_image: 'Image generation',
        cap_image_hint: 'Seedream text-to-image / reference-image / instruction editing',
        cap_video: 'Video generation',
        cap_video_hint: 'Seedance text-to-video / image-to-video (billed per second, the priciest tier)',
        cap_threeD: 'Image to 3D',
        cap_threeD_hint: 'Seed3D builds a glb model from one image (per call, ~7–8 minutes)',
        cap_speech: 'Speech synthesis',
        cap_speech_hint: 'Doubao TTS 2.0; long text is split into sentences automatically',
        cap_audio: 'Audio generation',
        cap_audio_hint: 'SeedAudio 1.0 generates audio from a description (SFX / dubbing / ambience)',
        cap_transcribe: 'Transcription',
        cap_transcribe_hint: 'ASR: full text plus millisecond sentence timestamps',
        cap_credentialStatus: 'Credential self-check tool',
        cap_credentialStatus_hint: 'Read-only check (no cost, no network); useful for troubleshooting, rarely worth turning off',

        howTo: 'Or write DSH’s credentials file directly',
        howToBody: 'Add the lines under the refs: section of $DSH_HOME/.credentials.yaml.',
      }

      // ─────────────────────────────────────────────────── 极简快照 store

      /**
       * 一个够用就好的可订阅快照：React 侧用 useSyncExternalStore 订阅。
       * 不引第三方状态库 —— 客户端包每多一个 require 就要多声明一个 external，
       * 而这里只有"几个字符串 + 几个布尔"要同步。
       */
      function createStore(initial) {
        let value = initial
        const listeners = new Set()
        /**
         * 已注销的监听器包装。
         *
         * 为什么不直接把组件给的回调塞进 Set：`useSyncExternalStore` 在 StrictMode
         * 与每次重连时都会"先注销、再订阅"同一个回调，注销可能被调用多次。
         * 直接存原始回调的话，第二次注销会把**当前仍然有效**的那个删掉，
         * 页面从此不再跟着 store 更新（静默失效，没有任何报错）。
         * 所以每个回调包一层自己的开关，注销只关自己那一个。
         */
        const wrap = (fn) => {
          let alive = true
          const managed = () => {
            if (alive) fn()
          }
          managed.close = () => {
            alive = false
            listeners.delete(managed)
          }
          return managed
        }
        return {
          get: () => value,
          set(next) {
            value = next
            // 先快照再通知：回调里再次 set 时不应影响本轮遍历。
            for (const fn of [...listeners]) fn()
          },
          subscribe(fn) {
            const managed = wrap(fn)
            listeners.add(managed)
            // ⚠️ 必须是**语句块**而不是箭头简写：`() => listeners.delete(fn)` 返回的是
            // `Set.delete` 的布尔结果，而 React 的 useSyncExternalStore 要求
            // subscribe 返回一个函数（卸载时调用）。返回布尔会在清理阶段抛
            // "destroy is not a function"。
            return () => {
              managed.close()
            }
          },
        }
      }

      // ─────────────────────────────────────────────────────────── 控制器

      /**
       * 设置页的状态机：读凭据状态、暂存草稿、按保存写入。
       *
       * 刻意**不做**乐观更新：写成功与否一律以 `describe` 回读为准 ——
       * 凭据可能被别处（Models 页 / 环境变量 / 手改文件）改写，本地猜测会撒谎。
       */
      class ArkSettingsController {
        constructor(ctx) {
          this.ctx = ctx
          /** 每个 ref 的权威状态：是否已配置、是否可写。 */
          this.credentials = new Map()
          /** 暂存的草稿文本（只在内存里，离开页面即丢）。 */
          this.drafts = new Map()
          this.saving = false
          this.failed = false
          this.statusLine = ''
          this.store = createStore(this.snapshot())
        }

        /** 对外发布的只读快照。 */
        snapshot() {
          const fields = {}
          let dirty = false
          for (const secret of SECRETS) {
            const state = this.credentials.get(secret.ref) ?? {
              configured: false,
              writable: true,
              known: false,
            }
            const text = this.drafts.get(secret.field) ?? ''
            if (text.length > 0) dirty = true
            fields[secret.field] = {
              text,
              configured: state.configured,
              writable: state.writable,
              known: state.known,
            }
          }
          return {
            fields,
            dirty,
            saving: this.saving,
            failed: this.failed,
            statusLine: this.statusLine,
            writable: [...SECRETS].every(
              (s) => (this.credentials.get(s.ref) ?? { writable: true }).writable,
            ),
            missingRequired: SECRETS.filter(
              (s) => s.required && !(this.credentials.get(s.ref) ?? { configured: false }).configured,
            ).map((s) => s.ref),
          }
        }

        publish() {
          this.store.set(this.snapshot())
        }

        /** 记一笔草稿。 */
        edit(field, text) {
          this.drafts.set(field, text)
          this.failed = false
          this.statusLine = ''
          this.publish()
        }

        /** 丢弃全部草稿。 */
        discard() {
          this.drafts.clear()
          this.failed = false
          this.statusLine = ''
          this.publish()
        }

        /**
         * 回读一个 ref 的权威状态。
         *
         * 只有当响应回来时该 ref **仍然**是我们要问的那个才发布 ——
         * 两次读取可能乱序返回，用旧响应覆盖新状态会让标记显示错误的事实。
         */
        async readCredential(ref) {
          let response
          try {
            response = await this.ctx.remote.credentials.describe([ref])
          } catch {
            return // 读不到就保持现状，不要把"网络抖动"显示成"未配置"
          }
          if (!response || !response.ok) return
          const view = response.value ? response.value[ref] : undefined
          this.credentials.set(ref, {
            configured: view ? view.configured === true : false,
            writable: view ? view.writable !== false : true,
            known: true,
          })
          this.publish()
        }

        /** 回读全部三把。 */
        async readAll() {
          await Promise.all(SECRETS.map((s) => this.readCredential(s.ref)))
        }

        /** 宿主报告某个 ref 变了（可能是从别处改的）→ 跟读。 */
        refresh(ref) {
          if (!SECRETS.some((s) => s.ref === ref)) return
          void this.readCredential(ref)
        }

        /**
         * 保存：把每个非空草稿写进凭据域。
         *
         * 空草稿**不写**（等于"保持不变"）—— 密钥是密文控件、保存后不回显，
         * 若把空串当"清空"，用户每次保存都会误删没动的密钥。
         * 清空要走 unset，本页不提供该操作（避免误删；需要清空时改凭据文件）。
         */
        async save() {
          if (this.saving) return
          const pending = SECRETS.map((s) => ({ secret: s, text: this.drafts.get(s.field) ?? '' })).filter(
            (item) => item.text.length > 0,
          )
          if (pending.length === 0) {
            this.statusLine = 'nothingToSave'
            this.publish()
            return
          }
          this.saving = true
          this.failed = false
          this.statusLine = ''
          this.publish()
          let wrote = 0
          try {
            for (const { secret, text } of pending) {
              const response = await this.ctx.remote.credentials.set(secret.ref, text)
              if (!response || !response.ok) {
                this.failed = true
                continue
              }
              // 只有确认写成功才丢弃草稿，否则用户输入会凭空消失。
              this.drafts.delete(secret.field)
              wrote += 1
            }
          } catch {
            this.failed = true
          } finally {
            this.saving = false
            await this.readAll()
            if (!this.failed) this.statusLine = wrote > 0 ? 'savedHint' : ''
            this.publish()
          }
        }
      }

      // ────────────────────────────────────────────────── 能力开关控制器

      /**
       * 能力开关：读写 profile 里本插件那一行的 `config.capabilities`。
       *
       * ## 为什么用 `ctx.configForms` 而不是自己开一条远程通道
       *
       * `configForms.get(entryId)` 返回的是 DSH 官方设置表单共用的那个 scope：
       * 它自带 revision 栅栏（并发写不会互相覆盖）、断线重连后的重读、
       * 以及"写失败就把已接受的值读回来"的恢复路径。自己经 `remote` 再包一层，
       * 等于把这些重新实现一遍，而且很可能实现错。
       *
       * ## 为什么是"整块写"而不是"改一个键"
       *
       * 写入的形状是 `{ capabilities: { <只含被关掉的键>: false } }` —— **整体替换**
       * 那个子对象，而不是逐键 merge。因为"把某项从关改回开"必须能**删掉**那个
       * `false` 键：逐键 merge 删不掉键，结果就是"改回开"永远不生效。
       * 只写被关掉的项（不写一堆 `true`）是为了不让用户的配置文件长满噪音。
       *
       * 语义上与宿主 `lib/config.mjs` 的 `resolveCapabilities` 严格对齐：
       * **只有显式 `false` 表示关闭，不写 = 开启**；未知键忽略。
       */
      class CapabilityController {
        /**
         * @param ctx - 浏览器半侧的 Cordis 上下文
         * @param entryId - 本插件在 profile 补丁里的行 id（= 设置表单的 namespace）
         */
        constructor(ctx, entryId) {
          this.scope = ctx.configForms.get(entryId)
          this.saving = false
          this.failed = false
          /** 最近一次写入是否**拿到过**成功回执 —— 用来决定要不要提示"需重载"。 */
          this.wroteSinceApply = false
          this.store = createStore(this.snapshot())
          // scope 每次变化（本地写入、别处改配置、断线重连）都重新发布投影。
          this.unsubscribe = this.scope.subscribe(() => this.publish())
        }

        /** 当前 scope 快照（status/value/writable/revision 由 DSH 维护）。 */
        snapshotOfScope() {
          return this.scope.getSnapshot()
        }

        /**
         * 对外发布的只读快照。
         *
         * `value.capabilities` 是**已合并默认值**的完整 7 项（DSH 的 projectForm 用
         * schema 默认值补齐缺失字段），所以这里不需要再补 true —— 但真缺字段时
         * 仍然兜底成 true，因为"读不到"绝不该显示成"已关闭"。
         */
        snapshot() {
          const scope = this.snapshotOfScope()
          const raw = scope && scope.value ? scope.value.capabilities : undefined
          const values = {}
          for (const key of CAPABILITY_KEYS) {
            values[key] = raw && typeof raw === 'object' && raw[key] === false ? false : true
          }
          const ready = scope.status === 'ready'
          return {
            keys: CAPABILITY_KEYS,
            values,
            ready,
            writable: ready && scope.writable === true,
            saving: this.saving,
            failed: this.failed,
            wroteSinceApply: this.wroteSinceApply,
            offCount: CAPABILITY_KEYS.filter((k) => values[k] === false).length,
          }
        }

        publish() {
          this.store.set(this.snapshot())
        }

        /** 组件卸载时释放对 scope 的订阅。 */
        dispose() {
          if (typeof this.unsubscribe === 'function') this.unsubscribe()
        }

        /**
         * 翻一项。
         *
         * ## 为什么是逐键 `mutate` 而不是 `set('capabilities', {...})`
         *
         * 这是本功能最容易写错的地方，而且**错了不会报错，只会静默不保存**：
         *
         * 宿主的 `settings.write()` 对每条被写的路径都过一遍
         * `isVolatilePath(schema, path)`，不通过就抛
         * `Config field "capabilities" is not volatile`：
         *
         * ```js
         * function isVolatilePath(schema, path) {
         *   if (schema.meta.volatile) return true
         *   const [key, ...rest] = path
         *   const child = key === undefined ? undefined : schema.dict?.[key]
         *   return child !== undefined && isVolatilePath(child, rest)
         * }
         * ```
         *
         * 本插件的 schema 里 **`.volatile()` 只打在叶子上**（`capabilities.<name>`），
         * 外层 `capabilities` 对象本身**不是** volatile。所以：
         *   · `set('capabilities', {...})` → path 是 `['capabilities']` → **被拒**；
         *   · `mutate([{ op, path: ['capabilities', <key>] }])` → 命中的是叶子 → 通过。
         *
         * 另外 `ConfigForm.set()` 的契约是"**scalar** field"（它拼的是
         * `path: [field]`），拿它写一个对象字段本来就不在契约内。
         *
         * ## 为什么"改回开"用 `unset` 而不是写 `true`
         *
         * 写 `true` 会在用户的 profile 补丁里留下一个显式 `true` —— 语义上等价，
         * 但将来新增能力时，旧配置里那些 `true` 会让人分不清"用户开的"还是"默认开"。
         * `unset` 走继承值（叶子默认 `true`），既回到"无覆盖"状态，效果也一样。
         *
         * ## 为什么不做乐观更新
         *
         * 开关先自己翻过去、写失败再翻回来，中间那段时间页面显示的是一个并不生效的
         * 状态 —— 而这里恰恰是"以为关了其实还开着"最危险的地方。显示一律以 scope 为准。
         *
         * @param key - 能力名
         * @param enabled - 用户想要的状态
         */
        async setEnabled(key, enabled) {
          if (this.saving) return
          if (!CAPABILITY_KEYS.includes(key)) return
          const scope = this.snapshotOfScope()
          // status 必须是 'ready'：宿主没提供这个 namespace 时（例如插件刚改过
          // Config 而宿主还没重载），描述符根本不存在，写必然失败。
          if (scope.status !== 'ready' || scope.writable !== true) return

          const want = enabled === true
          const current = this.snapshot().values
          // 逐键构造：每条的路径都是 ['capabilities', <key>]，正好落在 volatile 叶子上。
          // 没被翻的那些键保持原样（该 unset 的 unset、该 false 的 false），
          // 这样一次 mutate 就能把"用户看到的完整状态"整体写对。
          const ops = CAPABILITY_KEYS.map((k) => {
            const on = k === key ? want : current[k] !== false
            return on
              ? { op: 'unset', path: ['capabilities', k] }
              : { op: 'set', path: ['capabilities', k], value: false }
          })

          this.saving = true
          this.failed = false
          this.publish()
          try {
            const ok = await this.scope.mutate(ops)
            if (ok === false) this.failed = true
            else this.wroteSinceApply = true
          } catch {
            this.failed = true
          } finally {
            this.saving = false
            // 写失败时 scope 自己已经重读过宿主状态，这里再发布一次是为了
            // 让 saving/failed 这两个**本地**标记也一起进快照。
            this.publish()
          }
        }
      }

      // ──────────────────────────────────────────────────────────── 组件

      /**
       * 一行能力开关：左边标题 + 说明，右边 Switch。
       *
       * 与 `SettingsSecretField` 不同，`Switch` 是**完全受控**的：它自己不持有状态，
       * `checked` 一律来自 scope 快照。写进行中统一 `disabled`，避免同一秒内
       * 连点两次发出两个带同一 revision 的写（第二个必然被拒）。
       *
       * 右侧除了 Switch 还带一行**明确的状态文字**（"已开启 / 已关闭 / 保存中"）：
       * 单看一个开关的滑块位置，很容易分不清"关"是因为我关了它、还是它压根没生效。
       * 文字把这件事说死，也顺带给出写入过程的可见反馈。
       */
      function CapabilityRow(props) {
        const { t, cap, on, busy } = props
        const disabled = busy || props.disabled === true
        const stateText = busy
          ? t('capBusy')
          : props.checked === true
            ? t('capOn')
            : t('capOff')
        const stateColor =
          props.checked === true
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-label-secondary)'
        return hs('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '10px 0',
            borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
          },
          children: [
            hs('div', {
              style: { minWidth: 0 },
              children: [
                h('div', {
                  style: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)' },
                  children: t(`cap_${cap}`),
                }),
                h('div', {
                  style: {
                    marginTop: '2px',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: t(`cap_${cap}_hint`),
                }),
              ],
            }),
            hs('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexShrink: 0,
              },
              children: [
                h('span', {
                  // 状态文字也要能被读到：写进行中用 aria-live 让辅助技术跟着播报。
                  ...(busy ? { 'aria-live': 'polite' } : {}),
                  style: { fontSize: '12px', color: stateColor, minWidth: '3.5em', textAlign: 'right' },
                  children: stateText,
                }),
                h(primitives.Switch, {
                  checked: props.checked === true,
                  label: t(`cap_${cap}`),
                  disabled,
                  title: disabled && props.disabled === true ? t('capReadOnly') : undefined,
                  onChange: (next) => on(cap, next),
                }),
              ],
            }),
          ],
        })
      }

      /**
       * 能力开关分组。
       *
       * 这一块**没有保存按钮**：开关是一次点击就落地的偏好，而不是一份要先攒起来
       * 再提交的表单。这和 DSH 官方同类行（如会话日志上传）的行为一致；
       * 上面的密钥表单之所以有保存按钮，是因为密钥可能被填错、需要先看一眼再提交。
       *
       * 自己订阅 capabilities 的 store，而不是让父组件代读：`useSyncExternalStore`
       * 是 hook，**不能放在条件分支里**（父组件在 summary 视图会提前 return），
       * 而且开关的写入不该让整页（含密钥输入框的草稿）跟着重渲染。
       */
      function CapabilitySection(props) {
        const { t, controller } = props
        const state = React.useSyncExternalStore(
          controller.store.subscribe,
          controller.store.get,
          controller.store.get,
        )
        const disabled = !state.writable || !state.ready
        return hs(Section, {
          title: t('capSection'),
          hint: t('capSectionHint'),
          children: [
            !state.ready ? h(Notice, { key: 'cap-na', tone: 'warn', children: t('capUnavailable') }) : null,
            state.ready && !state.writable
              ? h(Notice, { key: 'cap-ro', tone: 'warn', children: t('capReadOnly') })
              : null,
            state.failed ? h(Notice, { key: 'cap-err', tone: 'error', children: t('capWriteFailed') }) : null,
            state.wroteSinceApply
              ? h(Notice, { key: 'cap-reload', tone: 'warn', children: t('capLive') })
              : null,
            h('div', {
              children: state.keys.map((cap) =>
                h(CapabilityRow, {
                  key: cap,
                  t,
                  cap,
                  checked: state.values[cap] === true,
                  off: state.values[cap] === false,
                  disabled,
                  busy: state.saving,
                  on: (key, next) => {
                    void controller.setEnabled(key, next)
                  },
                }),
              ),
            }),
            h('p', {
              style: { margin: '8px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: state.saving ? t('capBusy') : t('capNoChange'),
            }),
          ],
        })
      }

      /** 一个分组标题 + 说明。 */
      function Section(props) {
        return hs('section', {
          style: { marginTop: '18px' },
          children: [
            h('h3', {
              style: { margin: '0 0 4px', fontSize: '14px', color: 'var(--dsw-alias-label-primary)' },
              children: props.title,
            }),
            h('p', {
              style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: props.hint,
            }),
            props.children,
          ],
        })
      }

      /** 一个提示条（警告/成功/错误共用）。 */
      function Notice(props) {
        const tone = props.tone || 'warn'
        const color =
          tone === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : tone === 'success'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-warn-primary)'
        return h('p', {
          role: 'status',
          style: {
            margin: '0 0 10px',
            fontSize: '12px',
            lineHeight: 1.6,
            color,
            border: `1px solid ${color}`,
            borderRadius: '6px',
            padding: '8px 10px',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
          children: props.children,
        })
      }

      /** 设置页主体。`view === 'summary'` 时只给一行描述。 */
      function ArkSettingsPage(props) {
        const { t } = props
        const state = React.useSyncExternalStore(
          props.controller.store.subscribe,
          props.controller.store.get,
          props.controller.store.get,
        )
        if (props.view === 'summary') return t('summary')

        const readOnly = !state.writable
        const missingArk = state.missingRequired.includes('ARK_API_KEY')
        // 语音只有一条路（API Key）：缺了就是缺了，不再有"另一种方案可替代"。
        const missingSpeech = state.missingRequired.includes('VOLCENGINE_SPEECH_API_KEY')

        const field = (secret) => {
          const view = state.fields[secret.field] || {}
          return h(primitives.SettingsSecretField, {
            key: secret.field,
            id: `plugin-config-dsh-ark-${secret.field}`,
            label: t(secret.labelKey),
            hint: `${t(secret.hintKey)} ${t('blankKeeps')}`,
            disabled: readOnly || view.writable === false,
            text: view.text || '',
            configured: view.configured === true,
            stateLabel: view.configured ? t('configured') : t('missing'),
            onEdit: (text) => {
              props.controller.edit(secret.field, text)
            },
          })
        }

        // DSH 的 `SettingsForm` 把保存按钮**硬编码在 children 之后**（它自己渲染
        // `footer`），所以任何塞进 children 的内容都只能排在按钮**上面**。
        // 而能力开关与密钥是两组互不相干的偏好，把按钮夹在中间才对：
        //
        //   密钥输入 → 保存 → 能力开关
        //
        // 所以这里不用 `SettingsForm`，自己用 primitives 的 Button 排版。
        // `SettingsForm` 内部除了按钮还做一件事：**卸载时丢弃草稿**
        // （离开页面未保存的输入不留下）。下面用 useEffect 的清理函数补上，
        // 行为与它一致。
        React.useEffect(
          () => () => {
            props.controller.discard()
          },
          [],
        )

        const blocked = !state.dirty || state.saving
        const anyReadOnly = SECRETS.some(
          (s) => state.fields[s.field] && state.fields[s.field].writable === false,
        )

        /** 密钥区的动作行：保存 + 结果提示。放在密钥下面、能力开关上面。 */
        const secretActions = hs('div', {
          key: 'secret-actions',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginTop: '14px',
            paddingTop: '12px',
            borderTop: '0.5px solid var(--dsw-alias-border-l2)',
          },
          children: [
            h(primitives.Button, {
              variant: 'primary',
              disabled: blocked || readOnly,
              onClick: () => {
                void props.controller.save()
              },
              children: state.saving ? t('saving') : t('save'),
            }),
            // 提示优先级：失败 > 保存结果 > "还没填"。都要说清"和上面开关的关系"。
            h('span', {
              style: {
                fontSize: '12px',
                lineHeight: 1.6,
                color: state.failed
                  ? 'var(--dsw-alias-state-error-primary)'
                  : state.statusLine
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-secondary)',
              },
              children: state.failed
                ? t('saveFailed')
                : state.statusLine
                  ? t(state.statusLine)
                  : state.dirty
                    ? t('blankKeeps')
                    : t('secretScopeHint'),
            }),
          ],
        })

        return hs('div', {
          children: [
            missingArk ? h(Notice, { key: 'warn-ark', tone: 'warn', children: t('warningMissingArk') }) : null,
            missingSpeech
              ? h(Notice, { key: 'warn-speech', tone: 'warn', children: t('warningMissingSpeech') })
              : null,
            readOnly ? h(Notice, { key: 'ro-store', tone: 'warn', children: t('storageReadOnly') }) : null,
            // 有任何一个 ref 由环境变量提供时，说清楚为什么输入框是灰的。
            anyReadOnly ? h(Notice, { key: 'ro', tone: 'warn', children: t('readOnlyValue') }) : null,

            hs(Section, {
              key: 'ark',
              title: t('arkSection'),
              hint: t('arkSectionHint'),
              children: [field(SECRETS[0])],
            }),
            hs(Section, {
              key: 'speech',
              title: t('speechSection'),
              hint: t('speechSectionHint'),
              children: [field(SECRETS[1])],
            }),

            // 保存按钮紧跟它负责的密钥字段，在能力开关**之前**。
            secretActions,

            // 能力开关：与密钥无关的一组独立偏好。写在保存按钮下面，
            // 是为了让"哪些内容归这个按钮管"一眼可辨 —— 开关是点一下即存，
            // 与上面的保存按钮无关。
            props.capabilitiesController
              ? h(CapabilitySection, {
                  key: 'caps',
                  t,
                  controller: props.capabilitiesController,
                })
              : null,

            h('details', {
              key: 'howto',
              style: { marginTop: '16px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: [
                h('summary', { style: { cursor: 'pointer' }, children: t('howTo') }),
                h('p', { style: { margin: '6px 0 0', lineHeight: 1.6 }, children: t('howToBody') }),
                h('pre', {
                  style: {
                    margin: '6px 0 0',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-primary)',
                    overflowX: 'auto',
                  },
                  children: SECRETS.map((s) => `  ${s.ref}: "<值>"`).join('\n'),
                }),
              ],
            }),
          ],
        })
      }

      // ───────────────────────────────────────────────────── 插件入口

      /**
       * 需要的客户端服务。
       *
       * `configForms` 是 DSH 官方设置表单的共享配置面：`get(entryId)` 给出带
       * revision 栅栏的读写 scope。能力开关走它，**不需要**自己经 `remote` 再开
       * 一条通道 —— 官方同类页面（会话日志上传、语言、Shell）都是这么做的。
       */
      const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

      /**
       * 挂载设置页。
       * @param ctx - 浏览器半侧的 Cordis 上下文
       */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ark: 字典')
        const t = ctx.locale.bind(NS)

        const controller = new ArkSettingsController(ctx)
        void controller.readAll()

        // 能力开关走 DSH 官方设置表单的共享 scope（自带 revision 栅栏与重连重读）。
        // 它自己会订阅 scope，所以这里把释放也挂在 effect 上。
        const capabilities = new CapabilityController(ctx, ENTRY_ID)
        ctx.effect(() => () => capabilities.dispose(), 'dsh-ark: 能力开关订阅')

        // 别处改了同一个 ref（环境变量、Models 页、手改凭据文件）时跟读，
        // 否则页面上的"已配置/未配置"标记会一直停在旧结论上。
        ctx.effect(
          () =>
            ctx.remote.$on('credentials/reference-updated', (ref) => {
              controller.refresh(String(ref))
            }),
          'dsh-ark: 凭据失效跟随',
        )

        // 注册到本 bundle 自己的详情页（`plugins.bundle.config` 以包名为键）。
        // 不用 `plugins.item`：那是「官方」分组的座位，第三方占用会显示成官方插件。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PACKAGE_NAME,
                  locale: NS,
                  inject: () => ({ t, controller, view: 'page', capabilitiesController: capabilities }),
                },
                ArkSettingsPage,
              ),
            ),
          'dsh-ark: 设置页',
        )
      }

      // 导出必须在**最后**赋值：`inject` 是 `const`，在它初始化之前写
      // `exports.inject = inject` 会命中 TDZ 直接抛 ReferenceError
      // （`function apply` 是提升的所以没暴露问题，但统一放最后更安全）。
      exports.apply = apply
      exports.inject = inject
      exports.NS = NS
      return module.exports
    }

    // 供将来拆分多模块时使用（当前只有一个 ./index.js）。
    function __resolve(from, request) {
      if (!request.startsWith('.')) return request
      var parts = from.slice(2).split('/')
      parts.pop()
      for (var part of request.split('/')) {
        if (part === '.' || part === '') continue
        if (part === '..') parts.pop()
        else parts.push(part)
      }
      return './' + parts.join('/')
    }
    function __load(id) {
      if (__modules[id] === undefined) return require(id)
      if (__cache[id] !== undefined) return __cache[id].exports
      var module = (__cache[id] = { exports: {} })
      __modules[id](module, module.exports, require, function (request) {
        var resolved = __resolve(id, request)
        return __modules[resolved] === undefined ? require(request) : __load(resolved)
      })
      return module.exports
    }
    return __load('./index.js')
  },
})
