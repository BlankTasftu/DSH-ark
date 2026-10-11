/**
 * 能力开关的回归测试。
 *
 * 钉住四件事，每一件都对应一个真实的失败模式：
 *  1. **默认全开** —— 加开关不能改变既有用户的行为（关掉才会有差异）。
 *  2. **关掉的能力，它的工具不注册** —— 这是"省 token"这个卖点唯一能成立的方式；
 *     若只是注册后拒绝执行，工具的 schema 仍会进模型上下文。
 *  3. **只有显式 `false` 才关闭** —— 配置写错类型（字符串 "false"、0 等）
 *     不该静默禁掉能力，否则用户会看到"我明明配了却用不了"。
 *  4. **写出去的形状与读回来的语义往返一致** —— 否则"改回开"永远不生效。
 *
 * 注意：客户端页面的写入路径（逐键 `mutate`，路径必须落在 volatile 叶子上）
 * 由 `tests/client.test.mjs` 用**复刻宿主 `isVolatilePath` 的桩**来钉。
 * 这里只测纯函数，不重复那部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITIES,
  CAPABILITY_BY_TOOL,
  DEFAULT_CAPABILITIES,
  isCapabilityEnabled,
  resolveCapabilities,
  unwrapVolatile,
} from '../lib/config.mjs'
import { toConfigPatch } from '../lib/capabilities.mjs'

/**
 * 造一个 cosmokit 风格的 **volatile 引用**。
 *
 * 形状是从真实 schemastery 上实测来的（不是猜的）：
 *   `Object.keys(ref)`        → `['get']`
 *   `Object.getOwnPropertySymbols(ref)` → `[Symbol(cosmokit.volatile.write)]`
 *   `JSON.stringify(ref)`     → `'{}'`     ← 这就是它骗过所有人的地方
 *   `ref.get()`               → 真实值
 */
function makeVolatileRef(value) {
  const ref = { get: () => value }
  Object.defineProperty(ref, Symbol.for('cosmokit.volatile.write'), {
    value: () => {},
    enumerable: false,
  })
  return ref
}

const ALL_TOOLS = [
  'ark_credential_status',
  'ark_generate_3d',
  'ark_generate_audio',
  'ark_generate_image',
  'ark_generate_video',
  'ark_speak',
  'ark_transcribe',
]

test('能力表与工具表一一对应（没有工具被漏掉或重复归属）', () => {
  const listed = Object.values(CAPABILITIES).flatMap((c) => c.tools).sort()
  assert.deepEqual(listed, [...ALL_TOOLS].sort(), '能力表覆盖的工具必须与全部工具完全一致')

  // 每个工具名只能属于一个能力：否则"关掉 A"会连带关掉 B，而页面看不出来
  const seen = new Set()
  for (const name of listed) {
    assert.equal(seen.has(name), false, `${name} 被多个能力声明`)
    seen.add(name)
  }
  assert.deepEqual(Object.keys(CAPABILITY_BY_TOOL).sort(), [...ALL_TOOLS].sort())
})

test('默认全开', () => {
  for (const key of Object.keys(CAPABILITIES)) {
    assert.equal(DEFAULT_CAPABILITIES[key], true, `${key} 默认应为开启`)
  }
  assert.deepEqual(resolveCapabilities(undefined), DEFAULT_CAPABILITIES)
  assert.deepEqual(resolveCapabilities({}), DEFAULT_CAPABILITIES)
})

test('只有显式 false 才关闭；其它值一律当开启', () => {
  // 真 false
  assert.equal(resolveCapabilities({ image: false }).image, false)
  // 写错类型不该静默禁掉能力
  for (const wrong of ['false', 0, null, undefined, '', {}]) {
    assert.equal(
      resolveCapabilities({ image: wrong }).image,
      true,
      `image=${JSON.stringify(wrong)} 应视为开启（不是 false）`,
    )
  }
})

test('未知键被忽略，不会出现在结果里', () => {
  const got = resolveCapabilities({ image: false, notACapability: false, __proto__: { x: 1 } })
  assert.equal(got.image, false)
  assert.equal('notACapability' in got, false, '未知键不该保留（否则页面与实际生效不一致）')
  assert.deepEqual(Object.keys(got).sort(), Object.keys(CAPABILITIES).sort())
})

