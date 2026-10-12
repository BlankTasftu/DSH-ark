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
 * 排版逻辑分散在 6 个工具里（图片 / 视频 / 3D / 语音 / 音频 / 转写）。
 * 只测一个纯函数无法保证 6 处都用了它 —— 而"漏了一处"的症状正是
 * "那个能力的卡片又跑到中间去了"，且不会报错。
 * 所以这里用 mock fetch（**零网络**）把工具真正跑一遍，断言它实际吐出的文本。
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
      credentials: { resolve: async (ref) => (ref === 'ARK_API_KEY' ? { value: 'test-key' } : undefined) },
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

const previewLineOf = (out) => out.split('\n').filter(Boolean).at(-1)

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

test('⚠️ 回归：预览地址是最后一行 —— 逐个能力都验（防止只改了其中几处）', async () => {
  // 这条是"6 个工具都遵守同一条不变量"的守卫。
  // 之所以只驱动图片一个：其余能力的**布局代码位置**不同，但都调用同一个
  // `previewLine()` 并把它放在数组末位；这里用源码级断言补齐覆盖面。
  const src = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  // previewLine 必须存在且是唯一的排版入口
  assert.match(src, /function previewLine\(/, 'previewLine 必须存在')

  // 每次 `previewLine(` 调用，都必须在返回数组的**末位**（后面不再跟别的元素）。
  const calls = [...src.matchAll(/previewLine\(/g)].length
  assert.ok(calls >= 5, `previewLine 应在所有产出工具里被调用（实际 ${calls} 处）`)

  // 末位判据：`previewLine(...)` 之后到 `]` 之间不应再有非注释、非空的行
  const lines = src.split('\n')
  let checked = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/previewLine\(/.test(lines[i])) continue
    if (/^\s*(\*|\/\/)/.test(lines[i])) continue // 注释里的提及不算调用
    if (/function\s+previewLine\s*\(/.test(lines[i])) continue // 函数定义本身不是调用
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
    checked++
  }
  assert.ok(checked >= 5, `应检查到至少 5 处 previewLine 调用，实际 ${checked}`)
})
