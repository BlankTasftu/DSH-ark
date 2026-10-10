/**
 * lib/ark-video.mjs 单测：Seedance 异步视频任务。
 *
 * 全部注入 mock fetchImpl，**不发任何真实网络请求**：视频任务提交即计费，
 * 单测里出现一个真实 POST 就是一次真实扣费。
 *
 * 覆盖重点：
 *  - 提交体字段映射（content 数组、role 标注、可选字段省略）
 *  - 轮询到 succeeded 后立刻下载落盘（output_url 24h 失效）
 *  - 超时返回 timedOut 且保留 taskId，且**全程只提交一次**
 *  - failed 终态上报、取消传播、本地素材路径逃逸与超大文件被拒
 *
 * 运行：node --test "tests/*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'
import { resolveConfig, createCredentialResolver } from '../lib/config.mjs'
import { createVideoTask, getVideoTask, waitForVideo, MAX_LOCAL_MEDIA_BYTES } from '../lib/ark-video.mjs'

// ------------------------------------------------------------------ 测试脚手架

const BASE_URL = 'https://ark.example.com/api/v3'
const VIDEO_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 9, 9, 9, 9])

/** 独立 config，避免测试之间互相污染。 */
function testConfig(overrides = {}) {
  const cfg = resolveConfig({ ark: { baseUrl: BASE_URL, ...overrides } })
  return cfg
}

/** 固定凭据，杜绝测试去读真实环境变量。 */
function fakeCreds() {
  return createCredentialResolver({ credentials: undefined, env: { ARK_API_KEY: 'test-key' } })
}

/** 录制型的 mock fetch：记录每一条**真正发出**的请求，再按顺序吐出预设响应。 */
function mockFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    // 已取消的信号不该真的打到网络上：直接抛 AbortError，并单独记录一次「被拦下的调用」。
    if (init.signal?.aborted) {
      const err = abortError()
      err.blockedBySignal = true
      throw err
    }
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      signal: init.signal,
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { impl, calls }
}

/** 信号是否真的被透传到了 fetch 层（取消要求是硬性的，但已取消的信号不会被真正发出）。 */
function signalWasForwarded(init) {
  return Boolean(init?.signal)
}

function jsonResponse(body, { status = 200, requestId = 'req-test' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  })
}

function videoResponse(bytes = VIDEO_BYTES) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'x-request-id': 'req-download' },
  })
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** 每个用例一个临时工作区，产物真的落到磁盘上验证。 */
async function withWorkspace(run) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-video-'))
  try {
    return await run({ cwd, store: new ArtifactStore({ cwd }) })
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

test('createVideoTask prompt 为空时报 INVALID_PARAMETER（本地校验，不浪费一次计费提交）', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'never', status: 'queued' }))
    await assert.rejects(
      () => createVideoTask({ config: testConfig(), creds: fakeCreds(), cwd, prompt: '   ' }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /prompt 不能为空/.test(err.message),
    )
    assert.equal(calls.length, 0)
  })
})

// ------------------------------------------------------- createVideoTask 提交

test('createVideoTask 映射提交体：text + 首尾帧 role + 可选参数', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({ id: 'cgt-1', status: 'queued' }, { requestId: 'req-submit' }),
    )

    const result = await createVideoTask(
      {
        config: testConfig(),
        creds: fakeCreds(),
        cwd,
        prompt: '一只柴犬在樱花树下奔跑，慢镜头',
        firstFrame: 'https://cdn.example.com/first.png',
        lastFrame: 'https://cdn.example.com/last.png',
        ratio: '16:9',
        resolution: '720p',
        duration: 5,
        watermark: false,
        generateAudio: true,
        cameraFixed: false,
      },
      { fetchImpl: impl },
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, `${BASE_URL}/contents/generations/tasks`)
    assert.equal(calls[0].headers.Authorization, 'Bearer test-key')

    assert.deepEqual(calls[0].body, {
      model: 'doubao-seedance-2-0-260128',
      content: [
        { type: 'text', text: '一只柴犬在樱花树下奔跑，慢镜头' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/first.png' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/last.png' }, role: 'last_frame' },
      ],
      ratio: '16:9',
      resolution: '720p',
      duration: 5,
      watermark: false,
      generate_audio: true,
      camera_fixed: false,
    })

    assert.equal(result.taskId, 'cgt-1')
    assert.equal(result.status, 'queued')
    assert.equal(result.requestId, 'req-submit')
    assert.equal(result.raw.id, 'cgt-1')
  })
})

