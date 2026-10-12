/**
 * ⚠️ 回归：**渲染函数**（视频 / 3D）的预览行必须在最后。
 *
 * ## 为什么需要一个单独的测试文件来做这件事
 *
 * 独立审查指出一处**假绿**（HIGH）：`renderVideoStatus` 的预览行**完全没有测试**。
 * 把 `MUTANT-TRAILING-LINE` 追加到它的输出之后，**全部测试仍然全绿** ——
 * 也就是说 v0.3.2 宣称的"视频预览行永远在最后"从未被验证过，
 * 而视频是**单价最高**的能力，最不该在这里出问题。
 *
 * 顺带还发现：源码级扫描（数 `previewLine(` 后面是不是紧跟 `]`）**抓不到这种变异** ——
 * 追加一行之后 `previewLine(...)` 后面仍然是 `]`，形状没变。
 * 所以这里改为**真正调用渲染函数**，检查它实际吐出的文本。
 *
 * `renderVideoStatus` / `render3dStatus` 没有导出（它们只在本模块内用），
 * 这里用 `vm` 在同一模块作用域里取出来 —— 只读源码，不改文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'lib', 'index.js')

/** 把源码的 import / export 剥掉，在沙箱里取出只依赖纯逻辑的渲染函数。 */
function loadRenderers() {
  const src = fs.readFileSync(SRC, 'utf8')
  const stripped = src
    .replace(/^import[\s\S]*?from\s+'[^']+'\n/gm, '')
    .replace(/export default\s*\{[\s\S]*$/m, '')

  const sandbox = {
    console,
    URL,
    Buffer,
    // 渲染函数体里引用到但这些用例走不到的东西
    defineTool: (x) => x,
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${stripped}\n;globalThis.__r = { renderVideoStatus, render3dStatus, previewLine }`,
    sandbox,
  )
  return sandbox.__r
}

/** 取"预览地址"那一行的下标（没有则 -1）。 */
const previewIdx = (text) => text.split('\n').findIndex((l) => /^预览地址（仅本机可访问）：/.test(l))

test('⚠️ 回归：renderVideoStatus 的预览地址必须是**最后一行**（卡片才渲染得出来）', () => {
  const { renderVideoStatus } = loadRenderers()
  const out = renderVideoStatus({
    taskId: 't-1',
    status: 'succeeded',
    videos: [{ relativePath: 'ark-output/a.mp4', bytes: 2048, previewUrl: '/dsh-ark/asset?id=aaa' }],
  })

  const lines = out.split('\n').filter((l) => l.trim() !== '')
  const idx = previewIdx(out)
  assert.ok(idx >= 0, `视频输出必须有预览地址行，实际：\n${out}`)
  // ⚠️ 关键：地址行之后**一行都不能有**。曾经把交付提醒放在它后面，
  // 结果预览地址不再是最后一行 —— 用户的预览图**直接不显示了**。
  assert.equal(
    lines.at(-1),
    lines[idx],
    `预览地址必须是最后一行（之后不得有内容），实际最后一行：${JSON.stringify(lines.at(-1))}`,
  )
  // 提醒仍然要在（只是移到地址**之前**）
  const remindIdx = lines.findIndex((l) => /present/.test(l))
  assert.ok(remindIdx >= 0, '交付提醒不能丢')
  assert.ok(remindIdx < idx, `交付提醒必须排在预览地址之前：remind@${remindIdx} preview@${idx}`)
})

test('⚠️ 回归：render3dStatus 的地址在 warnings 之后、且是最后一行', () => {
  const { render3dStatus } = loadRenderers()
  const out = render3dStatus({
    taskId: 't-2',
    status: 'succeeded',
    models: [{ relativePath: 'ark-output/a.glb', bytes: 4096, previewUrl: '/dsh-ark/asset?id=bbb' }],
    warnings: ['⚠️ 某个非致命问题'],
  })

  const lines = out.split('\n').filter((l) => l.trim() !== '')
  const idx = previewIdx(out)
  const warnIdx = lines.findIndex((l) => l.includes('某个非致命问题'))
  assert.ok(idx >= 0, `3D 输出必须有预览地址行，实际：\n${out}`)
  assert.ok(warnIdx >= 0, '本用例应当带上 warning')
  assert.ok(warnIdx < idx, `warnings 必须排在预览地址之前（否则把卡片顶上去）：warn@${warnIdx} preview@${idx}`)
  assert.equal(lines.at(-1), lines[idx], '预览地址必须是最后一行')
})

test('⚠️ 回归：产物缺 previewUrl 时，输出仍干净**且交付提醒不能跟着消失**', () => {
  const { renderVideoStatus, render3dStatus } = loadRenderers()
  const v = renderVideoStatus({
    taskId: 't-3',
    status: 'succeeded',
    videos: [{ relativePath: 'ark-output/a.mp4', bytes: 1024 }],
  })
  const m = render3dStatus({
    taskId: 't-4',
    status: 'succeeded',
    models: [{ relativePath: 'ark-output/a.glb', bytes: 1024 }],
  })
  for (const [label, out] of [['视频', v], ['3D', m]]) {
    assert.equal(previewIdx(out), -1, `${label}：没有 previewUrl 时不该凭空造出预览行`)
    assert.equal(/[\s\n]$/.test(out), false, `${label}：不该以空白结尾`)
    assert.equal(out.split('\n').some((l) => l === ''), false, `${label}：不该出现空行`)

    // ⚠️ 独立审查发现的耦合：曾经"没有地址"会把**交付提醒也一起删掉**，
    // 于是模型手上一条提示都没有。提醒必须独立于地址存在。
    assert.match(out, /present/, `${label}：没有预览地址时，交付提醒不能跟着消失`)
    // 而且这时**不能**声明有预览地址 —— 那会是假话。
    //
    // ⚠️ 判据必须落在**代码里可能出现的措辞**上。这里曾经写
    // `!out.includes('预览地址已在上方')`，而那句话在实现里**已经不存在了** ——
    // 于是断言恒为真、永远不可能失败，是又一个**死断言**（本项目已栽过两次）。
    // 改成检查"任何声称有预览地址的措辞"，这样实现若哪天又去提地址就会红。
    assert.equal(
      /预览地址[^\n]*[（(]仅本机可访问[）)]/.test(out),
      false,
      `${label}：没有地址时不得声称有预览地址（会指向不存在的东西）`,
    )
    assert.equal(
      /地址(已)?在上方|见上方地址|上面的预览/.test(out),
      false,
      `${label}：没有地址时不得用"地址在上方"这类指代`,
    )
  }
})

/**
 * ⚠️ 回归（假绿修复）：源码级守卫必须**真的能抓到**"预览行之后多了一行"。
 *
 * 这一条测的是**测试自己**：把变异注入一份临时代码，确认守卫会红。
 * 之前那种"数 previewLine( 后面是不是紧跟 ]"的写法抓不到这种变异 ——
 * 追加一行之后形状没变。这里改成真正执行渲染函数。
 */
test('⚠️ 回归：守卫能抓到"预览行之后追加一行"的变异（测测试本身）', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  // 变异：在视频返回数组的 previewLine 之后插一行
  const mutated = src.replace(
    /(previewLine\(result\.videos\),)/,
    "$1\n    'MUTANT-TRAILING-LINE',",
  )
  assert.notEqual(mutated, src, '变异必须真的改到源码（否则这条测试形同虚设）')

  // 在沙箱里跑**变异版**，断言输出里确实多了一行 —— 证明上面那两条断言有用
  const stripped = mutated
    .replace(/^import[\s\S]*?from\s+'[^']+'\n/gm, '')
    .replace(/export default\s*\{[\s\S]*$/m, '')
  const sandbox = { console, URL, Buffer, defineTool: (x) => x }
  vm.createContext(sandbox)
  vm.runInContext(`${stripped}\n;globalThis.__r = { renderVideoStatus }`, sandbox)

  const out = sandbox.__r.renderVideoStatus({
    taskId: 't-5',
    status: 'succeeded',
    videos: [{ relativePath: 'a.mp4', bytes: 1024, previewUrl: '/dsh-ark/asset?id=ccc' }],
  })
  const lines = out.split('\n').filter((l) => l.trim() !== '')
  const idx = previewIdx(out)
  // 变异版里预览地址**不再是最后一行** —— 上面那两条断言正是这样写的，所以它们会红。
  assert.notEqual(
    lines.at(-1),
    lines[idx],
    '变异版应当让预览地址不再是最后一行 —— 否则上面两条断言的写法已经失效，必须改写法',
  )
  assert.ok(lines.at(-1).includes('MUTANT-TRAILING-LINE'), '变异标记应当出现在末尾')
})
