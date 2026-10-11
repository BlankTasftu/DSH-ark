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
// `node:assert/strict` 的 deepEqual **就是** deepStrictEqual（会比对原型），
// 而这里不少对象是在 VM realm 里造出来的，原型与测试 realm 的不是同一个 ——
// 那些是纯 JSON 值（写出去的 payload、快照），用非严格 deepEqual 比对语义才对。
import { deepEqual as looseDeepEqual } from 'node:assert'
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
  /** 组件渲染时登记的订阅请求；测试可据此触发重渲染。 */
  const subscriptions = []
  const make = (type, props) => {
    const el = { type, props: props || {}, children: [] }
    elements.push(el)
    return el
  }
  return {
    elements,
    subscriptions,
    react: {
      createElement: (type, props, ...children) => {
        const el = make(type, props)
        el.children = children.filter((c) => c !== null && c !== undefined && c !== false)
        return el
      },
      useSyncExternalStore: (subscribe, getSnapshot) => {
        // 真实 React 在提交阶段订阅。这里只记录**去重后的** subscribe，用来证明
        // 组件确实订阅了（数量应为 1，多了就是重复渲染）。
        // ⚠️ 不要把 subscribe 的**清理函数**再调一次 —— 那是桩自己造出来的假象
        // （等于重复注册），不是真实 React 的行为。测试要重渲染就直接再调一次组件。
        if (typeof subscribe === 'function' && !subscriptions.includes(subscribe)) {
          subscriptions.push(subscribe)
        }
        return getSnapshot()
      },
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (initial) => ({ current: initial }),
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
  const calls = { SettingsForm: [], SettingsSecretField: [], Switch: [], Button: [] }
  return {
    calls,
    primitives: {
      // 保留 SettingsForm 桩：页面已不再用它（它的保存按钮被硬编码在 children
      // **之后**，位置不可控），但桩留着，"又用回 SettingsForm"这件事在测试里就可见。
      SettingsForm: function SettingsForm(props) {
        calls.SettingsForm.push(props)
        return { type: 'SettingsForm', props }
      },
      Button: function Button(props) {
        calls.Button.push(props)
        return { type: 'Button', props }
      },
      SettingsSecretField: function SettingsSecretField(props) {
        calls.SettingsSecretField.push(props)
        return { type: 'SettingsSecretField', props }
      },
      Switch: function Switch(props) {
        calls.Switch.push(props)
        return { type: 'Switch', props }
      },
    },
  }
}

/**
 * 宿主的 volatile 路径判定 —— 从 `@deepseek-ai/dsh-settings` 的
 * `lib/types/schema.js` 逐行抄来（不是简化版）。
 *
 * 必须复刻它，因为它是"能力开关能不能存下去"的**唯一闸门**：
 * `settings.write()` 对每条路径都过一遍这个判定，不通过就抛
 * `Config field "<path>" is not volatile`，而客户端只会看到一个 `false`。
 *
 * 本插件的 schema 里 `.volatile()` 只打在叶子上（`capabilities.<name>`），
 * 外层 `capabilities` 不是 volatile —— 所以 `['capabilities']` 会被拒、
 * `['capabilities', 'video']` 才通过。桩不复刻这一点，就抓不到
 * "用 set('capabilities', {...}) 写整个对象"这个 bug。
 */
function isVolatilePath(schema, path) {
  if (schema.meta && schema.meta.volatile === true) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict && schema.dict[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/**
 * 本插件 Config schema 的**投影**：能力开关的 7 个叶子都是 volatile，
 * 它们共同的外层 `capabilities` 不是。与 `lib/config.mjs` 的
 * `Config = z.object({ capabilities: z.object({ <k>: z.boolean().default(true).volatile() }) })` 一致。
 */
const VOLATILE_SCHEMA = {
  meta: {},
  dict: {
    capabilities: {
      meta: {},
      dict: Object.fromEntries(
        Object.keys({
          image: 1, video: 1, threeD: 1, speech: 1, audio: 1, transcribe: 1, credentialStatus: 1,
        }).map((k) => [k, { meta: { volatile: true } }]),
      ),
    },
  },
}

/**
 * `ctx.configForms` 的桩 —— 复刻 DSH 真实 scope 的契约。
 *
 * 关键点（都来自 `@deepseek-ai/dsh-client-ui-settings` 的实现，不是猜的）：
 *   · `get(entryId)` 返回一个 scope；
 *   · `getSnapshot()` 给出 `{ status, value, writable, revision }`；
 *   · `subscribe(listener)` 在 scope 变化时被调用；
 *   · `set(field, value)` / `mutate(ops, expectedRevision)` 都返回 Promise<boolean>，
 *     **false 表示宿主拒绝了这次写**；
 *   · `mutate` 的每条 op 都要过 `isVolatilePath`，不过就拒 —— 这是真实闸门。
 *
 * 桩刻意实现成"只有显式接受才改值"：这样"写失败却显示新状态"这种 bug 会当场暴露，
 * 而不是被一个过于宽容的桩掩盖过去。
 */
function createConfigFormsStub(options = {}) {
  const writes = []
  /** 被宿主拒绝的写（路径不 volatile / revision 冲突 / 传输失败）。 */
  const rejects = []
  let accepted = true
  const listeners = new Set()
  const snapshot = {
    status: options.status || 'ready',
    value: options.value,
    base: options.value,
    user: options.user,
    revision: 1,
    writable: options.writable !== false,
  }
  /** 按 op 把变更应用到 value 上（整体替换该路径，与 applyPathOp 一致）。 */
  const applyOps = (ops) => {
    let value = scope.__value
    for (const op of ops) {
      const [root, ...rest] = op.path
      const section = { ...((value && value[root]) || {}) }
      if (rest.length === 0) {
        // 整块 set/unset：直接替换/删除整个子对象。
        if (op.op === 'unset') delete section[root]
        value = { ...(value || {}), [root]: op.op === 'set' ? op.value : undefined }
        continue
      }
      if (op.op === 'unset') delete section[rest[0]]
      else section[rest[0]] = op.value
      value = { ...(value || {}), [root]: section }
    }
    scope.__value = value
    snapshot.value = value
    snapshot.revision += 1
    for (const fn of listeners) fn()
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      // 必须真的返回一个**函数**（React 会把它当清理器调用）；
      // `() => listeners.delete(...)` 返回的是布尔，会被当成"不是函数"而抛错。
      return () => {
        listeners.delete(listener)
      }
    },
    /** 单字段写（真实契约里只允许 scalar field）。 */
    async set(field, value) {
      return scope.mutate([{ op: 'set', path: [field], value }])
    },
    /** 原子多字段写；每条路径都要过 volatile 判定。 */
    async mutate(ops) {
      writes.push(structuredClone(ops))
      const bad = ops.filter((op) => !isVolatilePath(VOLATILE_SCHEMA, op.path))
      if (bad.length > 0) {
        // 真实宿主在这里抛 `Config field "..." is not volatile`，
        // 客户端只看到一次失败的写 —— 所以桩也只回报拒绝。
        rejects.push(...bad.map((op) => op.path.join('.')))
        return false
      }
      if (!accepted) return false
      applyOps(ops)
      return true
    },
  }
  return {
    writes,
    rejects,
    scope,
    snapshot,
    listeners,
    /** 让后续写入被宿主拒绝（模拟 revision 冲突 / 只读 / 网络失败）。 */
    rejectNext(flag = true) {
      accepted = !flag
    },
    get: (entryId) => {
      scope.__entryId = entryId
      return scope
    },
    describe: () => [],
    whileServed: () => () => {},
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
function createClientCtx(options = {}) {
  const registered = []
  const effects = []
  const dictionaries = []
  const configForms = createConfigFormsStub(options.configForms)
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
    configForms,
  }
  return { ctx, registered, effects, dictionaries, configForms }
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

// ────────────────────────────────────── 能力开关（configForms）

/**
 * 建一个已经 apply 过的宿主，返回 inject 面里的能力控制器。
 *
 * 走 `entry.inject()` 而不是另建一个控制器：注入面是真实运行时唯一交到组件手里的东西，
 * 用它才能证明"控制器真的被接线进了页面"。
 */
async function setupCapabilities(configFormsOptions = {}) {
  const { exports, reactStub, primStub } = await loadClientBundle()
  const host = createClientCtx({ configForms: configFormsOptions })
  exports.apply(host.ctx)
  const face = host.registered[0].entry.inject()
  /** 最近一次渲染求值出来的 primitives 调用与文本。 */
  let rendered = { primitives: [], texts: [] }
  /**
   * 把设置页整个渲染一遍（求值到 primitives），复刻"组件又画了一次"。
   *
   * 不用 `useSyncExternalStore` 的 subscribe 回调来触发：真实 React 因 store 变化
   * 重渲染时，组件函数**会再被执行一次**，所以直接再调一次组件才是等价的动作。
   */
  const renderAgain = () => {
    primStub.calls.SettingsForm.length = 0
    primStub.calls.SettingsSecretField.length = 0
    primStub.calls.Switch.length = 0
    primStub.calls.Button.length = 0
    const node = host.registered[0].component({ ...face, view: 'page' })
    rendered = evaluateTree(node, primStub.primitives)
    // 把顺序与文本也挂到 calls 上，测试可以像读其它调用一样读它们。
    primStub.calls.__order = rendered.order
    primStub.calls.__texts = rendered.texts
    return rendered
  }
  /** 页面上实际出现的全部文本（已求值）。 */
  const texts = () => new Set(rendered.texts)
  /** 某个控件的 props（按 type + 谓词找）。 */
  const findControl = (predicate) => primStub.calls.Switch.find(predicate)
  return {
    host,
    face,
    controller: face.capabilitiesController,
    reactStub,
    primStub,
    renderAgain,
    texts,
    findControl,
  }
}

test('client.js：能力开关走 configForms，namespace 是本插件在 profile 里的行 id', async () => {
  const { host, controller } = await setupCapabilities()
  assert.ok(controller, '页面注入面必须带 capabilitiesController')
  // namespace 错了会静默拿到一个空 scope —— 页面显示"未加载"，用户以为插件没装好。
  assert.equal(
    host.configForms.scope.__entryId,
    'dsh-ark',
    'configForms.get() 必须用 profile 补丁里的行 id（cordis.patch.yml 的 id: dsh-ark）',
  )
})

/** 从一次 mutate 的 ops 里读出"被关掉的能力"（测试辅助）。 */
function offKeysOf(ops) {
  return ops
    .filter((op) => op.op === 'set' && op.path.length === 2 && op.value === false)
    .map((op) => op.path[1])
    .sort()
}

test('client.js：关掉某项 → 只对那一项写 false，其余保持"无覆盖"', async () => {
  const { host, controller } = await setupCapabilities()
  await controller.setEnabled('video', false)

  assert.equal(host.configForms.writes.length, 1, '一次点击应当只发一次写')
  const [ops] = host.configForms.writes
  looseDeepEqual(offKeysOf(ops), ['video'], '只把 video 写成 false')
  // 其余 6 项必须是 unset（= 无覆盖），而不是写一个显式 true 进用户配置。
  const unset = ops.filter((op) => op.op === 'unset').map((op) => op.path[1]).sort()
  looseDeepEqual(
    unset,
    ['audio', 'credentialStatus', 'image', 'speech', 'threeD', 'transcribe'],
    '没被翻的项应当 unset（回到"无覆盖"），不要往配置里塞 true',
  )
})

test('client.js：⚠️ 回归 —— 写入路径必须落在 volatile 叶子上，否则宿主静默拒绝', async () => {
  const { host, controller } = await setupCapabilities()
  await controller.setEnabled('video', false)

  // 宿主 `settings.write()` 逐条过 `isVolatilePath`，不通过就抛
  // `Config field "capabilities" is not volatile`；客户端只看到一个 false。
  // 症状是"点了开关，页面弹回原状" —— 不查宿主源码根本猜不到原因。
  looseDeepEqual(
    host.configForms.rejects,
    [],
    "不能有被宿主拒绝的写：每条 op 的路径都必须是 ['capabilities', <leaf>]",
  )
  for (const ops of host.configForms.writes) {
    for (const op of ops) {
      assert.deepEqual(
        op.path,
        ['capabilities', op.path[1]],
        `路径必须是两段式（叶子），实际 ${JSON.stringify(op.path)} —— 写成 ['capabilities'] 会被宿主拒`,
      )
    }
  }
})

test('client.js：改回"开"必须**不再写 false**（否则永远关不掉）', async () => {
  const { host, controller } = await setupCapabilities()
  await controller.setEnabled('video', false)
  await controller.setEnabled('video', true)

  assert.equal(host.configForms.writes.length, 2)
  // 这是整个开关最容易写错的地方：如果实现成"逐键 merge"，第一次写进去的
  // `video: false` 就删不掉，「改回开」永远不生效。用 unset 才是真的撤销覆盖。
  looseDeepEqual(offKeysOf(host.configForms.writes[1]), [], '改回开时不能再有 set ... false')
  const videoOp = host.configForms.writes[1].find((op) => op.path[1] === 'video')
  assert.equal(videoOp.op, 'unset', `改回开应当是 unset，实际 ${videoOp.op}`)
  // 真正生效与否看宿主回读：关掉再打开，video 必须回到 true。
  assert.equal(controller.store.get().values.video, true, '改回开后页面必须显示为开')
})

test('client.js：写失败时页面显示的是**仍生效**的值，不是用户点的那个', async () => {
  const { host, controller, primStub, renderAgain } = await setupCapabilities()
  host.configForms.rejectNext(true)
  await controller.setEnabled('video', false)

  const state = controller.store.get()
  assert.equal(state.values.video, true, '宿主拒绝后不得显示成已关闭')
  assert.equal(state.failed, true, '必须把失败标记出来，否则用户以为关掉了')
  assert.equal(state.wroteSinceApply, false, '没写成功就不该提示"需重载"')

  // 关键：上面几个断言只看了 store 快照。**乐观更新**这类 bug 恰恰是
  // "store 说对的、页面画错的"（组件自己先翻了本地状态），所以必须真的把
  // 页面渲染一遍、读 Switch 的 checked —— 否则这条测试抓不到那个 bug。
  renderAgain()

  const videoSwitch = primStub.calls.Switch.find((p) => p.label === 'cap_video')
  assert.ok(videoSwitch, '没渲染出 cap_video 的开关')
  assert.equal(
    videoSwitch.checked,
    true,
    '宿主拒绝写入后，页面上的开关必须仍是"开" —— 显示成"关"就是最危险的那种谎',
  )
})

test('client.js：写失败时页面上必须出现失败提示（不能只在 store 里）', async () => {
  const { host, controller, renderAgain, texts, findControl } = await setupCapabilities()

  // 先渲染一次"正常"状态，再让下一次写失败，比较两次页面上的文案集合。
  renderAgain()
  assert.ok(!texts().has('capWriteFailed'), '还没失败就不该显示失败提示')

  host.configForms.rejectNext(true)
  await controller.setEnabled('speech', false)

  // ✅ 这里断言的是**求值后页面上的真实文本**，而不是 store 快照 ——
  // 否则"store 说失败了、页面却没画出来"这种 bug 会被漏掉。
  renderAgain()
  const shown = texts()
  assert.ok(shown.has('capWriteFailed'), `写失败后页面必须显示失败提示，实际文案：${[...shown].join(', ')}`)
  assert.ok(!shown.has('capLive'), '写失败就不该提示"已写入配置，需重载"')

  const speechSwitch = findControl((p) => p.label === 'cap_speech')
  assert.equal(speechSwitch.checked, true, '写失败后开关必须回到宿主仍生效的值')
})

test('client.js：保存成功后页面上出现两条提示：已保存 + 需重载', async () => {
  const { controller, renderAgain, texts } = await setupCapabilities()
  await controller.setEnabled('transcribe', false)
  renderAgain()
  const shown = texts()
  assert.ok(shown.has('capWriteFailed') === false, '不该出现失败提示')
  // "需重载"是本功能最容易被漏掉的用户可见后果：开关写进去了，但工具要下次
  // apply 才重新注册。不提示的话用户会以为没生效。
  assert.ok(shown.has('capLive'), `保存成功后必须提示需重载，实际文案：${[...shown].join(', ')}`)
})

test('client.js：scope 未就绪 / 只读时不得发起写', async () => {
  for (const options of [{ status: 'loading' }, { status: 'ready', writable: false }]) {
    const { host, controller } = await setupCapabilities(options)
    const state = controller.store.get()
    assert.equal(state.writable, false, `${JSON.stringify(options)} 应判定为不可写`)
    await controller.setEnabled('video', false)
    assert.equal(host.configForms.writes.length, 0, '不可写时不许发写请求')
  }
})

test('client.js：未知能力名不得写进配置（防止页面加项而宿主不认识）', async () => {
  const { host, controller } = await setupCapabilities()
  await controller.setEnabled('notACapability', false)
  assert.equal(host.configForms.writes.length, 0, '未知键忽略，不写')
})

test('client.js：能力清单与宿主 CAPABILITIES **完全一致**（少一个 = 有工具关不掉）', async () => {
  const source = await fs.readFile(CLIENT_PATH, 'utf8')
  const config = await fs.readFile(path.resolve(path.dirname(CLIENT_PATH), 'config.mjs'), 'utf8')

  // 从宿主源码里提取能力键，而不是各写一份清单 —— 后者只能证明"两边都有某个名字"，
  // 证明不了页面上的开关与宿主过滤工具时读的是**同一个键**。
  const hostBlock = config.slice(
    config.indexOf('export const CAPABILITIES'),
    config.indexOf('export const DEFAULT_CAPABILITIES'),
  )
  const hostKeys = new Set([...hostBlock.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/gm)].map((m) => m[1]))
  assert.ok(hostKeys.size >= 5, `没能从宿主源码里提取出能力键，实际拿到 ${hostKeys.size} 个`)

  const clientBlock = source.slice(
    source.indexOf('const CAPABILITY_KEYS = ['),
    source.indexOf(']', source.indexOf('const CAPABILITY_KEYS = [')),
  )
  const clientKeys = new Set([...clientBlock.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]))

  assert.deepEqual(
    [...clientKeys].sort(),
    [...hostKeys].sort(),
    '设置页的能力清单必须与宿主 CAPABILITIES 的键一一对应',
  )
})

test('client.js：每个能力都有中英文案（缺了页面会显示 cap_xxx 这种键名）', async () => {
  const { host, face } = await setupCapabilities()
  const { dict } = host.dictionaries[0]
  const keys = face.capabilitiesController.store.get().keys
  assert.ok(keys.length >= 5, `能力项太少：${keys.length}`)
  for (const key of keys) {
    for (const [locale, d] of Object.entries({ zh: dict.zh, en: dict.en })) {
      assert.ok(d[`cap_${key}`], `${locale} 缺少 cap_${key}`)
      assert.ok(d[`cap_${key}_hint`], `${locale} 缺少 cap_${key}_hint`)
    }
  }
  // 开关区块自身的文案也要两边都有。
  for (const key of ['capSection', 'capSectionHint', 'capReadOnly', 'capWriteFailed', 'capLive']) {
    assert.ok(dict.zh[key], `zh 缺少 ${key}`)
    assert.ok(dict.en[key], `en 缺少 ${key}`)
  }
})

/**
 * 把一棵元素树递归求值到"只剩 primitives 调用与文本"。
 *
 * 桩版 React 不渲染 children，所以
 * `SettingsForm > CapabilitySection > CapabilityRow > Switch`
 * 这条链不会自己走完 —— 而 `Switch` 恰恰是最该被断言的那个控件。
 *
 * 两个**必须**遵守的规则（都踩过）：
 *   · primitives 也要**调用**：它们已被桩替换，调用只是把 props 记进 `primStub.calls`，
 *     不调用就永远断言不到 Switch；
 *   · 求值过的组件要用 `seen` 记账，避免同一次渲染里反复调用导致重复记录。
 */
function walk(node, primitives, out, seen, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, primitives, out, seen, depth + 1)
    return
  }
  if (typeof node !== 'object' || depth > 16) return

  const isPrimitive = node.type !== undefined && Object.values(primitives).includes(node.type)
  if (typeof node.type === 'function' && !seen.has(node)) {
    seen.add(node)
    let rendered
    try {
      rendered = node.type(node.props)
    } catch (err) {
      throw new Error(`渲染${isPrimitive ? '控件' : '组件'}失败：${err && err.message}`)
    }
    if (isPrimitive) {
      out.primitives.push({ type: node.type, props: node.props })
      // 记录**求值顺序**：页面从上到下的排布就是它 —— 断言"保存按钮在开关之前"
      // 只能靠这个，靠 primitives 的数组各自计数是证明不了先后关系的。
      out.order.push(node.type.name || 'anonymous')
      if (rendered && rendered.props && rendered.props.children !== undefined) {
        walk(rendered.props.children, primitives, out, seen, depth + 1)
      }
      return
    }
    walk(rendered, primitives, out, seen, depth + 1)
    return
  }
  if (node.props && node.props !== undefined && node.props.children !== undefined) {
    walk(node.props.children, primitives, out, seen, depth + 1)
  }
  if (node.children !== undefined) walk(node.children, primitives, out, seen, depth + 1)
}

