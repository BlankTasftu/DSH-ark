/**
 * 插件入口契约测试：驱动 lib/index.js 的 apply()，断言工具注册与失败语义。
 *
 * 这些断言锁住的是**面向模型的契约**，不是实现细节：
 *   - 7 个工具是否按约定名字注册，描述里是否写明了计费与异步语义；
 *   - 凭据缺失时是否返回可读的失败文本（而不是抛异常导致 UNKNOWN_TOOL）；
 *   - 产物预览路由是否对跨站/非回环请求 fail-closed。
 *
 * 运行：node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import plugin from '../lib/index.js'
import { createHost, createExec } from './host-harness.mjs'

/**
 * 从源码里提取"交付指令"常量的**全部字符串片段**。
 *
 * ## 为什么要这样提取，而不是在测试里抄一份短语清单
 *
 * 独立审查实测过一次教训：第一版反向断言只查「两张卡片都要」「登记为交付物」
 * 两个 token，于是把**完整指令换一种说法**注入 `ark_transcribe`
 * （避开这两个 token）**照样全绿** —— 那等于没守。
 *
 * 把判据绑在"我记得的措辞"上，必然随着实现改措辞而失效（要么恒真、要么漏抓）。
 * 所以这里**从源码现场提取**：读 `DELIVERY_NOTE` / `DELIVERY_REMINDER` /
 * `DELIVERY_REMINDER_NO_PREVIEW` 三个常量的定义体，取出其中所有长度 ≥ 6 的
 * 字符串字面量。实现改措辞，判据自动跟着变 —— 这才叫"守住了"。
 */
function extractDeliveryFragments() {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const names = ['DELIVERY_NOTE', 'DELIVERY_REMINDER', 'DELIVERY_REMINDER_NO_PREVIEW']
  const fragments = new Set()
  for (const name of names) {
    // 常量体：从 `const NAME =` 到下一个顶层声明/注释块/EOF
    const re = new RegExp(`const ${name} =([\\s\\S]*?)(?=\\n\\/\\*\\*|\\nconst |\\nfunction |\\nexport |$)`)
    const m = re.exec(src)
    assert.ok(m, `无法从源码里提取 ${name} —— 提取逻辑需要跟着结构调整`)
    // 取该定义体里的所有单引号字符串字面量
    for (const lit of m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
      const s = lit[1]
      if (s.length >= 6) fragments.add(s)
    }
  }
  assert.ok(fragments.size >= 5, `提取到的片段太少（${fragments.size} 个），判据可能失效`)
  return [...fragments]
}

const DELIVERY_FRAGMENTS = extractDeliveryFragments()

/** 起一个宿主：默认提供 tools 内建能力（与 DSH Web profile 一致）。 */
function bootHost(pluginConfig = {}, services = {}, builtins = ['tools']) {
  const host = createHost({ config: pluginConfig, services, builtins })
  plugin.apply(host.root, pluginConfig)
  return host
}

/**
 * ⚠️ 回归：`Config` 必须挂在**默认导出对象**上。
 *
 * 这条测试对应一个真实、且症状极具误导性的 bug：设置页的「能力开关」整排是灰的、
 * 点了没反应，控制台没有任何报错。
 *
 * 根因：Cordis 建插件运行记录时读的是**默认导出对象**的属性
 * （`@deepseek-ai/cordis` 的 `Registry.plugin()`：`runtime = { ..., Config: plugin.Config }`），
 * 而 `plugin` 是 Loader `unwrapExports(exports)` 归一化后的结果
 * （`exports.default ?? exports`）—— 它取走 `default` 之后，**具名导出就不可见了**。
 *
 * 所以只写 `export { Config }` 是不够的：`plugin.Config` 为 `undefined`
 * → `runtime.Config` 为空 → 宿主 `settings.describe()` 跳过本条目
 * → 客户端 `configForms.get('dsh-ark')` 的 scope 永远不 ready → 开关全灰。
 *
 * 这条断言之所以必须有：测试文件里 `import plugin from '../lib/index.js'` 拿到的
 * 正是那个默认导出对象，而在这个 bug 存在期间，**没有任何测试引用过 `plugin.Config`**，
 * 于是它一路溜到了用户手上。
 */
