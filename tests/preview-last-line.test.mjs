/**
 * ⚠️ 回归：**预览地址必须是工具输出的最后一行**。
 *
 * ## 对应的问题
 *
 * 实测反馈："预览卡片要放在最后，这样可以直接看到。"
 *
 * 卡片是宿主对**预览地址那一行**的渲染结果，渲染顺序跟着文本顺序走。
 * 原实现在预览地址后面还排着 `request_id`，于是卡片被顶到中间 ——
 * 用户得往下翻才看得到，体验上等于"没给"。
 *
 * ## 为什么这条测试要驱动**真实工具**而不是只测一个排版函数
 *
 * 排版逻辑分散在多个工具里。只测一个纯函数无法保证每一处都用了它 ——
 * 而"漏了一处"的症状正是"那个能力的卡片又跑到中间去了"，且不会报错。
 * 所以这里用 mock fetch（**零网络**）把工具真正跑一遍，断言它实际吐出的文本。
 *
 * ⚠️ 计数用词要准确：`previewLine(` 的**调用点只有 5 个**
 * （图片 / 视频 / 3D / 语音 / 音频）；第 6 处匹配是它的**函数定义**。
 * `ark_transcribe` **不产出文件**，本来就不该有预览行。
 * （这里曾写"6 个工具"，是独立审查抓出来的过期注释。）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createExec, createHost, createFetchStub } from './host-harness.mjs'
import plugin from '../lib/index.js'

/** 带正确魔数的最小 PNG（ArtifactStore 靠魔数认容器，随便几个字节会被判成 bin）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII='

/** 起一个真实插件宿主：有凭据服务、有 tools 服务。 */
function bootHost(pluginConfig = {}) {
  const host = createHost({
    config: pluginConfig,
    builtins: ['tools'],
    services: {
      // ⚠️ 两把凭据都要给：`ark_transcribe` 走**语音**凭据（VOLCENGINE_SPEECH_API_KEY），
      // 只给 ARK_API_KEY 会让它报 MISSING_CREDENTIAL，测试就拿不到真实返回值
      // （第一版就是这样，症状是返回值只剩一句错误文案）。
      credentials: {
        resolve: async (ref) => {
          if (ref === 'ARK_API_KEY') return { value: 'test-ark-key' }
          if (ref === 'VOLCENGINE_SPEECH_API_KEY') return { value: 'test-speech-key' }
          return undefined
        },
      },
    },
  })
  // ⚠️ 必须把 config 传给 apply()：宿主会用它初始化配置，
  // 不传的话 `cfg` 为 undefined，工具注册整个不执行（症状是 tools.get() 返回 undefined）。
  plugin.apply(host.root, pluginConfig)
  return host
}

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-line-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/** 在测试期间替换 globalThis.fetch（工具内部不注入 fetchImpl，只能这样拦）。 */
async function withFetch(stub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('⚠️ 回归：ark_generate_image 的预览地址排在最后（卡片才会落在最下面）', async () => {
  await withWorkspace(async (cwd) => {
    const host = bootHost()
    const stub = createFetchStub([
      {
        body: { data: [{ b64_json: PNG_B64 }] },
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
      },
    ])

    const out = await withFetch(stub, () =>
      host.tools.get('ark_generate_image').execute({ prompt: '一只猫' }, createExec({ cwd })),
    )

    assert.equal(typeof out, 'string')
    const lines = out.split('\n').filter(Boolean)
    const urlIdx = lines.findIndex((l) => /^预览地址（仅本机可访问）：/.test(l))

    // 预览地址行必须存在，且**它之后不能有任何别的信息行** ——
    // 卡片按这一行渲染，后面再有内容就会把卡片顶到中间。
    assert.ok(urlIdx >= 0, `输出里必须有预览地址行，实际：\n${out}`)
    const after = lines.slice(urlIdx + 1).filter((l) => !l.includes('还需另外调用'))
    assert.equal(
      after.length,
      0,
      `预览地址之后不能再有内容行（会把卡片顶到中间），实际还有：${JSON.stringify(after)}`,
    )

    // request_id 仍要在输出里（排障需要），但必须排在预览地址**之前**。
    const reqIdx = lines.findIndex((l) => l.includes('request_id'))
    assert.ok(reqIdx >= 0, 'request_id 仍应保留在输出里')
    assert.ok(reqIdx < urlIdx, 'request_id 必须排在预览地址之前，否则会把卡片顶到中间')

    // 卡片渲染所需的信息都在
    assert.ok(lines[0].includes('已生成 1 张图像'), '首行应说明生成了什么')
    assert.ok(lines.some((l) => l.includes('.png')), '应有产物相对路径')
  })
})

test('⚠️ 回归：多张图时预览地址仍只有一行（URL 用 、 分隔）', async () => {
  await withWorkspace(async (cwd) => {
    const host = bootHost()
    const stub = createFetchStub([
      { body: { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] }, headers: { 'content-type': 'application/json' } },
    ])

    const out = await withFetch(stub, () =>
      host.tools.get('ark_generate_image').execute({ prompt: '两只猫', count: 2 }, createExec({ cwd })),
    )
    const lines = out.split('\n').filter(Boolean)
    const urlLine = lines.find((l) => /^预览地址（仅本机可访问）：/.test(l))
    assert.ok(urlLine, `必须有预览地址行：\n${out}`)
    // 两个 URL 用顿号分隔，且**同一行**（否则第二个 URL 单独成行会把卡片位置搞乱）
    assert.equal((urlLine.match(/\/dsh-ark\/asset\?id=/g) || []).length, 2, `两个产物应在同一行：${urlLine}`)
    assert.ok(urlLine.includes('、'), '多个地址之间用顿号分隔')
  })
})