test('isCapabilityEnabled：未知能力名视为启用（不因拼错而误禁）', () => {
  assert.equal(isCapabilityEnabled({ image: false }, 'image'), false)
  assert.equal(isCapabilityEnabled({ image: false }, 'video'), true)
  assert.equal(isCapabilityEnabled({}, 'noSuchCapability'), true)
})

test('resolveCapabilities：从 volatile 引用上读出开关，缺省全开', () => {
  // 这正是 lib/index.js 的 liveCaps() 所做的调用 —— 每次现读，不看缓存。
  assert.deepEqual(resolveCapabilities(undefined), DEFAULT_CAPABILITIES)
  assert.deepEqual(resolveCapabilities({}), DEFAULT_CAPABILITIES)
  assert.equal(resolveCapabilities({ video: false }).video, false)
  // 配置里的 capabilities 是噪音时不该炸
  assert.deepEqual(resolveCapabilities('nonsense'), DEFAULT_CAPABILITIES)
})

/**
 * ⚠️ 回归：运行中的 `.volatile()` 字段是**引用对象**，不是布尔值。
 *
 * 这是本插件最贵的一个 bug，也是最后才找到的那个：用户在设置页关掉「视频生成」
 * 与「TTS 语音合成」后，工具照旧注册、照旧可调用，**且没有任何报错**。
 *
 * 根因：`.volatile()` 字段在运行中的 config 里是
 * `{ get: () => 真实值, [Symbol(cosmokit.volatile.write)]: 写入器 }`，
 * 而 `resolveCapabilities` 的规则是"只有显式 `false` 才关闭" ——
 * `ref === false` 恒不成立，于是 **7 项全被判成开启**。
 *
 * 最阴的地方：`JSON.stringify(ref)` 是 `'{}'`，自述日志里看起来像"没配置"，
 * 完全看不出真实值是 `false`。所以必须有一条测试直接盯住这个形状。
 */
test('⚠️ 回归：volatile 引用必须解包后再判定（否则关掉的开关全被判成开启）', () => {
  const refs = {
    image: makeVolatileRef(true),
    video: makeVolatileRef(false),
    threeD: makeVolatileRef(true),
    speech: makeVolatileRef(false),
    audio: makeVolatileRef(true),
    transcribe: makeVolatileRef(true),
    credentialStatus: makeVolatileRef(true),
  }

  // 先确认这个桩确实长得像真实引用（否则这条测试就是空转）。
  assert.equal(JSON.stringify(refs.video), '{}', 'volatile 引用 JSON 序列化应当是 {}（真实行为）')
  assert.equal(refs.video === false, false, '引用对象永远不等于 false —— 这正是 bug 的成因')
  assert.equal(refs.video.get(), false)

  const got = resolveCapabilities(refs)
  assert.equal(got.video, false, 'video 应当是关闭 —— 引用里存的是 false')
  assert.equal(got.speech, false, 'speech 应当是关闭 —— 引用里存的是 false')
  assert.equal(got.image, true, 'image 应当是开启')
  assert.deepEqual(
    got,
    { ...DEFAULT_CAPABILITIES, video: false, speech: false },
    '只有被关掉的那两项应当是 false',
  )
})

test('unwrapVolatile：只解包引用，普通值原样返回', () => {
  assert.equal(unwrapVolatile(false), false)
  assert.equal(unwrapVolatile(true), true)
  assert.equal(unwrapVolatile(undefined), undefined)
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile('false'), 'false', '普通字符串不该被当成引用')
  assert.deepEqual(unwrapVolatile({ a: 1 }), { a: 1 }, '没有 get 的普通对象原样返回')
  assert.equal(unwrapVolatile(makeVolatileRef(false)), false)
  assert.equal(unwrapVolatile(makeVolatileRef(true)), true)
})

test('toConfigPatch：只写被关掉的项（避免配置里堆满噪音）', () => {
  assert.deepEqual(toConfigPatch(DEFAULT_CAPABILITIES), {}, '全开时应写空对象')
  assert.deepEqual(toConfigPatch({ ...DEFAULT_CAPABILITIES, video: false }), { video: false })
  assert.deepEqual(
    toConfigPatch({ ...DEFAULT_CAPABILITIES, image: false, speech: false }),
    { image: false, speech: false },
  )
})