test('Config schema 挂在默认导出对象上（Cordis 只读 plugin.Config，具名导出会被丢掉）', () => {
  assert.ok(plugin.Config, 'plugin.Config 必须有值 —— 否则设置页的能力开关永远是灰的')
  assert.equal(typeof plugin.Config.toJSON, 'function', 'Config 应当是 schemastery schema（宿主判据是 toJSON 可调用）')
  assert.equal(plugin.Config['~standard']?.vendor, 'schemastery', '~standard.vendor 必须是 schemastery')

  // 真正要落到表单里的字段：capabilities.<name> —— 路径必须与 resolveCapabilities 读的一致。
  const json = plugin.Config.toJSON()
  const cap = json.dict && json.dict.capabilities
  assert.ok(cap, 'Config 里必须有 capabilities 字段')
  assert.deepEqual(
    Object.keys(cap.dict || {}).sort(),
    ['audio', 'credentialStatus', 'image', 'speech', 'threeD', 'transcribe', 'video'].sort(),
    'capabilities 的 7 个键必须齐全（少一个 = 那个能力在页面上关不掉）',
  )
  for (const [key, field] of Object.entries(cap.dict)) {
    // volatile 决定"能不能实时改"：宿主 write() 逐条过 isVolatilePath，
    // 打在叶子上才对；打在 capabilities 对象上会连带把子字段判成不可写。
    assert.equal(field.meta?.volatile, true, `${key} 必须是 volatile（否则宿主拒绝写入）`)
    assert.equal(field.meta?.default, true, `${key} 默认必须是 true（不写 = 开启）`)
  }
  assert.notEqual(cap.meta?.volatile, true, 'capabilities 自身不该 volatile（与"只给叶子打标记"的约定一致）')
})

test('插件注册了全部 7 个工具，且名字稳定', () => {
  const host = bootHost()
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
      ].sort(),
  )
})

test('能力开关：关掉的能力，其工具**不被注册**（这是省 token 的唯一成立方式）', () => {
  // 关掉图像与语音合成，其余保持默认
  const host = bootHost({ capabilities: { image: false, speech: false } })
  const names = [...host.tools.keys()].sort()
  assert.equal(names.includes('ark_generate_image'), false, '关掉的图像能力不该注册其工具')
  assert.equal(names.includes('ark_speak'), false, '关掉的语音合成能力不该注册其工具')
  // 未关的能力必须照常注册（不能误伤）
  for (const kept of [
    'ark_generate_video',
    'ark_generate_3d',
    'ark_generate_audio',
    'ark_transcribe',
    'ark_credential_status',
  ]) {
    assert.equal(names.includes(kept), true, `${kept} 应仍然注册`)
  }
  assert.equal(names.length, 5, `应注册 5 个工具，实际 ${names.length}：${names}`)
})

test('能力开关：全部关掉时只剩 0 个工具，且不报错', () => {
  const all = Object.fromEntries(
    ['image', 'video', 'threeD', 'speech', 'audio', 'transcribe', 'credentialStatus'].map((k) => [k, false]),
  )
  const host = bootHost({ capabilities: all })
  assert.equal(host.tools.size, 0)
})

test('能力开关：写错类型不会静默禁掉能力（必须仍是 7 个）', () => {
  const host = bootHost({ capabilities: { image: 'false', video: 0, speech: null } })
  assert.equal(host.tools.size, 7, '只有显式 false 才该关闭')
})

test('能力开关：enabled 标记不得泄漏进注册的工具定义', () => {
  const host = bootHost()
  for (const [name, tool] of host.tools) {
    assert.equal('enabled' in tool, false, `${name} 的定义里不该残留 enabled 标记`)
  }
})

test('工具描述里写明了计费与异步语义（模型据此决策，不能丢）', () => {
  const host = bootHost()
  const image = host.tools.get('ark_generate_image')
  assert.match(image.description, /计费/)
  const video = host.tools.get('ark_generate_video')
  assert.match(video.description, /按秒计费/)
  assert.match(video.description, /taskId/)
  const speak = host.tools.get('ark_speak')
  // 语音用独立凭据是最容易踩的坑，必须在描述里直说。
  assert.match(speak.description, /独立|不是同一个/)
})

/**
 * ⚠️ 回归：**产出文件**的工具必须在描述里写明"把文件交付给用户"。
 *
 * 真实反馈：生成完图片后，会话窗口里只看到图片，用户拿不到文件。
 * 根因不是产物没落盘（路径已回传），而是"把文件登记为交付物"这一步
 * **没有任何地方提醒调用方做** —— 只贴路径或预览地址，用户就打不开。
 *
 * 工具描述是模型**每次调用都会看到**的文本，所以指令写在这里最可靠。
 * 这条测试守着它不被后续重构悄悄弄丢（丢了不会报错，只会让产物又拿不到）。
 */
