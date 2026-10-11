/**
 * 产物落盘边界回归测试（安全面）。
 *
 * 钉住一个**实测复现过**的问题：`ArtifactStore` 原先直接用
 * `path.resolve(cwd, dir)` 当落点，于是
 *   · `config.output.dir: '../../x'`  → 写到工作区外
 *   · `config.output.dir: 'D:\output'` → 写到工作区外
 *   · 工作区内的 junction / 符号链接指向界外 → 同样写到界外
 * 产物是用户数据，写到意料之外的位置既难发现也难清理。
 *
 * 判定必须两层（词法 + realpath）：只做词法挡不住 junction，
 * 只做 realpath 又对"尚未创建的目录"无从下手 —— 所以是对"最深已存在祖先"取 realpath。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { assertInsideWorkspace, isInside } from '../lib/path-safety.mjs'

/** 造一个"工作区 + 界外目录"的场景；失败时清理并返回 null。 */
async function scene({ withJunction = false } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-wb-'))
  const cwd = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  await fsp.mkdir(cwd, { recursive: true })
  await fsp.mkdir(outside, { recursive: true })

  let junction = null
  if (withJunction) {
    const link = path.join(cwd, 'linked-out')
    try {
      await fsp.symlink(outside, link, 'junction')
      junction = link
    } catch {
      // 本机不允许创建链接：调用方跳过而不是假绿
      await fsp.rm(base, { recursive: true, force: true })
      return null
    }
  }
  return { base, cwd, outside, junction, cleanup: () => fsp.rm(base, { recursive: true, force: true }) }
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

test('isInside：不能把 "..foo" 这类合法名字误判为逃逸', () => {
  const root = path.resolve('/ws')
  assert.equal(isInside(root, path.join(root, 'a')), true)
  assert.equal(isInside(root, path.join(root, 'a', 'b')), true)
  assert.equal(isInside(root, root), true)
  // 以两个点开头、但确实是工作区内的名字
  assert.equal(isInside(root, path.join(root, '..foo')), true)
  assert.equal(isInside(root, path.join(root, '..foo', 'bar')), true)
  // 真正逃逸
  assert.equal(isInside(root, path.resolve(root, '..')), false)
  assert.equal(isInside(root, path.resolve(root, '..', 'x')), false)
  assert.equal(isInside(root, path.resolve('/elsewhere')), false)
})

test('产物落盘：合法的相对子目录照常放行', async () => {
  const s = await scene()
  if (!s) return
  try {
    for (const dir of ['ark-output', 'out/2026', '.cache', 'a/b/c']) {
      const store = new ArtifactStore({ cwd: s.cwd, dir })
      const saved = await store.save({ bytes: BYTES, hint: 't', ext: 'bin' })
      assert.ok(saved.path.startsWith(s.cwd), `${dir} 应落在工作区内，实际 ${saved.path}`)
      assert.deepEqual(new Uint8Array(await fsp.readFile(saved.path)), BYTES)
    }
  } finally {
    await s.cleanup()
  }
})

test('产物落盘：词法逃逸被拒绝，且不在界外留下任何东西', async () => {
  const s = await scene()
  if (!s) return
  try {
    for (const dir of ['../escaped', '../../escaped', '../../../escaped', path.join(s.base, 'abs'), 'C:\\']) {
      const store = new ArtifactStore({ cwd: s.cwd, dir })
      await assert.rejects(
        () => store.save({ bytes: BYTES, hint: 't', ext: 'bin' }),
        (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /工作区内/.test(err.message),
        `${dir} 应被拒绝`,
      )
    }
    // 关键：拒绝必须发生在 mkdir 之前，否则会留下一堆空目录
    assert.deepEqual(await fsp.readdir(s.outside), [], '界外目录不应被创建或被写入')
    assert.deepEqual(
      (await fsp.readdir(s.base)).sort(),
      ['outside', 'workspace'],
      '界外不应出现新目录',
    )
  } finally {
    await s.cleanup()
  }
})

test('产物落盘：工作区内 junction 指向界外时也拒绝（真实路径层）', async (t) => {
  const s = await scene({ withJunction: true })
  if (!s) return t.skip('本机不允许创建目录链接，跳过')

  try {
    // 链接自身字面上在 cwd 内 —— 只做词法判定会放行
    assert.ok(isInside(s.cwd, s.junction), '前提：链接路径字面上在工作区内')

    for (const dir of ['linked-out', 'linked-out/sub', 'linked-out/deep/nested']) {
      const store = new ArtifactStore({ cwd: s.cwd, dir })
      await assert.rejects(
        () => store.save({ bytes: BYTES, hint: 't', ext: 'bin' }),
        (err) =>
          err.code === ARK_ERROR_CODES.INVALID_PARAMETER
          && /真实路径|符号链接|junction/.test(err.message),
        `${dir} 应因真实路径逃逸被拒绝`,
      )
    }
    assert.deepEqual(await fsp.readdir(s.outside), [], '界外目录不应被写入')
  } finally {
    await s.cleanup()
  }
})

test('assertInsideWorkspace：工作区自身不存在时也能判定（产物首次落盘）', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-wb2-'))
  const notYet = path.join(base, 'ws-does-not-exist')
  try {
    // 工作区与目标都不存在：合法相对路径应放行（否则首次使用就无法落盘）
    const ok = await assertInsideWorkspace({
      root: notYet,
      target: path.join(notYet, 'ark-output'),
      label: '测试',
    })
    assert.equal(ok, path.join(notYet, 'ark-output'))

    // 同一前提下，逃逸仍要被拦住
    await assert.rejects(
      () =>
        assertInsideWorkspace({
          root: notYet,
          target: path.resolve(notYet, '..', 'escaped'),
          label: '测试',
        }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
  } finally {
    await fsp.rm(base, { recursive: true, force: true })
  }
})
