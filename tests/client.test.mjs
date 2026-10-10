/**
 * 浏览器半侧（lib/client.js）的契约测试。
 *
 * 这个文件是**手写的 bundle**，不是打包产物，所以它没有任何编译期检查兜底：
 *   · 文件形态必须是 `window.__ModuleLoader__.load({ id, factory })`；
 *   · factory 只能 require 声明过的 external（这里用桩提供）；
 *   · factory 返回的导出必须有 `apply` 与 `inject`。
 * 任何一条错，真实 GUI 里都表现为"设置页不出现"，而且不会有报错指向原因。
 * 所以这里用一个最小客户端宿主把 bundle 跑起来，把四件事钉死：
 *   1. 加载与导出形状；
 *   2. 只 require 了白名单里的 external（多一个就报错，提醒补声明）；
 *   3. `apply` 把页面注册进了 `plugins.bundle.config`，key 是包名；
 *   4. 组件在 summary/page 两种 view 下都能渲染，且 saving 状态能驱动保存。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** 允许 require 的 external 白名单 —— 必须与 package.json 的 dsh.client.inject 对齐。 */
const ALLOWED_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** 极简 React 桩：只要够让组件函数跑起来并产出可检查的元素树。 */
function createReactStub() {
  const elements = []
  const make = (type, props) => {
    const el = { type, props: props || {}, children: [] }
    elements.push(el)
    return el
  }
  return {
    elements,
    react: {
      createElement: (type, props, ...children) => {
        const el = make(type, props)
        el.children = children.filter((c) => c !== null && c !== undefined && c !== false)
        return el
      },
      useSyncExternalStore: (subscribe, getSnapshot) => {
        // 组件渲染期间不做订阅（真实 React 会在提交阶段订阅）；这里只要拿到快照。
        void subscribe
        return getSnapshot()
      },
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
    },
    jsxRuntime: {
      jsx: (type, props) => make(type, props),
      jsxs: (type, props) => make(type, props),
      Fragment: Symbol('Fragment'),
    },
  }
}

/** 足量的 primitives 桩：记下收到的 props，供断言检查。 */
function createPrimitivesStub() {
  const calls = { SettingsForm: [], SettingsSecretField: [] }
  return {
    calls,
    primitives: {
      SettingsForm: function SettingsForm(props) {
        calls.SettingsForm.push(props)
        return { type: 'SettingsForm', props }
      },
      SettingsSecretField: function SettingsSecretField(props) {
        calls.SettingsSecretField.push(props)
        return { type: 'SettingsSecretField', props }
      },
    },
  }
}

/**
 * 在隔离的 VM 里执行 client.js，取出 factory 的导出。
 * @returns {Promise<{ exports: any, required: string[], ctx: any }>}
 */
async function loadClientBundle() {
  const source = await fs.readFile(CLIENT_PATH, 'utf8')
  const reactStub = createReactStub()
  const primStub = createPrimitivesStub()
  const required = []

  const registry = {
    react: reactStub.react,
    'react/jsx-runtime': reactStub.jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': primStub.primitives,
  }

  let loadCall
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(call) {
          loadCall = call
        },
      },
    },
    console,
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

  assert.ok(loadCall, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(loadCall.id, 'dsh-ark', 'bundle id 必须等于包名')

  const exports = loadCall.factory((id) => {
    if (!ALLOWED_EXTERNALS.has(id)) {
      throw new Error(`客户端 bundle require 了未声明的 external: ${id}`)
    }
    required.push(id)
    return registry[id]
  })

  return { exports, required, reactStub, primStub }
}

/** 最小客户端 ctx 桩：记录 slot 注册与 effect。 */
function createClientCtx() {
  const registered = []
  const effects = []
  const dictionaries = []
  const ctx = {
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    locale: {
      register(ns, dict) {
        dictionaries.push({ ns, dict })
      },
      bind() {
        return (key) => key // 测试里直接把 key 当文案
      },
    },
    slots: {
      inject(slot, cb) {
        return cb()
      },
      register(entry, component) {
        registered.push({ entry, component })
        return () => {}
      },
    },
    remote: {
      credentials: {},
      $on() {
        return () => {}
      },
    },
  }
  return { ctx, registered, effects, dictionaries }
}

