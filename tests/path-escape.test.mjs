/**
 * 路径越界回归测试（安全面）。
 *
 * 这些用例钉住的是一个**已实测复现过的真实漏洞**：本地素材的包含关系若只做词法判定
 * （path.resolve + path.relative），就会被**工作区内的 junction / 符号链接**绕过 ——
 * 链接自身字面上在 cwd 内，目标却在工作区外，于是界外文件被读取后塞进发往上游的
 * 请求体（`ark_transcribe` 的场景下就是直接外泄音频内容）。
 *
 * 判定必须在 realpath 之后做。任何人把 realpath 去掉，这里必须红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { transcribe } from '../lib/volc-asr.mjs'
import { createVideoTask } from '../lib/ark-video.mjs'

function testConfig() {
  return resolveConfig({
    ark: { baseUrl: 'https://example.invalid/api/v3', requestTimeoutMs: 5000, rateLimitRetries: 0 },
  })
}

/** 方舟侧凭据（视频用例用）。 */
function fakeCreds() {
  return createCredentialResolver({ env: { ARK_API_KEY: 'test-key' } })
}

/** 语音侧凭据（转写用例用；语音与方舟是两套独立的 Key）。 */
function speechCreds() {
  return createCredentialResolver({ env: { VOLCENGINE_SPEECH_API_KEY: 'test-key' } })
}

/** 记录请求体的 mock fetch；返回 200 让流程能继续到"是否读到了内容"这一步。 */
function recordingFetch(payload) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

/**
 * 建一个"工作区 + 界外机密文件 + 指向界外的链接"的现场。
 * @returns {Promise<{ cwd: string, outside: string, linkName: string, cleanup: () => Promise<void> }|null>}
 *   返回 null 表示本机不允许创建链接（无权限/策略限制）⇒ 用例跳过而不是假绿。
 */
async function setupEscapeScene(kind) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-escape-'))
  const cwd = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'secret.mp3'), Buffer.from('TOP-SECRET-OUTSIDE-CONTENT'))

  const linkPath = path.join(cwd, 'linked')
  try {
    await fs.symlink(outside, linkPath, kind)
  } catch {
    await fs.rm(base, { recursive: true, force: true })
    return null
  }
  return {
    cwd,
    outside,
    linkName: 'linked/secret.mp3',
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  }
}

test('ark_transcribe：工作区内符号链接指向界外时，拒绝读取（不得外泄内容）', async (t) => {
  const scene = await setupEscapeScene('junction')
  if (!scene) return t.skip('本机不允许创建目录链接，跳过')

  const impl = recordingFetch({ result: { text: 'ok' } })
  try {
    await assert.rejects(
      () =>
        transcribe(
          {
            config: testConfig(),
            creds: speechCreds(),
            cwd: scene.cwd,
            audioPath: scene.linkName,
          },
          { fetchImpl: impl },
        ),
      (err) =>
        err.code === ARK_ERROR_CODES.INVALID_PARAMETER
        && /符号链接逃逸|工作区外/.test(err.message),
    )
    // 最关键的一条：请求根本没发出去，界外内容不可能出现在请求体里。
    assert.equal(impl.calls.length, 0, '越界素材不应触发任何上游请求')
  } finally {
    await scene.cleanup()
  }
})

test('ark_generate_video：工作区内符号链接指向界外时，拒绝读取参考素材', async (t) => {
  const scene = await setupEscapeScene('junction')
  if (!scene) return t.skip('本机不允许创建目录链接，跳过')

  const impl = recordingFetch({ id: 'cgt-escape', status: 'queued' })
  try {
    await assert.rejects(
      () =>
        createVideoTask(
          {
            config: testConfig(),
            creds: fakeCreds(),
            cwd: scene.cwd,
            prompt: 'x',
            firstFrame: scene.linkName,
          },
          { fetchImpl: impl },
        ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /越界/.test(err.message),
    )
    assert.equal(impl.calls.length, 0, '越界素材不应触发任何上游请求')
  } finally {
    await scene.cleanup()
  }
})

test('字面越界的相对路径仍归类为 INVALID_PARAMETER，且不泄漏界外路径是否存在', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-lexical-'))
  const cwd = path.join(base, 'ws')
  await fs.mkdir(cwd, { recursive: true })
  const impl = recordingFetch({ result: { text: 'ok' } })
  try {
    await assert.rejects(
      () =>
        transcribe(
          {
            config: testConfig(),
            creds: speechCreds(),
            cwd,
            audioPath: '../../etc/passwd',
          },
          { fetchImpl: impl },
        ),
      // 词法检查在 realpath 之前：即使该路径并不存在，也必须是 INVALID_PARAMETER 而不是 FILE，
      // 否则错误码本身就成了"界外文件是否存在"的探针。
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
    assert.equal(impl.calls.length, 0)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('回归：工作区内名为 "..foo.mp3" 的合法文件不得被误判为路径逃逸', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-dotdot-'))
  const cwd = path.join(base, 'ws')
  await fs.mkdir(cwd, { recursive: true })
  // 这个文件名以 ".." 开头，但它是工作区内的普通文件。
  // 用 rel.startsWith('..') 判定会把它的读取请求误拒。
  const weird = path.join(cwd, '..foo.mp3')
  await fs.writeFile(weird, Buffer.from([0xff, 0xfb, 0x90, 0x64]))

  const impl = recordingFetch({ result: { text: 'ok' } })
  try {
    await transcribe(
      {
        config: testConfig(),
        creds: speechCreds(),
        cwd,
        audioPath: '..foo.mp3',
      },
      { fetchImpl: impl },
    )
    assert.equal(impl.calls.length, 1, '工作区内的合法文件应当照常被读取')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})