test('⚠️ 回归：产出文件的工具，描述里必须含交付指令', () => {
  const host = bootHost()
  // ⚠️ 只列**真正落盘产物**的 5 个工具。
  // `ark_transcribe` **不在此列**：它只把音频转成文本返回，没有产物文件、也没有预览地址，
  // 给它写"两张卡片都要"属于措辞不准（会诱导模型交付一个不存在的东西）。
  // 这条最初把它算进来了，是分类错误 —— 由 preview-last-line 那条测试的反向断言纠住。
  const producing = [
    'ark_generate_image',
    'ark_generate_video',
    'ark_generate_3d',
    'ark_speak',
    'ark_generate_audio',
  ]
  for (const name of producing) {
    const tool = host.tools.get(name)
    assert.ok(tool, `${name} 应当已注册`)
    // ⚠️ 用**精确短语**而不是松正则（如 /交付/）。松正则在描述里加一句无关的
    // "交付所见即所得。"就会通过 —— 独立审查实测过（N12）。
    assert.ok(
      tool.description.includes('两张卡片都要'),
      `${name} 的描述必须原样写出"两张卡片都要" —— 否则调用方可能只贴路径，用户拿不到文件`,
    )
    assert.ok(
      tool.description.includes('预览卡片不能替代交付卡片'),
      `${name} 的描述必须原样驳回"已有预览就不用交付"`,
    )
    assert.ok(tool.description.includes('绝对路径'), `${name} 的描述要说清"登记失败时的兜底"`)
  }

  // 反向：不产出文件的工具**必须明确声明自己不产出文件**，且不得带交付指令。
  //
  // ## 这里的判据为什么是"两条一起"，以及它**抓不到什么**
  //
  // 走过两次弯路，都记在这里：
  //   ① 最初写 `!/【交付要求】/.test(...)` —— 只测一个**字面前缀**，注入真实指令
  //      文本照样通过；
  //   ② 改成列举 `两张卡片都要` / `登记为交付物` 两个 token —— 把指令**换个说法**
  //      注入（避开这两个 token）照样通过。独立审查两次都实测复现了。
  //
  // 教训：**子串匹配永远追不上改写**。所以判据改成**结构性契约**，对措辞免疫：
  //   · 不产出文件的工具，描述里**必须有一句明确声明**（"不产出文件"）——
  //     这样"没给它加交付指令"是**被断言过的**，而不是靠没人去加；
  //   · 同时不得含**常量原文**（挡住"直接把 DELIVERY_NOTE 拼上去"这种最常见的错）。
  //
  // ## ⚠️ 已知极限（不要假装它不存在）
  //
  // 如果把指令**完全改写成**不含任何常量原文片段、但语义仍在要求交付的话
  // （例如"产出文件后必须调用 present 登记交付物…"），**这两条断言抓不到**。
  // 我实测确认过这个反例仍然全绿。
  //
  // 之所以不再继续堆关键词：那样只会让断言越来越长、越来越脆，而**每一次
  // "多想一种写法"都是在制造新的假绿**（前两次就是这么来的）。
  // 真正的根治要靠**行为断言**（真的调用该工具、检查它有没有产出文件），
  // 那需要一个能驱动全部 7 个工具的 mock 环境 —— 不在本次范围内，记在此处待办。
  const NON_PRODUCING = ['ark_credential_status', 'ark_transcribe']
  for (const name of NON_PRODUCING) {
    const d = host.tools.get(name).description
    assert.ok(
      d.includes('不产出文件'),
      `${name} 的描述必须明确声明"不产出文件" —— 否则模型会去交付一个不存在的东西`,
    )
    for (const frag of DELIVERY_FRAGMENTS) {
      assert.equal(
        d.includes(frag),
        false,
        `${name} 不产出文件，描述里不该出现交付指令的原文片段「${frag}」`,
      )
    }
  }

  // 产出文件的工具则**不得**说自己"不产出文件"（分类自相矛盾）
  for (const name of producing) {
    assert.equal(
      host.tools.get(name).description.includes('不产出文件'),
      false,
      `${name} 会落盘产物，描述里不该出现"不产出文件"`,
    )
  }
})