test('createVideoTask 未显式传入的可选参数一律不发（不替用户决定时长与费用）', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-2', status: 'queued' }))
    await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: '海边的日落延时' },
      { fetchImpl: impl },
    )
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['content', 'model'])
  })
})

test('createVideoTask 参考图/参考视频/参考音频都带显式 role，frames 覆盖 duration 时二者互斥', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-3', status: 'queued' }))
    await createVideoTask(
      {
        config: testConfig(),
        creds: fakeCreds(),
        cwd,
        prompt: '续写这个镜头',
        referenceImages: ['https://cdn.example.com/ref.png'],
        referenceVideo: 'https://cdn.example.com/src.mp4',
        referenceAudio: 'data:audio/mpeg;base64,AAAA',
        frames: 121,
      },
      { fetchImpl: impl },
    )
    const roles = calls[0].body.content.slice(1).map((item) => item.role)
    assert.deepEqual(roles, ['reference_image', 'reference_video', 'reference_audio'])
    const videoBlock = calls[0].body.content.find((item) => item.type === 'video_url')
    assert.equal(videoBlock.video_url.url, 'https://cdn.example.com/src.mp4')
    assert.equal(calls[0].body.frames, 121)

    // duration 与 frames 同时给：明确报错，不静默丢弃其中一个。
    const conflict = mockFetch(() => jsonResponse({ id: 'cgt-x', status: 'queued' }))
    await assert.rejects(
      () =>
        createVideoTask(
          { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x', duration: 5, frames: 121 },
          { fetchImpl: conflict.impl },
        ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /duration 与 frames 互斥/.test(err.message),
    )
    assert.equal(conflict.calls.length, 0)
  })
})

test('createVideoTask 402/400 参数错误只发一次请求（不因失败重试而重复提交）', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({ error: { code: 'InvalidParameter', message: 'resolution 不支持' } }, { status: 400 }),
    )
    await assert.rejects(
      () => createVideoTask({ config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x' }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
    assert.equal(calls.length, 1)
  })
})

test('createVideoTask 429 退避重试（限流时上游未建任务，重试不产生重复计费）', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch((_call, index) => {
      if (index === 0) {
        return jsonResponse({ error: { code: 'ModelAccountIpmRateLimitExceeded', message: 'too many' } }, { status: 429 })
      }
      return jsonResponse({ id: 'cgt-4', status: 'queued' })
    })
    const result = await createVideoTask(
      { config: testConfig({ rateLimitBackoffMs: 1 }), creds: fakeCreds(), cwd, prompt: 'x' },
      { fetchImpl: impl },
    )
    assert.equal(calls.length, 2)
    assert.equal(result.taskId, 'cgt-4')
  })
})

test('createVideoTask 上游没给任务 id 时报 BAD_RESPONSE（无 id 无法对账，禁止重提）', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ status: 'queued' }))
    await assert.rejects(
      () => createVideoTask({ config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x' }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /不要重复提交/.test(err.message),
    )
    assert.equal(calls.length, 1)
  })
})

// ------------------------------------------------------------- 查询与轮询

test('getVideoTask 用 GET 查询同一个 id，兼容 status 字符串与 status.phase 两种形态', async () => {
  await withWorkspace(async ({ cwd }) => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({ id: 'cgt-5', status: { phase: 'running', message: '渲染中' }, output_urls: [] }),
    )
    const one = await getVideoTask({ config: testConfig(), creds: fakeCreds(), cwd, taskId: 'cgt-5' }, { fetchImpl: impl })
    assert.equal(one.status, 'running')
    assert.equal(one.taskId, 'cgt-5')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].url, `${BASE_URL}/contents/generations/tasks/cgt-5`)

    const flat = mockFetch(() =>
      jsonResponse({ id: 'cgt-6', status: 'succeeded', output_url: 'https://cdn.example.com/a.mp4' }),
    )
    const two = await getVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, taskId: 'cgt-6' },
      { fetchImpl: flat.impl },
    )
    assert.equal(two.status, 'succeeded')
    assert.deepEqual(two.outputUrls, ['https://cdn.example.com/a.mp4'])
  })
})

