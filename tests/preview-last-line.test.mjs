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

import { createCredentialResolver } from '../lib/config.mjs'
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

test('⚠️ 回归：ark_generate_image 的输出以预览地址结尾（卡片才会落在最下面）', async () => {
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
    const last = lines.at(-1)

    assert.match(last, /^预览地址（仅本机可访问）：\/dsh-ark\/asset\?id=/, `最后一行必须是预览地址，实际：${JSON.stringify(last)}`)
    assert.equal(last.includes('request_id'), false, 'request_id 不能和预览地址挤在同一行')

    // request_id 仍要在输出里（排障需要），只是必须排在预览地址**之前**。
    const reqIdx = lines.findIndex((l) => l.includes('request_id'))
    assert.ok(reqIdx >= 0, 'request_id 仍应保留在输出里')
    assert.ok(reqIdx < lines.length - 1, 'request_id 必须排在预览地址之前，否则会把卡片顶到中间')

    // 断言卡片渲染所需的三要素都在
    assert.ok(lines[0].includes('已生成 1 张图像'), '首行应说明生成了什么')
    assert.ok(lines.some((l) => l.includes('.png')), '应有产物相对路径')
  })
})

test('⚠️ 回归：多张图时预览地址仍只有一行、且在最后（URL 用 、 分隔）', async () => {
  await withWorkspace(async (cwd) => {
    const host = bootHost()
    const stub = createFetchStub([
      { body: { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] }, headers: { 'content-type': 'application/json' } },
    ])

    const out = await withFetch(stub, () =>
      host.tools.get('ark_generate_image').execute({ prompt: '两只猫', count: 2 }, createExec({ cwd })),
    )
    const lines = out.split('\n').filter(Boolean)
    const last = lines.at(-1)
    assert.match(last, /^预览地址（仅本机可访问）：/)
    // 两个 URL 用顿号分隔，且**同一行**（不能让第二个 URL 单独成行把卡片位置搞乱）
    assert.equal((last.match(/\/dsh-ark\/asset\?id=/g) || []).length, 2, `两个产物应在同一行：${last}`)
    assert.ok(last.includes('、'), '多个地址之间用顿号分隔')
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