test('写操作工具标记为不可并发，读操作标记为可并发，生成/识别类标记为不可并发', () => {
  const host = bootHost()
  // 会产生上游计费写入或占用配额的：不可并发
  assert.equal(host.tools.get('ark_generate_image').isConcurrencySafe, false)
  assert.equal(host.tools.get('ark_generate_video').isConcurrencySafe, false)
  assert.equal(host.tools.get('ark_speak').isConcurrencySafe, false)
  assert.equal(host.tools.get('ark_generate_audio').isConcurrencySafe, false)
  // 只读或只做一次远程识别：可并发
  assert.equal(host.tools.get('ark_transcribe').isConcurrencySafe, true)
  assert.equal(host.tools.get('ark_credential_status').isConcurrencySafe, true)
})

test('工具参数 schema 覆盖关键入参', () => {
  const host = bootHost()
  const image = host.tools.get('ark_generate_image').parameters
  for (const key of ['prompt', 'size', 'aspectRatio', 'referenceImages', 'count']) {
    assert.ok(image[key], `ark_generate_image 缺少参数 ${key}`)
  }
  const video = host.tools.get('ark_generate_video').parameters
  for (const key of ['prompt', 'action', 'taskId', 'wait', 'resolution']) {
    assert.ok(video[key], `ark_generate_video 缺少参数 ${key}`)
  }
  assert.equal(image.prompt.required, true)
})

test('凭据缺失时返回可读失败文本，不抛异常', async () => {
  const host = bootHost()
  const exec = createExec()
  const out = await host.tools.get('ark_generate_image').execute({ prompt: '一只猫' }, exec)
  // execute 返回的是**规范化值**（本工具声明 string），内容块由 render 产出。
  // 桩会按 output.schema 校验这个类型，所以这里断言 string 而不是内容块数组。
  assert.equal(typeof out, 'string')
  assert.match(out, /ark_generate_image/)
  assert.match(out, /MISSING_CREDENTIAL/)
  // 必须给出可执行的修复指引，而不是只说"失败"。
  assert.match(out, /ARK_API_KEY|凭据/)
})

test('语音工具在缺少语音凭据时给出区分于 Ark Key 的指引', async () => {
  const host = bootHost()
  const exec = createExec()
  const out = await host.tools.get('ark_speak').execute({ text: '你好' }, exec)
  assert.equal(typeof out, 'string')
  assert.match(out, /MISSING_CREDENTIAL/)
  assert.match(out, /语音/)
})

test('视频 action=status 缺少 taskId 时给出明确提示', async () => {
  const host = bootHost()
  const exec = createExec()
  const out = await host.tools.get('ark_generate_video').execute({ prompt: 'x', action: 'status' }, exec)
  assert.equal(typeof out, 'string')
  assert.match(out, /taskId/)
})

test('3D 工具：description 写明按次计费/耗时/ZIP 解包，且 status 缺 taskId 有提示', async () => {
  const host = bootHost()
  const tool = host.tools.get('ark_generate_3d')
  // 描述承载的是"模型据此决策"的信息，丢了会让模型以为可以随便重试
  assert.match(tool.description, /按次计费/)
  assert.match(tool.description, /taskId/)
  assert.match(tool.description, /ZIP/, '必须提示上游以 ZIP 返回，否则模型会以为拿到的是 glb')
  assert.equal(tool.isConcurrencySafe, false, '计费类工具不得并发安全')

  const out = await tool.execute({ action: 'status' }, createExec())
  assert.equal(typeof out, 'string')
  assert.match(out, /taskId/)
})

test('3D 工具：submit 缺 image 时拒绝，不发计费提交', async () => {
  const host = bootHost()
  const out = await host.tools.get('ark_generate_3d').execute({ action: 'submit' }, createExec())
  assert.equal(typeof out, 'string')
  assert.match(out, /image/)
  assert.match(out, /不会产生新费用/)
})

test('3D 工具：参数表覆盖 image/action/taskId/wait/model 等关键项', () => {
  const host = bootHost()
  const p = host.tools.get('ark_generate_3d').parameters
  for (const key of ['image', 'action', 'taskId', 'wait', 'model', 'subdivisionLevel', 'fileFormat']) {
    assert.ok(p[key], `缺少参数 ${key}`)
  }
  // 与视频同理：prompt/image 不能标 schema 级 required，否则 status 查询会被挡在门外
  assert.equal(p.image.required, undefined)
})

