/**
 * 超时 vs 取消的**判定顺序**回归测试。
 *
 * 真实 bug（BUG 审计 B4）：`signal` 是
 * `AbortSignal.any([调用方 signal, AbortSignal.timeout(...)])`，
 * 而 `AbortSignal.timeout` 触发时**也会**把 `signal.aborted` 置为 true。
 *
 * 原代码写的是 `if (signal.aborted || err?.name === 'AbortError')` —— 左支先命中，
 * 于是**超时被报成"调用已被取消"**。两者的含义对模型完全相反：
 *
 *   · 取消 = 调用方主动停止，**不该重试**；
 *   · 超时 = 服务端/网络慢，**可以重试**，而且应当提示缩短输入。
 *
 * 误报成"取消"会让模型放弃一次本可重试的调用。所以这是**语义**问题，不是措辞问题。
 *
 * 不发真实网络请求：fetchImpl 全部注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { generateAudio } from '../lib/volc-audio.mjs'
import { transcribe } from '../lib/volc-asr.mjs'

// ─────────────────────────────────────────────── 桩（与既有测试同一套写法）

/** 造一个"一调用就抛指定错误"的 fetch。 */
function throwingFetch(err) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    throw err
  }
  return { calls, impl }
}

const testConfig = () => resolveConfig({ ark: { rateLimitBackoffMs: 1 } })

/** 有语音 API Key 的凭据解析器（与 volc-audio.test.mjs 同款）。 */
const apiKeyCreds = () =>
  createCredentialResolver({ env: { VOLCENGINE_SPEECH_API_KEY: 'api-key-1' }, getCredentials: () => undefined })

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-tmo-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/** node/undici 的超时错误形状（AbortSignal.timeout 触发时抛的就是它）。 */
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
/** 调用方主动取消的形状。 */
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

// ─────────────────────────────────────────────── 音频生成

test('volc-audio：TimeoutError 必须报超时（可重试），不能报"已被取消"', async () => {
  await withWorkspace(async (cwd) => {
    const store = new ArtifactStore({ cwd })
    const fetchStub = throwingFetch(timeoutError())
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: '一声轻响' }, { fetchImpl: fetchStub.impl }),
      (thrown) => {
        assert.equal(thrown.code, ARK_ERROR_CODES.TIMEOUT, `TimeoutError 应归类 TIMEOUT，实际 ${thrown.code}`)
        assert.equal(thrown.retryable, true, '超时应当标记可重试')
        assert.equal(String(thrown.message).includes('取消'), false, '超时不能说成"已被取消"')
        return true
      },
    )
    assert.equal(fetchStub.calls.length, 1, '应当确实发过一次请求（否则没走到目标分支）')
  })
})

test('volc-audio：AbortError 仍报"已被取消"（别把取消也改成超时）', async () => {
  await withWorkspace(async (cwd) => {
    const store = new ArtifactStore({ cwd })
    const fetchStub = throwingFetch(abortError())
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: '一声轻响' }, { fetchImpl: fetchStub.impl }),
      (thrown) => {
        assert.equal(thrown.code, ARK_ERROR_CODES.ABORTED, `真取消应报 ABORTED，实际 ${thrown.code}`)
        assert.equal(thrown.retryable, false, '取消不该标记可重试')
        return true
      },
    )
    assert.equal(fetchStub.calls.length, 1)
  })
})

// ─────────────────────────────────────────────── 语音转写

test('volc-asr：TimeoutError 必须报超时（可重试），不能报"已被取消"', async () => {
  await withWorkspace(async (cwd) => {
    const audioPath = path.join(cwd, 'sample.mp3')
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]))

    const fetchStub = throwingFetch(timeoutError())
    await assert.rejects(
      // audioPath 用相对路径 + cwd 指到它所在的临时目录。
      // 写绝对路径会被"必须位于工作区内"的校验先拦下（那是**正确**行为，但会让这条
      // 测试走不到网络分支 —— 第一版就是这么错的，报出来的 code 是 INVALID_PARAMETER）。
      () => transcribe({ config: testConfig(), creds: apiKeyCreds(), audioPath: 'sample.mp3', cwd }, { fetchImpl: fetchStub.impl }),
      (thrown) => {
        assert.equal(thrown.code, ARK_ERROR_CODES.TIMEOUT, `TimeoutError 应归类 TIMEOUT，实际 ${thrown.code}: ${thrown.message}`)
        assert.equal(thrown.retryable, true, '超时应当标记可重试')
        assert.equal(String(thrown.message).includes('取消'), false, '超时不能说成"已被取消"')
        return true
      },
    )
    assert.equal(fetchStub.calls.length, 1, '应当确实发过一次请求（否则没走到目标分支）')
  })
})

test('volc-asr：AbortError 仍报"已被取消"', async () => {
  await withWorkspace(async (cwd) => {
    const audioPath = path.join(cwd, 'sample.mp3')
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]))

    const fetchStub = throwingFetch(abortError())
    await assert.rejects(
      () => transcribe({ config: testConfig(), creds: apiKeyCreds(), audioPath: 'sample.mp3', cwd }, { fetchImpl: fetchStub.impl }),
      (thrown) => {
        assert.equal(thrown.code, ARK_ERROR_CODES.ABORTED, `真取消应报 ABORTED，实际 ${thrown.code}: ${thrown.message}`)
        return true
      },
    )
    assert.equal(fetchStub.calls.length, 1)
  })
})