/** 求值一棵元素树：返回渲染期间发生的 primitives 调用、文本，以及求值顺序。 */
function evaluateTree(node, primitives) {
  const out = { primitives: [], texts: [], order: [] }
  walk(node, primitives, out, new Set())
  return out
}

test('client.js：开关渲染成受控 Switch，只读时 disabled，且文案不是裸键名', async () => {
  const { controller, primStub, reactStub, renderAgain } = await setupCapabilities({
    status: 'ready',
    writable: false,
  })

  renderAgain()

  // 组件必须真的订阅了 store，否则开关点了之后页面永远不跟着更新。
  assert.equal(reactStub.subscriptions.length, 2, '设置页应当订阅两次：凭据 store + 能力开关 store')

  const keys = controller.store.get().keys
  const switches = primStub.calls.Switch
  assert.equal(switches.length, keys.length, `应当为每个能力渲染一个 Switch，实际 ${switches.length}`)
  for (const props of switches) {
    assert.equal(props.disabled, true, '只读部署下开关必须 disabled，否则点了没反应还没提示')
    assert.equal(typeof props.label, 'string')
    // 测试里的 t() 直接把 key 返回，所以 label 就是文案键 —— 它必须落在 **label** 键上，
    // 不能是 hint（否则无障碍名字会读出一整句说明），也不能是没见过的键。
    assert.match(props.label, /^cap_[A-Za-z]+$/, `Switch 的 label 不是能力名文案键：${props.label}`)
    assert.ok(!props.label.endsWith('_hint'), `label 不该用 hint 文案：${props.label}`)
    assert.ok(keys.includes(props.label.slice(4)), `label ${props.label} 不对应任何能力`)
  }
  // 默认全开：没有任何一项被判定成关闭。
  assert.equal(controller.store.get().offCount, 0)
  assert.ok(switches.every((p) => p.checked === true), '默认应当全部为开')
})