test('waitForVideo 轮询到 succeeded 后立刻下载落盘（output_url 24h 失效）', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const { impl, calls } = mockFetch((call) => {
      if (call.method === 'POST') return jsonResponse({ id: 'cgt-7', status: 'queued' })
      if (call.url === `${BASE_URL}/contents/generations/tasks/cgt-7`) {
        const statuses = ['queued', 'running', 'succeeded']
        const index = calls.filter((c) => c.url === call.url).length - 1
        return jsonResponse({
          id: 'cgt-7',
          status: statuses[Math.min(index, statuses.length - 1)],
          output_urls: index >= 2 ? ['https://tos.example.com/out.mp4?sig=abc'] : [],
        })
      }
      if (call.url.startsWith('https://tos.example.com/')) return videoResponse()
      throw new Error(`意外的请求：${call.url}`)
    })

    const submitted = await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: '樱花树下的柴犬' },
      { fetchImpl: impl },
    )
    const result = await waitForVideo(
      { config: testConfig(), creds: fakeCreds(), store, taskId: submitted.taskId, timeoutMs: 5_000, pollIntervalMs: 1, prompt: '樱花树下的柴犬' },
      { fetchImpl: impl },
    )

    assert.equal(result.timedOut, false)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.taskId, 'cgt-7')
    assert.equal(result.videos.length, 1)
    const [saved] = result.videos
    assert.match(saved.name, /\.mp4$/)
    assert.equal(saved.mime, 'video/mp4')
    assert.deepEqual(new Uint8Array(await fs.readFile(saved.path)), VIDEO_BYTES)
    assert.equal(saved.relativePath, path.posix.join('ark-output', saved.name))
    // 全程只有一次 POST：其余都是同一个 taskId 的 GET 与产物下载。
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
    assert.ok(calls.some((c) => c.url === 'https://tos.example.com/out.mp4?sig=abc'))
  })
})

test('waitForVideo 超时返回 timedOut 且保留 taskId，全程只提交一次、绝不重提', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    let polls = 0
    const { impl, calls } = mockFetch((call) => {
      if (call.method === 'POST') return jsonResponse({ id: 'cgt-slow', status: 'queued' })
      polls += 1
      return jsonResponse({ id: 'cgt-slow', status: 'running' })
    })

    const submitted = await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: '渲染很久的视频' },
      { fetchImpl: impl },
    )
    const result = await waitForVideo(
      { config: testConfig(), creds: fakeCreds(), store, taskId: submitted.taskId, timeoutMs: 30, pollIntervalMs: 5 },
      { fetchImpl: impl },
    )

    assert.equal(result.timedOut, true)
    // 「还在渲染」与「失败」必须区分：超时不是错误，taskId 必须带回去继续查。
    assert.equal(result.taskId, 'cgt-slow')
    assert.equal(result.status, 'running')
    assert.deepEqual(result.videos, [])
    assert.ok(polls >= 1)
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
  })
})

test('waitForVideo 预算为 0 时不做无意义查询，直接回超时并保留 taskId', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-none', status: 'queued' }))
    const result = await waitForVideo(
      { config: testConfig(), creds: fakeCreds(), store, taskId: 'cgt-none', timeoutMs: 0, pollIntervalMs: 1 },
      { fetchImpl: impl },
    )
    assert.equal(result.timedOut, true)
    assert.equal(result.taskId, 'cgt-none')
    assert.equal(result.status, 'queued')
    assert.equal(calls.length, 0)
  })
})