/**
 * ⚠️ 回归（独立审查 D7）：`ark_transcribe` 的**返回值**此前没有任何测试。
 *
 * 它是唯一"输入音频、输出文本"的工具 —— **不产出文件**。
 * 所以它的返回值里**不该**出现预览地址或交付提醒：那两样都指向产物，
 * 而它根本没有产物。这条测试就是这个"不产出"契约的行为断言。
 *
 * 之所以要有它：前面那条结构性契约只能查**描述文本**，查不到返回值。
 * 而"给不产文件的工具加交付提醒"正是 v0.3.1 犯过的错 —— 那次就是看漏了返回值这一层。
 */
test('⚠️ 回归：ark_transcribe 返回值里不得出现预览地址或交付提醒（它不产出文件）', async () => {
  await withWorkspace(async (cwd) => {
    const audioPath = path.join(cwd, 'sample.mp3')
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]))

    const host = bootHost()
    // ASR 极速版：HTTP 200 + JSON，鉴权走 X-Api-Key。
    // ⚠️ 形状要照**实测同构**的来（含 `audio_info.duration`）——
    // 少了它 `durationMs` 为 undefined，虽然不影响本用例，但会让桩与真实响应脱节。
    const stub = createFetchStub([
      {
        body: {
          audio_info: { duration: 3240 },
          result: {
            text: '你好呀！喜欢我送给你的礼物吗？',
            utterances: [
              { text: '你好呀！', start_time: 330, end_time: 930 },
              { text: '喜欢我送给你的礼物吗？', start_time: 1410, end_time: 3010 },
            ],
          },
        },
        headers: { 'content-type': 'application/json', 'X-Tt-Logid': 'log-asr-1' },
      },
    ])

    const out = await withFetch(stub, () =>
      host.tools.get('ark_transcribe').execute({ audioPath: 'sample.mp3', cwd }, createExec({ cwd })),
    )

    assert.equal(typeof out, 'string')
    assert.ok(out.includes('你好呀！喜欢我送给你的礼物吗？'), `转写文本必须返回，实际：\n${out}`)
    // 不产出文件 ⇒ 不该有产物相关的任何提示
    assert.equal(/预览地址/.test(out), false, `不产出文件却给了预览地址：\n${out}`)
    assert.equal(/present/.test(out), false, `不产出文件却要求交付：\n${out}`)
    assert.equal(/\.mp3|\.wav|\.glb|\.png/.test(out), false, `不该给出产物路径：\n${out}`)
  })
})

/**
 * 对照：产出文件的能力**必须**在返回值里给预览地址。
 *
 * 与上一条配对，说明"返回值里有预览地址"这件事是**按能力区分**的，
 * 不是所有工具都该有、也不是都没有。
 */
test('对照：ark_generate_image 的返回值必须含预览地址（产出文件的能力）', async () => {
  await withWorkspace(async (cwd) => {
    const host = bootHost()
    const stub = createFetchStub([
      { body: { data: [{ b64_json: PNG_B64 }] }, headers: { 'content-type': 'application/json' } },
    ])
    const out = await withFetch(stub, () =>
      host.tools.get('ark_generate_image').execute({ prompt: '一只猫' }, createExec({ cwd })),
    )
    assert.match(out, /预览地址（仅本机可访问）：\/dsh-ark\/asset\?id=/)
    assert.match(out, /present/)
  })
})

/**
 * ⚠️ 回归（模型理解偏差）：**两张卡片都要**的指令必须写死在给模型的上下文里。
 *
 * 实测：模型经常以"已经有预览卡片了，用户能看到图片，不用再交付"为理由
 * **跳过交付步骤**。这不是宿主或客户端的行为，是模型的理解问题 ——
 * 所以修法是**在插件给模型的文本里把那个推理漏洞提前堵死**：
 * 明说"预览卡片不能替代交付卡片"、"不要因为已有预览就省略"。
 */