test('client.js：保存按钮排在能力开关**之前**（用户明确提过它在最下面很反直觉）', async () => {
  const { primStub, renderAgain } = await setupCapabilities()
  renderAgain()

  // 页面上元素的出现顺序 = evaluateTree 记录的文本顺序。
  const order = [...primStub.calls.SettingsSecretField].length > 0
  assert.ok(order, '应当渲染出密钥输入框')

  const texts = primStub.calls.Button.length > 0
  assert.ok(texts, '应当渲染出保存按钮（Button）')

  // 用户在页面上看到的顺序：密钥 → 保存按钮 → 能力开关。
  // 用一个稳定的代理来断言：文本序列里 'save' 必须出现在第一项能力名之前。
  const seq = primStub.calls.__order
  assert.ok(Array.isArray(seq) && seq.length > 0, '需要渲染顺序记录')
  const iSave = seq.indexOf('Button')
  const iSwitch = seq.indexOf('Switch')
  const iSecret = seq.indexOf('SettingsSecretField')
  assert.ok(iSecret >= 0 && iSave >= 0 && iSwitch >= 0, `顺序记录不完整：${JSON.stringify(seq)}`)
  assert.ok(iSecret < iSave, `密钥应在保存按钮之前（${iSecret} < ${iSave}）`)
  assert.ok(iSave < iSwitch, `保存按钮应在能力开关之前（${iSave} < ${iSwitch}）—— 反过来就是用户抱怨的那个布局`)
})