test('waitForVideo 对 status=failed 立刻上报失败原因，不继续轮询', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        id: 'cgt-bad',
        status: 'failed',
        failure_reason: 'OutputVideoSensitiveContentDetected',
      }),
    )
    await assert.rejects(
      () =>
        waitForVideo(
          { config: testConfig(), creds: fakeCreds(), store, taskId: 'cgt-bad', timeoutMs: 5_000, pollIntervalMs: 1 },
          { fetchImpl: impl },
        ),
      (err) =>
        err.code === ARK_ERROR_CODES.HTTP
        && /cgt-bad/.test(err.message)
        && /OutputVideoSensitiveContentDetected/.test(err.message),
    )
    assert.equal(calls.length, 1)
  })
})

test('waitForVideo 报 succeeded 但没有产物 URL 时报 BAD_RESPONSE（不假装成功）', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const { impl } = mockFetch(() => jsonResponse({ id: 'cgt-empty', status: 'succeeded' }))
    await assert.rejects(
      () => waitForVideo({ config: testConfig(), creds: fakeCreds(), store, taskId: 'cgt-empty' }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /没有 output_url/.test(err.message),
    )
  })
})

test('waitForVideo 缺少 taskId 时直接报 INVALID_PARAMETER（不给「顺手提交一个」的机会）', async () => {
  await withWorkspace(async ({ store }) => {
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'never', status: 'queued' }))
    await assert.rejects(
      () => waitForVideo({ config: testConfig(), creds: fakeCreds(), store, taskId: '' }, { fetchImpl: impl }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /缺少 taskId/.test(err.message),
    )
    assert.equal(calls.length, 0)
  })
})

test('waitForVideo 下载失败时仍返回成功与 taskId，并把失败原因放进 warnings', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const { impl } = mockFetch((call) => {
      if (call.method === 'POST') return jsonResponse({ id: 'cgt-dl', status: 'queued' })
      if (call.url.startsWith('https://tos.example.com/')) {
        return new Response('expired', { status: 403, headers: { 'content-type': 'text/plain' } })
      }
      return jsonResponse({ id: 'cgt-dl', status: 'succeeded', output_urls: ['https://tos.example.com/gone.mp4'] })
    })
    const submitted = await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x' },
      { fetchImpl: impl },
    )
    const result = await waitForVideo(
      { config: testConfig(), creds: fakeCreds(), store, taskId: submitted.taskId, timeoutMs: 2_000, pollIntervalMs: 1 },
      { fetchImpl: impl },
    )
    // 生成已计费成功，不能让下载失败把 taskId 一起吞掉：仍然回任务与 taskId，只在 warnings 里报下载问题。
    assert.equal(result.timedOut, false)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.taskId, 'cgt-dl')
    assert.deepEqual(result.videos, [])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /产物下载失败/)
  })
})

// ------------------------------------------------------------------ 取消传播

test('waitForVideo 轮询 sleep 期间取消 → 抛 ABORTED，且不重新提交任务', async () => {
  await withWorkspace(async ({ cwd, store }) => {
    const controller = new AbortController()
    const forwarded = []
    const { impl, calls } = mockFetch((call, index) => {
      if (call.method === 'POST') return jsonResponse({ id: 'cgt-abort', status: 'queued' })
      // 第一次查询返回「还在渲染」，随后（函数正处于轮询 sleep 中）调用方取消。
      controller.abort()
      return jsonResponse({ id: 'cgt-abort', status: 'running' })
    })
    const recording = async (url, init) => {
      forwarded.push(signalWasForwarded(init))
      // 已取消的信号不该真的发出：这里直接抛 AbortError，模拟 fetch 的取消语义。
      if (init?.signal?.aborted) throw abortError()
      return impl(url, init)
    }

    const submitted = await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x' },
      { fetchImpl: recording, signal: controller.signal },
    )
    assert.equal(submitted.taskId, 'cgt-abort')

    await assert.rejects(
      () =>
        waitForVideo(
          {
            config: testConfig(),
            creds: fakeCreds(),
            store,
            taskId: submitted.taskId,
            timeoutMs: 60_000,
            pollIntervalMs: 60_000,
          },
          { fetchImpl: recording, signal: controller.signal },
        ),
      (err) => err.code === ARK_ERROR_CODES.ABORTED,
    )
    // 取消只影响轮询：提交请求本身仍然只发生过一次。
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
    assert.ok(forwarded.every(Boolean), 'signal 必须透传到每一次 fetch')
  })
})