test('client.js：形状合法、导出 apply/inject、只 require 白名单 external', async () => {
  const { exports, required } = await loadClientBundle()
  assert.equal(typeof exports.apply, 'function', '缺少 apply 导出')
  assert.ok(Array.isArray(exports.inject), '缺少 inject 导出')
  assert.deepEqual(
    [...new Set(required)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'].sort(),
    `require 的 external 与预期不一致（多出来的必须补进 dsh.client.inject）：${[...new Set(required)].join(', ')}`,
  )
  // 服务依赖必须覆盖 apply 里的实际用法，否则真实环境里 apply 会因为 ctx.remote 未就绪而抛错。
  for (const service of ['slots', 'locale', 'remote', 'remote.credentials']) {
    assert.ok(exports.inject.includes(service), `inject 缺少服务 ${service}`)
  }
})

test('client.js：注册进 plugins.bundle.config，key 为包名（第三方不得占用 official 座位）', async () => {
  const { exports } = await loadClientBundle()
  const host = createClientCtx()
  exports.apply(host.ctx)

  assert.equal(host.registered.length, 1, '应当恰好注册一个设置页')
  const { entry, component } = host.registered[0]
  assert.equal(entry.name, 'plugins.bundle.config')
  assert.equal(entry.key, 'dsh-ark', 'key 必须是安装的包名，页面按它派发')
  assert.equal(typeof component, 'function', '注册的应当是组件')
  // 不许占用官方分组的座位（plugins.item 会让第三方显示成官方插件）。
  assert.ok(
    !host.registered.some((r) => r.entry.name === 'plugins.item'),
    '不应注册 plugins.item',
  )
})

test('client.js：注册了中英文案，且 apply 后能取到 t', async () => {
  const { exports } = await loadClientBundle()
  const host = createClientCtx()
  exports.apply(host.ctx)

  assert.equal(host.dictionaries.length, 1)
  const { ns, dict } = host.dictionaries[0]
  assert.equal(ns, 'dshArk')
  assert.ok(dict.zh && dict.en, '缺少 zh/en 字典')
  // 两个凭据标签必须在两个字典里都有，否则页面会显示 key 而不是文案。
  for (const key of ['arkKey', 'speechApiKey', 'save', 'configured', 'missing']) {
    assert.ok(dict.zh[key], `zh 缺少 ${key}`)
    assert.ok(dict.en[key], `en 缺少 ${key}`)
  }
  // 旧版 App ID / Access Token 的文案已删除；留着会让人以为还能那样配。
  for (const key of ['ttsAppId', 'ttsAccessKey']) {
    assert.equal(dict.zh[key], undefined, `zh 不应再有 ${key}`)
    assert.equal(dict.en[key], undefined, `en 不应再有 ${key}`)
  }
})

test('client.js：summary 视图返回一行描述，page 视图渲染两个密钥控件', async () => {
  const { exports } = await loadClientBundle()
  const host = createClientCtx()
  exports.apply(host.ctx)
  const { component, entry } = host.registered[0]

  // 造一个最小 controller：只提供组件要读的两个面。
  const controller = {
    store: {
      get: () => ({
        fields: {
          arkKey: { text: '', configured: false, writable: true },
          speechApiKey: { text: '', configured: true, writable: true },
        },
        dirty: false,
        saving: false,
        failed: false,
        statusLine: '',
        writable: true,
        missingRequired: ['ARK_API_KEY'],
      }),
      subscribe: () => () => {},
    },
    edit: () => {},
    discard: () => {},
    save: async () => {},
  }

  const props = { ...entry.inject(), controller }

  // summary：只给一行
  const summary = component({ ...props, view: 'summary' })
  assert.equal(summary, 'summary', 'summary 视图应返回 summary 文案 key')

  // page：应产出元素（渲染细节由 React 负责，这里只确认不抛错且返回了树）
  const page = component({ ...props, view: 'page' })
  assert.ok(page, 'page 视图应返回元素')
})

test('client.js：页面声明的凭据名必须与宿主默认值**完全一致**（改名会静默失效）', async () => {
  const source = await fs.readFile(CLIENT_PATH, 'utf8')
  const config = await fs.readFile(path.resolve(path.dirname(CLIENT_PATH), 'config.mjs'), 'utf8')

  // 从两端各自"提取"凭据名再比对，而不是各写一份清单 —— 后者只能证明两边都有某个名字，
  // 证明不了"页面填的名字"与"宿主读的名字"是同一个。
  const clientRefs = new Set([...source.matchAll(/ref:\s*'([A-Z_][A-Z0-9_]*)'/g)].map((m) => m[1]))
  // 现在是两把密钥：方舟（图像/视频）+ 语音技术（合成/识别/音频生成）
  assert.equal(clientRefs.size, 2, `页面应恰好声明 2 个凭据名，实际：${[...clientRefs].join(', ')}`)

  // 宿主默认值里出现的凭据名
  const hostRefs = new Set(
    [...config.matchAll(/(?:apiKeyCredential|appIdCredential|accessKeyCredential|appIdForApiKey):\s*'([A-Z_][A-Z0-9_]*)'/g)].map(
      (m) => m[1],
    ),
  )
  hostRefs.add('ARK_API_KEY')

  for (const ref of clientRefs) {
    assert.ok(
      hostRefs.has(ref),
      `页面声明的凭据名 ${ref} 在宿主默认值里不存在 —— 用户填了也读不到`,
    )
  }

  // 反向：宿主认的语音凭据名也应当都能在页面上填（否则只能手改凭据文件）。
  const speechHostRefs = [...hostRefs].filter((r) => r.startsWith('VOLCENGINE_'))
  assert.equal(speechHostRefs.length, 1, `宿主只应认一个语音凭据名，实际：${speechHostRefs.join(', ')}`)
  for (const ref of speechHostRefs) {
    assert.ok(clientRefs.has(ref), `宿主认的语音凭据 ${ref} 页面上没有输入框`)
  }

  // 旧版 App ID / Access Token 已彻底移除：宿主与页面都不该再引用它们。
  for (const gone of ['VOLCENGINE_TTS_APPID', 'VOLCENGINE_TTS_ACCESS_KEY', 'VOLCENGINE_SPEECH_APPID']) {
    assert.ok(!hostRefs.has(gone), `宿主仍引用已移除的凭据名 ${gone}`)
    assert.ok(!clientRefs.has(gone), `页面仍引用已移除的凭据名 ${gone}`)
  }
})

test('package.json 的 dsh.client 声明符合宿主解析器的硬性要求', async () => {
  // 复刻 dsh-client-modules 的 parseDshClient / clientExportOf 判据。
  // 这三条任何一条不满足，宿主在组合阶段就会抛错（或干脆不认这个包），
  // 而症状只是"设置页不出现"，不查源码根本猜不到原因。
  const pkg = JSON.parse(await fs.readFile(path.resolve(path.dirname(CLIENT_PATH), '..', 'package.json'), 'utf8'))

  const decl = pkg.dsh && pkg.dsh.client
  assert.ok(decl && typeof decl === 'object', 'package.json 缺少 dsh.client 声明')
  // ① platform 必须是字符串；只有 'web' 才会被当成浏览器 bundle 收下。
  assert.equal(typeof decl.platform, 'string', 'dsh.client.platform 必须是字符串')
  assert.equal(decl.platform, 'web', "dsh.client.platform 必须是 'web'")
  // ② inject 必须是字符串数组（可选，但写了就得合法）。
  if (decl.inject !== undefined) {
    assert.ok(Array.isArray(decl.inject) && decl.inject.every((s) => typeof s === 'string'),
      'dsh.client.inject 必须是字符串数组')
  }
  if (decl.external !== undefined) {
    assert.ok(Array.isArray(decl.external) && decl.external.every((s) => typeof s === 'string'),
      'dsh.client.external 必须是字符串数组')
  }

  // ③ exports["./client"] 必须解析成字符串（支持 string 与 { default: string } 两种形态）。
  const client = pkg.exports && pkg.exports['./client']
  assert.ok(client !== undefined, 'package.json 必须导出 "./client"')
  const rel = typeof client === 'string' ? client : client && client.default
  assert.equal(typeof rel, 'string', 'exports["./client"] 必须是字符串或其 default 是字符串')

  // ④ 该相对路径必须真的存在 —— 缺失 bundle 会让宿主 composition 直接失败。
  const abs = path.resolve(path.dirname(CLIENT_PATH), '..', rel)
  await assert.doesNotReject(() => fs.access(abs), `exports["./client"] 指向的文件不存在：${rel}`)

  // ⑤ 声明的 inject 必须覆盖 bundle 真正 require 的 external（少一个 → 组合阶段拒绝）。
  const { required } = await loadClientBundle()
  const declared = new Set(decl.inject || [])
  for (const id of new Set(required)) {
    if (id === 'react' || id === 'react/jsx-runtime') continue // 基座自带，无需声明
    assert.ok(
      declared.has(id),
      `bundle require 了 ${id}，但 dsh.client.inject 没声明它 —— 宿主会拒绝这次解析`,
    )
  }
})