test('toConfigPatch 与 resolveCapabilities 往返一致（关→写→读仍是关）', () => {
  const off = { ...DEFAULT_CAPABILITIES, image: false, threeD: false }
  const written = toConfigPatch(off)
  const readBack = resolveCapabilities(written)
  assert.deepEqual(readBack, off, '写出去再读回来必须还是同一组开关')

  // 关键：把某项改回开，写出的 patch 必须**删掉**那个键，
  // 否则"改回开"永远不生效（逐键 merge 删不掉键）。
  const backOn = { ...off, image: true }
  assert.equal('image' in toConfigPatch(backOn), false, '改回开时不应再写出 image 键')
})

/**
 * ⚠️ 端到端：**真实的 `apply()`** + **真实形态的 config**，断言注册表里到底留下哪些工具。
 *
 * 为什么这条必须有，而且是本文件里最重要的一条：
 * 单元测试覆盖了 `resolveCapabilities`，`plugin.test.mjs` 覆盖了"关掉时工具不注册"，
 * 但**没有任何一条把"用户在设置页写下的那种 config 形状"喂进真实 apply** 过。
 * 2026-10-12 用户实测关掉视频与 TTS 后，工具照旧可调用 —— 事后证明那大概率是
 * "会话工具表早于插件重载"的时序假象，但当时**手里没有任何一条测试能证伪**
 * "门控其实没生效"，只能靠读源码猜。这条测试就是为了消掉那个盲区：
 * 它不依赖宿主、不依赖会话、不依赖是否重载，直接回答"给定这份配置，会注册什么"。
 */
test('端到端：把设置页写出的 config 喂进真实 apply()，关闭的能力其工具必须不注册', async () => {
  const { createHost } = await import('./host-harness.mjs')
  const plugin = (await import('../lib/index.js')).default

  // 形状与设置页写进 profile 补丁的一致：**只写被关掉的**，其余键不出现。
  const userConfig = {
    ark: { credential: 'ARK_API_KEY' },
    speech: { apiKeyCredential: 'VOLCENGINE_SPEECH_API_KEY' },
    output: { dir: 'ark-output', previewRoute: true },
    capabilities: { video: false, speech: false },
  }

  const host = createHost({ config: userConfig, services: {}, builtins: ['tools'] })
  plugin.apply(host.root, userConfig)
  const registered = [...host.tools.keys()].sort()

  const EXPECTED_ABSENT = { ark_generate_video: 'video', ark_speak: 'speech' }
  for (const [tool, cap] of Object.entries(EXPECTED_ABSENT)) {
    assert.equal(
      registered.includes(tool),
      false,
      `${tool} 仍被注册 —— 能力 ${cap} 已关闭，它的 schema 不该进模型工具表`,
    )
  }

  // 反向：没被关掉的必须还在（别把门控写成"关一个全关"）。
  const EXPECTED_PRESENT = [
    'ark_generate_image',
    'ark_generate_3d',
    'ark_generate_audio',
    'ark_transcribe',
    'ark_credential_status',
  ]
  for (const tool of EXPECTED_PRESENT) {
    assert.ok(registered.includes(tool), `${tool} 不该被误关（只有 video 与 speech 被关了）`)
  }
  assert.equal(registered.length, 5, `应当恰好注册 5 个工具，实际 ${registered.length}：${registered.join(', ')}`)
})

test('端到端：全关时一个 ark_ 工具都不注册（门控不会"漏一个"）', async () => {
  const { createHost } = await import('./host-harness.mjs')
  const plugin = (await import('../lib/index.js')).default

  const allOff = Object.fromEntries(Object.keys(CAPABILITIES).map((k) => [k, false]))
  const host = createHost({ config: { capabilities: allOff }, services: {}, builtins: ['tools'] })
  plugin.apply(host.root, { capabilities: allOff })

  assert.deepEqual([...host.tools.keys()], [], `全关时不该注册任何工具，实际：${[...host.tools.keys()].join(', ')}`)
})