test('createVideoTask 在已取消的 signal 下不发请求，并抛 ABORTED', async () => {
  await withWorkspace(async ({ cwd }) => {
    const controller = new AbortController()
    controller.abort()
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'never', status: 'queued' }))
    let forwarded = false
    const recording = async (url, init) => {
      forwarded = signalWasForwarded(init)
      if (init?.signal?.aborted) throw abortError()
      return impl(url, init)
    }
    await assert.rejects(
      () =>
        createVideoTask(
          { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x' },
          { fetchImpl: recording, signal: controller.signal },
        ),
      (err) => err.code === ARK_ERROR_CODES.ABORTED,
    )
    assert.equal(calls.length, 0)
    assert.ok(forwarded, 'signal 必须透传到 fetch 层')
  })
})

// ------------------------------------------------------------------ 素材约束

test('本地参考图读成 data URL；路径逃逸 cwd 被拒', async () => {
  await withWorkspace(async ({ cwd }) => {
    await fs.writeFile(path.join(cwd, 'first.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-8', status: 'queued' }))
    await createVideoTask(
      { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x', firstFrame: 'first.png' },
      { fetchImpl: impl },
    )
    assert.match(calls[0].body.content[1].image_url.url, /^data:image\/png;base64,/)

    const escape = mockFetch(() => jsonResponse({ id: 'cgt-9', status: 'queued' }))
    await assert.rejects(
      () =>
        createVideoTask(
          { config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x', firstFrame: '../../etc/passwd' },
          { fetchImpl: escape.impl },
        ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /越界/.test(err.message),
    )
    assert.equal(escape.calls.length, 0)
  })
})

test('超大本地素材（>8MB）被拒并提示改用 URL，不读进内存', async () => {
  await withWorkspace(async ({ cwd }) => {
    const huge = path.join(cwd, 'huge.png')
    await fs.writeFile(huge, Buffer.alloc(0))
    await fs.truncate(huge, MAX_LOCAL_MEDIA_BYTES + 1)

    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-10', status: 'queued' }))
    await assert.rejects(
      () => createVideoTask({ config: testConfig(), creds: fakeCreds(), cwd, prompt: 'x', firstFrame: huge }, { fetchImpl: impl }),
      (err) =>
        err.code === ARK_ERROR_CODES.INVALID_PARAMETER
        && /超过内联上限/.test(err.message)
        && /改用 URL/.test(err.message),
    )
    assert.equal(calls.length, 0)
  })
})

test('本地视频/音频默认被拒（数据面不接受其 data URL，本地拒绝省一次 400 与误判）', async () => {
  await withWorkspace(async ({ cwd }) => {
    await fs.writeFile(path.join(cwd, 'src.mp4'), VIDEO_BYTES)
    const { impl, calls } = mockFetch(() => jsonResponse({ id: 'cgt-11', status: 'queued' }))
    await assert.rejects(
      () =>
        createVideoTask(
          { config: testConfig(), creds: fakeCreds(), cwd, prompt: '续写', referenceVideo: 'src.mp4' },
          { fetchImpl: impl },
        ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /只接受 http\(s\) URL/.test(err.message),
    )
    assert.equal(calls.length, 0)

    // 显式打开开关（例如自建网关支持内联）后按 data URL 提交。
    const allowed = mockFetch(() => jsonResponse({ id: 'cgt-12', status: 'queued' }))
    await createVideoTask(
      {
        config: testConfig(),
        creds: fakeCreds(),
        cwd,
        prompt: '续写',
        referenceVideo: 'src.mp4',
        allowLocalVideoAudio: true,
      },
      { fetchImpl: allowed.impl },
    )
    assert.match(allowed.calls[0].body.content[1].video_url.url, /^data:video\/mp4;base64,/)
    assert.equal(allowed.calls[0].body.content[1].role, 'reference_video')
  })
})