test('⚠️ 回归：工具描述必须明确"两张卡片都要"，并驳回"已有预览就不用交付"', async () => {
  const host = bootHost()
  const producing = [
    'ark_generate_image',
    'ark_generate_video',
    'ark_generate_3d',
    'ark_speak',
    'ark_generate_audio',
  ]
  for (const name of producing) {
    const d = host.tools.get(name).description
    // 断言用**精确短语**而不是单个词：松正则（如 /present/ 或 /都要/）会在指令被写乱时
    // 照样通过 —— 那样测试就退化成"碰巧绿"，正是本项目最忌讳的假绿。
    assert.ok(d.includes('两张卡片都要'), `${name}：必须原样写出"两张卡片都要"`)
    assert.ok(d.includes('预览卡片不能替代交付卡片'), `${name}：必须原样驳回"已有预览就不用交付"`)
    assert.ok(d.includes('present'), `${name}：要给出具体动作（present 工具）`)
    assert.ok(d.includes('放在回复最后'), `${name}：要说明卡片放最后`)
    // 兜底那半句同样重要：登记失败时不能什么都不给
    assert.ok(d.includes('绝对路径'), `${name}：要给出登记失败时的兜底（写绝对路径）`)
  }

  // ark_transcribe **不产出文件**（只返回转写文本，没有产物、也没有预览），
  // 所以它不该带"两张卡片都要"——带了就是**措辞不准**，会让模型去交付一个不存在的东西。
  const asr = host.tools.get('ark_transcribe').description
  assert.equal(
    asr.includes('两张卡片都要'),
    false,
    'ark_transcribe 不产出文件，描述里不该出现"两张卡片都要"（否则会诱导模型交付不存在的东西）',
  )
  assert.equal(asr.includes('【交付要求'), false, 'ark_transcribe 不该带交付指令')
})

test('⚠️ 回归：工具返回值末尾也要提醒交付（决策点在这里，不在调用前）', async () => {
  await withWorkspace(async (cwd) => {
    const host = bootHost()
    const stub = createFetchStub([
      { body: { data: [{ b64_json: PNG_B64 }] }, headers: { 'content-type': 'application/json' } },
    ])
    const out = await withFetch(stub, () =>
      host.tools.get('ark_generate_image').execute({ prompt: '一只猫' }, createExec({ cwd })),
    )
    // 返回值里必须有提醒：模型是**拿到结果之后**才决定要不要交付的，
    // 只在工具描述里说，它会因为注意力已转到返回值而漏掉。
    assert.match(out, /present/, '返回值末尾必须提醒调用 present')
    assert.match(out, /预览卡片只是|不能替代|不算/, '返回值里要驳回"已有预览"这个理由')
  })
})

test('⚠️ 回归：产出文件的工具，其 previewLine 调用必须都排在数组末位', async () => {
  // ⚠️ 这条是**源码级**守卫，它只防"漏改某一处 / 把调用挪离末位"，
  // **防不了**"在它后面又追加一行"（那种改法不改变 `previewLine(...)` 后面是否紧跟 `]`）。
  // 追加类的变异由 `tests/render-status.test.mjs` 的**行为**断言负责。
  const src = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  assert.match(src, /function previewLine\(/, 'previewLine 必须存在')

  const lines = src.split('\n')
  const callLines = []
  for (let i = 0; i < lines.length; i++) {
    if (!/previewLine\(/.test(lines[i])) continue
    if (/^\s*(\*|\/\/)/.test(lines[i])) continue // 注释里的提及不算调用
    if (/function\s+previewLine\s*\(/.test(lines[i])) continue // 函数定义不是调用
    callLines.push(i)
  }

  // ⚠️ 计数要排除**函数定义**那一行（曾用 `matchAll` 直接数，把定义也算进去，
  // 于是 `>= 5` 的阈值无法区分"5 个调用 + 定义"与"6 个调用" —— 独立审查 D8 指出）。
  // 正确的调用点数量就是 5 个产出文件的能力。
  assert.equal(
    callLines.length,
    5,
    `previewLine 的调用点应当正好 5 个（图片/视频/3D/语音/音频），实际 ${callLines.length} 个`,
  )

  // 每个调用点后面必须紧跟数组结尾
  for (const i of callLines) {
    let j = i + 1
    let ok = false
    while (j < lines.length && j < i + 6) {
      const t = lines[j].trim()
      if (t === '' || t.startsWith('//')) {
        j++
        continue
      }
      if (t.startsWith(']')) ok = true
      break
    }
    assert.ok(ok, `第 ${i + 1} 行的 previewLine 调用之后必须紧跟数组结尾 —— 否则预览地址不是最后一行`)
  }
})
