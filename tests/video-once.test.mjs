/**
 * `waitForVideo(…, { once: true })` 单次模式的回归测试。
 *
 * 为什么需要它：工具层 `action="status"` 的语义是"查一次，若已完成就顺手把产物拿下来"。
 * 早先的实现用 `timeoutMs: 0` 表达这个意图，但 `timeoutMs` 是**elapsed 预算**语义 ——
 * 循环第一句 `if (Date.now() >= deadline)` 立刻成立，于是：
 *   · 那次状态查询根本不会发出；
 *   · 产物永远不会被下载；
 *   · 返回 `timedOut: true`，文案还变成"仍在渲染"（把一个已完成的任务说成没完成）。
 * 这条用例钉住"单次模式必须真的查一次并下载"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { waitForVideo } from '../lib/ark-video.mjs'

function testConfig() {
  return resolveConfig({
    ark: { baseUrl: 'https://example.invalid/api/v3', requestTimeoutMs: 5000, rateLimitRetries: 0 },
  })
}

const creds = createCredentialResolver({ env: { ARK_API_KEY: 'test-key' } })

/** 记录每次请求方法与 URL 的 mock fetch。 */
function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-once-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

test('once 模式：任务已完成 ⇒ 发起 1 次 GET、下载产物落盘、零提交', async () => {
  await withWorkspace(async (cwd) => {
    const impl = recordingFetch((url) =>
      url.includes('/contents/generations/tasks/')
        ? jsonResponse({ id: 'cgt-1', status: 'succeeded', output_urls: ['https://cdn.example.com/v.mp4'] })
        : new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } }),
    )
    const store = new ArtifactStore({ cwd })

    const result = await waitForVideo(
      { config: testConfig(), creds, store, taskId: 'cgt-1', once: true },
      { fetchImpl: impl },
    )

    assert.equal(result.timedOut, false)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.videos.length, 1, '已完成的产物必须被下载落盘')
    assert.deepEqual(new Uint8Array(await fs.readFile(result.videos[0].path)), MP4)

    // 只读不写：零 POST，且只有 1 次任务查询（不是轮询）。
    assert.equal(impl.calls.filter((c) => c.method === 'POST').length, 0, '单次模式绝不允许提交')
    assert.equal(impl.calls.filter((c) => c.url.includes('/contents/generations/tasks/')).length, 1)
  })
})

test('once 模式：任务仍在渲染 ⇒ 返回现状且不轮询、不超时', async () => {
  await withWorkspace(async (cwd) => {
    let polls = 0
    const impl = recordingFetch(() => {
      polls += 1
      return jsonResponse({ id: 'cgt-2', status: { phase: 'running', message: '渲染中' } })
    })
    const store = new ArtifactStore({ cwd })

    const result = await waitForVideo(
      { config: testConfig(), creds, store, taskId: 'cgt-2', once: true },
      { fetchImpl: impl },
    )

    // status 是对象形态时也必须归一成字符串 'running'
    assert.equal(result.status, 'running')
    // 单次模式**不是**超时：它只是没查完，不能对调用方谎称"仍在渲染（因为超时）"。
    assert.equal(result.timedOut, false)
    assert.equal(polls, 1, '单次模式只允许查询一次')
    assert.deepEqual(result.videos, [])
  })
})

test('回归：timeoutMs=0 仍保持"不等了"的语义（不得被 once 改动）', async () => {
  await withWorkspace(async (cwd) => {
    let polls = 0
    const impl = recordingFetch(() => {
      polls += 1
      return jsonResponse({ id: 'cgt-3', status: 'running' })
    })
    const store = new ArtifactStore({ cwd })

    const result = await waitForVideo(
      { config: testConfig(), creds, store, taskId: 'cgt-3', timeoutMs: 0 },
      { fetchImpl: impl },
    )
    assert.equal(result.timedOut, true)
    // 预算为 0 时连一次查询都不发 —— 这正是当初误用 timeoutMs:0 表达"查一次"的根因，
    // 明确钉住它，避免有人把 once 的实现改回"靠 timeoutMs 表达"。
    assert.equal(polls, 0)
    assert.equal(result.taskId, 'cgt-3', '超时必须保留 taskId 以便后续查询')
  })
})

test('once 模式：任务失败 ⇒ 抛错而不是伪装成仍在渲染', async () => {
  await withWorkspace(async (cwd) => {
    const impl = recordingFetch(() =>
      jsonResponse({ id: 'cgt-4', status: 'failed', failure_reason: '内容审核未通过' }),
    )
    const store = new ArtifactStore({ cwd })

    await assert.rejects(
      () => waitForVideo({ config: testConfig(), creds, store, taskId: 'cgt-4', once: true }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.HTTP && /内容审核未通过/.test(err.message),
    )
  })
})