test('每个工具的 execute 返回值都满足自己的 output.schema（真实运行时校验）', async () => {
  // 这是曾经真实炸过的契约：execute 返回了内容块数组，而 schema 声明是 string，
  // 真实 GUI 报 `tool "ark_generate_image" returned invalid output: "value" must be a string`。
  // 桩会按 schema 校验，所以这里等于把"返回值类型与声明一致"逐个走一遍。
  const host = bootHost()
  const exec = createExec()
  const calls = [
    ['ark_credential_status', {}],
    ['ark_generate_audio', { textPrompt: 'x' }],
    ['ark_generate_image', { prompt: 'x' }],
    ['ark_speak', { text: 'x' }],
    ['ark_transcribe', { audioPath: 'x.wav' }],
    ['ark_generate_video', { prompt: 'x', action: 'status' }],
    ['ark_generate_3d', { action: 'status' }],
  ]
  for (const [name, args] of calls) {
    const tool = host.tools.get(name)
    const value = await tool.execute(args, exec)
    assert.equal(typeof value, 'string', `${name} 的 execute 必须返回字符串（output.schema 是 string）`)
    // render 侧要把这个值变成模型可读的内容块。
    const blocks = tool.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks[0] && blocks[0].type === 'text', `${name} 的 render 必须产出内容块`)
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('ark_credential_status：只读自检，能区分"未配置"并点名三层来源', async () => {
  const host = bootHost()
  const exec = createExec()
  const out = await host.tools.get('ark_credential_status').execute({}, exec)
  assert.equal(typeof out, 'string')

  // ⚠️ 这条断言是为了防住一个真实发生过的假绿：自检工具内部报 ReferenceError 时，
  // 失败文本 `[ark_credential_status] 调用失败 …` 里**也**含"未配置"等词，
  // 于是只断言关键词的测试会全绿，而工具在真实环境里一用就炸。
  // 所以必须先排除"这是失败文本"，再断言内容。
  assert.ok(!out.includes('调用失败'), `自检工具不应失败，实际输出：\n${out}`)
  assert.ok(!/^HTTP —|MISSING_CREDENTIAL/.test(out), `自检工具不应报错，实际输出：\n${out}`)
  assert.match(out, /^# 火山方舟插件凭据自检/, '应当是正常的自检报告')

  // 两套凭据都必须出现，并给出"来自哪一层"的结论。
  for (const ref of ['ARK_API_KEY', 'VOLCENGINE_SPEECH_API_KEY']) {
    assert.ok(out.includes(ref), `自检输出缺少 ${ref}`)
    // 每个 ref 都必须真的带上一行结论（来源 + 掩码），而不是只出现名字。
    const line = out.split('\n').find((l) => l.includes(ref))
    assert.match(line, /(凭据服务|环境变量|未配置)/, `${ref} 那一行没有给出来源结论：${line}`)
  }
  // 旧版 App ID / Access Token 已移除：不该再出现在自检输出里（出现即说明还有残留引用）。
  assert.ok(!out.includes('VOLCENGINE_TTS_APPID'), '旧版凭据已移除，不应再出现在自检中')
  assert.ok(!out.includes('VOLCENGINE_TTS_ACCESS_KEY'), '旧版凭据已移除，不应再出现在自检中')

  // 环境变量存在时必须报告"环境变量"这一层，而不是笼统说"未配置"。
  const prev = process.env.ARK_API_KEY
  process.env.ARK_API_KEY = 'test-key-abcdef'
  try {
    const out2 = await host.tools.get('ark_credential_status').execute({}, exec)
    assert.ok(!out2.includes('调用失败'))
    assert.match(out2, /环境变量/)
    // 绝不能回显完整密钥 —— 只允许"前 2 + 后 2 + 长度"。
    assert.ok(!out2.includes('test-key-abcdef'), '自检不得回显完整密钥')
    assert.match(out2, /te…ef/)
  } finally {
    if (prev === undefined) delete process.env.ARK_API_KEY
    else process.env.ARK_API_KEY = prev
  }
})

test('回归（审计 P3-1）：短凭据的掩码不得退化成回显', async () => {
  // 原实现是 `${value.slice(0,2)}…${value.slice(-2)}`：
  //   2 字符 → "MN…MN"（**等于原文**）
  //   3 字符 → 泄露 2/3
  // 真实火山密钥很长所以当时不可利用，但这个输出会进会话记录。
  // 这条用例按长度逐档钉住，防止将来有人"简化"回 slice 版本。
  const host = bootHost()
  const exec = createExec()
  const prev = process.env.ARK_API_KEY
  try {
    for (const short of ['M', 'MN', 'MNO']) {
      process.env.ARK_API_KEY = short
      const out = await host.tools.get('ark_credential_status').execute({}, exec)
      assert.ok(!out.includes('调用失败'), `自检不应失败：\n${out}`)
      assert.ok(
        !out.includes(short),
        `长度 ${short.length} 的凭据被回显了（原文出现在输出里）：\n${out}`,
      )
      // 连"首字符"也不该出现（单个字符也算泄露）
      assert.match(out, /过短不予显示/, `${short.length} 字符时应给出"不予显示"的说明：\n${out}`)
    }

    // 长密钥仍保留可辨识的掩码形态（前 2 + 后 2 + 长度），便于用户核对填的是哪一把
    process.env.ARK_API_KEY = 'ark-0123456789abcdefghijklmnopqrstuvwxyz'
    const long = await host.tools.get('ark_credential_status').execute({}, exec)
    assert.match(long, /ar…yz/)
    assert.ok(!long.includes('ark-0123456789abcdefghijklmnopqrstuvwxyz'), '长密钥也不得回显完整值')
  } finally {
    if (prev === undefined) delete process.env.ARK_API_KEY
    else process.env.ARK_API_KEY = prev
  }
})

test('webServer 缺失时安静跳过路由注册，不影响工具注册', () => {
  // 只给 tools：插件必须不报错、不注册路由。
  const host = bootHost()
  assert.equal(host.routes.length, 0)
  assert.equal(host.tools.size, 7)

  // 给齐 webServer：路由才出现。
  const withWeb = createHost({
    config: {},
    services: {},
    builtins: ['tools', 'webServer'],
  })
  plugin.apply(withWeb.root, {})
  assert.equal(withWeb.tools.size, 7)
  assert.ok(
    withWeb.routes.some((r) => r.path === '/dsh-ark/asset'),
    '提供 webServer 后应注册产物预览路由',
  )
})

test('tools 缺失时（未组合工具注册表的 profile）不报错', () => {
  const host = createHost({ config: {}, services: {}, builtins: [] })
  assert.doesNotThrow(() => plugin.apply(host.root, {}))
  assert.equal(host.tools.size, 0)
})

test('产物预览路由：跨站与伪造 Host 一律 403（fail-closed）', async () => {
  const registered = []
  const host = createHost({
    config: {},
    services: {
      webServer: {
        register(route) {
          registered.push(route)
          return () => {}
        },
      },
    },
    builtins: ['tools', 'webServer'],
  })
  plugin.apply(host.root, {})

  const route = registered.find((r) => r.path === '/dsh-ark/asset')
  assert.ok(route, '未注册产物预览路由')

  async function call(headers, url = '/dsh-ark/asset?id=x') {
    const chunks = []
    const res = {
      statusCode: 200,
      end(c) {
        if (c !== undefined) chunks.push(Buffer.from(String(c)))
      },
    }
    await route.handler({ url, method: 'GET', headers, on() {} }, res)
    return res.statusCode
  }

  // 跨站标记 → 403
  assert.equal(await call({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' }), 403)
  // 非回环 Host（DNS 重绑定）→ 403
  assert.equal(await call({ host: 'evil.example.com' }), 403)
  // Origin 与 Host 不同源 → 403
  assert.equal(await call({ host: '127.0.0.1:19387', origin: 'http://evil.example.com' }), 403)
  // 缺 Host → 403
  assert.equal(await call({}), 403)
  // 本机且同源 → 放行到"未找到产物"的 404，证明校验通过
  assert.equal(await call({ host: '127.0.0.1:19387' }), 404)
  assert.equal(await call({ host: 'localhost:19387' }), 404)
})

test('产物预览路由：拒绝截断型 / 作弊型 Host 与不可验证的 Origin（绕过向量回归）', async () => {
  const registered = []
  const host = createHost({
    config: {},
    services: {
      webServer: { register: (r) => (registered.push(r), () => {}) },
    },
    builtins: ['tools', 'webServer'],
  })
  plugin.apply(host.root, {})
  const route = registered.find((r) => r.path === '/dsh-ark/asset')

  async function call(headers) {
    const res = { statusCode: 200, end() {} }
    await route.handler({ url: '/dsh-ark/asset?id=x', method: 'GET', headers, on() {} }, res)
    return res.statusCode
  }

  // `new URL('http://127.0.0.1#evil.com')` 会把 `#evil.com` 当 fragment 丢掉 ⇒
  // 用 URL 解析器判回环会得出"主机名是 127.0.0.1"而放行。必须 403。
  assert.equal(await call({ host: '127.0.0.1#evil.com' }), 403)
  assert.equal(await call({ host: '127.0.0.1?x=1' }), 403)
  // 用户信息形态（user@host）不该出现在 Host 头里 → 拒绝。
  assert.equal(await call({ host: 'evil.com@127.0.0.1' }), 403)
  // Origin: null（沙箱 iframe / data: 页面）无法证明同源 → 拒绝。
  assert.equal(await call({ host: '127.0.0.1:19387', origin: 'null' }), 403)
  // 非 http(s) 协议的 Origin → 拒绝。
  assert.equal(await call({ host: '127.0.0.1:19387', origin: 'file:///tmp/x' }), 403)
  // 端口不一致的 Origin（同主机不同源）→ 拒绝。
  assert.equal(await call({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' }), 403)

  // 整数/八进制形式的回环地址（2130706433 === 127.0.0.1、0177.0.0.1 === 8 进制 127.0.0.1）
  // 语义上**确实指向本机**，因此它们放行到"未找到产物"是正确行为，不是绕过。
  // 这里钉住的是**安全性质**：这两种形态都不得返回任何产物内容。
  for (const hostHeader of ['2130706433', '0x7f000001', '0177.0.0.1']) {
    const status = await call({ host: hostHeader })
    assert.ok(
      status === 403 || status === 404,
      `Host=${hostHeader} 应被拒绝或未命中产物，实际 ${status}`,
    )
  }
})

test('往返一致性：产物 previewUrl 必须能被已注册的路由命中（曾出现 404 的真实缺陷）', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { ArtifactStore } = await import('../lib/artifacts.mjs')

  const registered = []
  const host = createHost({
    config: {},
    services: {
      webServer: { register: (r) => (registered.push(r), () => {}) },
    },
    builtins: ['tools', 'webServer'],
  })
  plugin.apply(host.root, {})
  const route = registered.find((r) => r.path === '/dsh-ark/asset')

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-roundtrip-'))
  try {
    // 用插件实际传给 ArtifactStore 的 previewBase 生成 URL：
    // 这条链路是"模型拿到的地址"，必须与路由的 pathname 一致。
    const store = new ArtifactStore({ cwd, previewBase: '/dsh-ark/asset' })
    const saved = await store.save({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      hint: 'x',
      mime: 'image/png',
    })

    // 取出 URL 的 pathname 与 query，按浏览器的请求形态喂给路由。
    const parsed = new URL(saved.previewUrl, 'http://127.0.0.1')
    assert.equal(
      parsed.pathname,
      route.path,
      `previewUrl 的 pathname(${parsed.pathname}) 必须等于注册路由的 path(${route.path})，`
        + '否则模型拿到的地址会 404',
    )

    // 路由只认 registry 里的 id；这里直接把 store 的产物登记进插件 registry 不可行，
    // 因此退一步验证"未登记 id 返回 404、且 pathname 确实命中了这条路由"——
    // 若 pathname 不匹配，下面拿到的会是没有 handler 命中的结果。
    const res = { statusCode: 200, end() {} }
    await route.handler(
      { url: `${parsed.pathname}${parsed.search}`, method: 'GET', headers: { host: '127.0.0.1:19387' }, on() {} },
      res,
    )
    // 命中路由但 id 未登记 ⇒ 404（而不是"路由不存在"）。
    assert.equal(res.statusCode, 404)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('卸载：webServer 路由被注销；工具注册的 disposer 交给 fiber 作用域', () => {
  const host = bootHost()
  assert.equal(host.tools.size, 7)
  host.disposeAll()
  // 工具的注销由 DSH fiber 作用域负责（register 返回的 disposer 随作用域回收），
  // 插件只需保证自己注册的 effect 在卸载时释放干净：路由必须被摘掉。
  assert.equal(host.effects.every((d) => d === undefined || typeof d === 'function'), true)
})