/**
 * ⚠️ 用户实测报过的那条：**在设置页翻开关**之后，工具必须当场消失。
 *
 * 这条测试存在的理由：`capabilities.*` 都是 **volatile** 字段，而 Loader 对
 * "只改了 volatile 值"的配置变更走**快速路径**
 * （`cordis-plugin-loader`：`volatileOnly ? this.fiber._config = ... : changes`，
 * 之后 `if (!pending.length && !force) return`）—— 它**只更新运行中的引用，
 * 不重启插件、不再调 apply()**。
 *
 * 所以"apply 时读一次开关"的写法在这里**永远不会生效**：用户在页面上关了视频，
 * 工具照旧注册、照旧可调用，且没有任何报错。插件必须监听
 * `loader/volatile-update` 并重建注册表。
 *
 * 这条测试正是把那个链路钉死：**不再次 apply**，只改配置 + 派发事件。
 */
test('端到端：翻开关后（volatile 快速路径）工具当场消失，不需要重新 apply', async () => {
  const { createHost } = await import('./host-harness.mjs')
  const plugin = (await import('../lib/index.js')).default

  // 这份 config 对象在测试里扮演"运行中的 volatile 引用"：
  // Loader 更新它就是直接改这个对象的属性（updateVolatile 语义）。
  const config = { capabilities: { video: true, speech: true } }
  const host = createHost({ config, services: {}, builtins: ['tools'] })
  plugin.apply(host.root, config)

  // 初始：两个都在。
  assert.ok(host.tools.has('ark_generate_video'), 'apply 后 ark_generate_video 应当在')
  assert.ok(host.tools.has('ark_speak'), 'apply 后 ark_speak 应当在')
  assert.equal(host.tools.size, 7, `应当注册全部 7 个，实际 ${host.tools.size}`)

  // 模拟用户在设置页关掉视频与语音合成：Loader 改引用，然后发事件。
  config.capabilities = { video: false, speech: false }
  const delivered = host.emitEvent('loader/volatile-update', [['capabilities', 'video'], ['capabilities', 'speech']])
  assert.ok(delivered > 0, '插件必须监听 loader/volatile-update，否则快速路径下工具永远不会变')

  assert.equal(host.tools.has('ark_generate_video'), false, '关掉后 ark_generate_video 必须当场注销')
  assert.equal(host.tools.has('ark_speak'), false, '关掉后 ark_speak 必须当场注销')
  assert.equal(host.tools.size, 5, `应当剩 5 个，实际 ${host.tools.size}：${[...host.tools.keys()].join(', ')}`)

  // 再打开：必须回来（重建是双向的，不是单向删除）。
  config.capabilities = { video: true, speech: true }
  host.emitEvent('loader/volatile-update', [['capabilities', 'video'], ['capabilities', 'speech']])
  assert.ok(host.tools.has('ark_generate_video'), '重新打开后 ark_generate_video 必须回来')
  assert.ok(host.tools.has('ark_speak'), '重新打开后 ark_speak 必须回来')
  assert.equal(host.tools.size, 7, `应当回到 7 个，实际 ${host.tools.size}`)
})

test('端到端：重建不会漏掉未受影响的能力，也不会注册出重复工具', async () => {
  const { createHost } = await import('./host-harness.mjs')
  const plugin = (await import('../lib/index.js')).default

  const config = { capabilities: {} }
  const host = createHost({ config, services: {}, builtins: ['tools'] })
  plugin.apply(host.root, config)

  // 连续重建多次：注册表必须始终等于"当前开关允许的集合"，而不是越叠越多。
  for (let i = 0; i < 3; i++) host.emitEvent('loader/volatile-update', [])

  assert.equal(host.tools.size, 7, `重复重建后应当仍是 7 个，实际 ${host.tools.size}`)
  assert.deepEqual(
    [...host.tools.keys()].sort(),
    [
      'ark_credential_status',
      'ark_generate_3d',
      'ark_generate_audio',
      'ark_generate_image',
      'ark_generate_video',
      'ark_speak',
      'ark_transcribe',
    ],
    '重复重建不该改变工具集合',
  )

  // 关掉一个中间项，其余必须一个不少。
  config.capabilities = { threeD: false }
  host.emitEvent('loader/volatile-update', [['capabilities', 'threeD']])
  assert.equal(host.tools.has('ark_generate_3d'), false, 'ark_generate_3d 应被注销')
  assert.equal(host.tools.size, 6, `应当剩 6 个，实际 ${host.tools.size}：${[...host.tools.keys()].join(', ')}`)
})
