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
 * 3. **页面挂在 bundle 自己的详情页上。** `plugins.item` 是"官方"分组，第三方
 *    注册进去会冒充官方插件；自己的配置要注册 `plugins.bundle.config`
 *    （以安装的包名为键），页面上显示在「插件 → 已安装 → 本插件」详情页里。
 * 4. **密钥走凭据域，不进设置文件。** `remote.credentials.set(ref, value)` 写、
 *    `describe([ref])` 只回"是否已配置/是否可写"，明文永不出现在任何响应里。
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
      /** 本 bundle 在 profile 补丁里的行 id（`cordis.patch.yml` 的 `id:`）。 */
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

        warningMissingArk: '缺少 Ark API Key：图像、视频、理解三类工具都会失败。',
        warningMissingSpeech: '缺少语音凭据：语音合成工具会失败。',
        howTo: '也可以直接写入 DSH 凭据文件',
        howToBody:
          '在 $DSH_HOME/.credentials.yaml 的 refs: 段下加三行（名字必须与上面一致）。',
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

        warningMissingArk: 'No Ark API key: image and video tools will fail.',
        warningMissingSpeech: 'No speech API key: synthesis, recognition and audio generation will fail.',
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
        return {
          get: () => value,
          set(next) {
            value = next
            for (const fn of listeners) fn()
          },
          subscribe(fn) {
            listeners.add(fn)
            return () => listeners.delete(fn)
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

      // ──────────────────────────────────────────────────────────── 组件

      /** 表单外框的文案（SettingsForm 只认这几个键）。 */
      function formLabels(t) {
        return {
          unavailable: t('unavailable'),
          readOnly: t('storageReadOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        }
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

        // SettingsForm 的 state 契约：available 决定是否显示"未加载"，writable 决定只读提示，
        // dirty/invalid/saving 共同决定保存按钮是否可点。这里没有"无效输入"概念（都是自由文本），
        // 所以 invalid 恒为 false。
        const formState = {
          available: true,
          writable: !readOnly,
          dirty: state.dirty,
          invalid: false,
          saving: state.saving,
          failed: state.failed,
        }

        return hs(primitives.SettingsForm, {
          labels: formLabels(t),
          state: formState,
          onSave: () => {
            void props.controller.save()
          },
          onDiscard: () => {
            props.controller.discard()
          },
          children: [
            missingArk ? h(Notice, { key: 'warn-ark', tone: 'warn', children: t('warningMissingArk') }) : null,
            missingSpeech
              ? h(Notice, { key: 'warn-speech', tone: 'warn', children: t('warningMissingSpeech') })
              : null,
            state.statusLine
              ? h(Notice, {
                  key: 'status',
                  tone: state.failed ? 'error' : 'success',
                  children: t(state.statusLine),
                })
              : null,
            // 有任何一个 ref 由环境变量提供时，说清楚为什么输入框是灰的。
            SECRETS.some((s) => state.fields[s.field] && state.fields[s.field].writable === false)
              ? h(Notice, { key: 'ro', tone: 'warn', children: t('readOnlyValue') })
              : null,

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

      /** 需要的客户端服务。`remote.credentials` 由凭据域提供。 */
      const inject = ['slots', 'locale', 'remote', 'remote.credentials']

      /**
       * 挂载设置页。
       * @param ctx - 浏览器半侧的 Cordis 上下文
       */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ark: 字典')
        const t = ctx.locale.bind(NS)

        const controller = new ArkSettingsController(ctx)
        void controller.readAll()

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
                  inject: () => ({ t, controller, view: 'page' }),
                },
                ArkSettingsPage,
              ),
            ),
          'dsh-ark: 设置页',
        )

        // ENTRY_ID 目前只用于文档/排障对账：页面按包名派发，与行 id 无关。
        void ENTRY_ID
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