test('client.js：每个开关旁边都有一行明确的状态文字（不能只靠滑块位置）', async () => {
  const { primStub, renderAgain, controller } = await setupCapabilities()
  renderAgain()

  // 默认全开：每个开关旁边都应出现「已开启」。
  const on = new Set(primStub.calls.__texts.filter((x) => x === 'capOn'))
  assert.equal(on.size, 1, '应当出现 capOn 文案')
  assert.ok(
    primStub.calls.__texts.filter((x) => x === 'capOn').length === controller.store.get().keys.length,
    '每一项都应有"已开启"状态文字',
  )
  assert.ok(!primStub.calls.__texts.includes('capOff'), '默认全开时不该出现"已关闭"')

  // 关掉一项后，那一项旁边必须变成「已关闭」。
  await controller.setEnabled('audio', false)
  renderAgain()
  const offCount = primStub.calls.__texts.filter((x) => x === 'capOff').length
  assert.equal(offCount, 1, `应当恰好有一项显示"已关闭"，实际 ${offCount}`)
})

test('client.js：关掉一项后，写出去的 payload 与页面显示的开关可以互相印证', async () => {
  const { host, controller, primStub, renderAgain } = await setupCapabilities()

  await controller.setEnabled('threeD', false)
  // 点完之后「需重载」提示应出现（写成功才提示）。
  assert.equal(controller.store.get().wroteSinceApply, true)

  renderAgain()

  const off = primStub.calls.Switch.filter((p) => p.checked === false)
  assert.equal(off.length, 1, '应当恰好有一项显示为关')
  // 测试里 t() 直接返回 key，所以 label 就是文案键 —— 用它反查是哪一项。
  assert.equal(off[0].label, 'cap_threeD', `显示为关的应当是图生 3D，实际 ${off[0].label}`)
  // 页面显示的"关"必须与真正写给宿主的键一致 —— 这是本功能唯一要保证的事。
  looseDeepEqual(offKeysOf(host.configForms.writes[0]), ['threeD'])
  // 而且这次写必须真的被宿主接受了（路径落在 volatile 叶子上）。
  looseDeepEqual(host.configForms.rejects, [], '这次写不该被宿主拒绝')
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
