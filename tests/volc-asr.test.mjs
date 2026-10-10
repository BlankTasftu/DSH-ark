/**
 * lib/volc-asr.mjs 单测。
 *
 * 这个模块**没有实测过线上协议**，所以测试锁死的是两件事：
 *  1. `transcribe()` 在协议实测确认之前一律抛 NOT_IMPLEMENTED，且**绝不发网络请求**；
 *  2. 实测通过后要复用的两个构件（路径校验、凭据解析）行为正确。
 *
 * 运行：node --test "tests/*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ASR_UNVERIFIED,
  ASR_VERIFIED,
  DEFAULT_MAX_AUDIO_BYTES,
  asrAudioFormat,
  resolveAsrCredentials,
  resolveAudioFile,
  transcribe,
} from '../lib/volc-asr.mjs'
import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { resolveConfig } from '../lib/config.mjs'

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-asr-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/** 只提供新版 API Key 的凭据（ASR 只支持新版鉴权）。 */
function apiKeyCreds() {
  return {
    resolve: async (ref) => (ref === 'VOLCENGINE_SPEECH_API_KEY' ? 'api-key-1' : undefined),
    require: async () => undefined,
  }
}

/** 记录请求并按需回放的 mock fetch。 */
function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const headers = { ...(init?.headers || {}) }
    calls.push({ url: String(url), method: init?.method, headers, body: init?.body ? JSON.parse(init.body) : undefined })
    if (!handler) throw new Error('本用例不应发出请求')
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

/** 一次实测同构的成功响应。 */
const asrSuccess = (text = '你好呀！喜欢我送给你的礼物吗？') =>
  new Response(
    JSON.stringify({
      audio_info: { duration: 3240 },
      result: {
        text,
        utterances: [
          { text: '你好呀！', start_time: 330, end_time: 930 },
          { text: '喜欢我送给你的礼物吗？', start_time: 1410, end_time: 3010 },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'X-Tt-Logid': 'log-asr-1' } },
  )

/** 实测同构的错误响应：HTTP 403 + 响应体 header.code（这个形态很容易被漏判成成功）。 */
const asrFailure = (code, message, status = 403) =>
  new Response(JSON.stringify({ header: { reqid: 'r-1', code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// 铁律：单测绝不发真实网络请求（未实测的 ASR 更是如此）。
globalThis.fetch = () => {
  throw new Error('单测禁止真实网络请求')
}

// ---------------------------------------------------------------- 路径校验

test('resolveAudioFile：工作区内的文件返回绝对路径、相对路径与体积', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'voice.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x64]))
    const file = await resolveAudioFile({ audioPath: 'voice.mp3', cwd })
    assert.equal(file.path, path.join(cwd, 'voice.mp3'))
    assert.equal(file.relativePath, 'voice.mp3')
    assert.equal(file.bytes, 4)
  })
})

test('resolveAudioFile：拒绝 ../ 逃逸与工作区外的绝对路径', async () => {
  await withWorkspace(async (cwd) => {
    const outside = path.join(path.dirname(cwd), 'outside.mp3')
    await fs.writeFile(outside, Buffer.from([1, 2, 3]))
    try {
      await assert.rejects(
        () => resolveAudioFile({ audioPath: '../outside.mp3', cwd }),
        (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /工作区内/.test(err.message),
      )
      await assert.rejects(
        () => resolveAudioFile({ audioPath: outside, cwd }),
        (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
      )
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})

test('resolveAudioFile：不存在的文件报 FILE，目录与空文件报 INVALID_PARAMETER', async () => {
  await withWorkspace(async (cwd) => {
    await assert.rejects(
      () => resolveAudioFile({ audioPath: 'missing.mp3', cwd }),
      (err) => err.code === ARK_ERROR_CODES.FILE,
    )

    await fs.mkdir(path.join(cwd, 'a-directory'))
    await assert.rejects(
      () => resolveAudioFile({ audioPath: 'a-directory', cwd }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /不是普通文件/.test(err.message),
    )

    await fs.writeFile(path.join(cwd, 'empty.mp3'), Buffer.alloc(0))
    await assert.rejects(
      () => resolveAudioFile({ audioPath: 'empty.mp3', cwd }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /为空/.test(err.message),
    )
  })
})

test('resolveAudioFile：超过体积上限直接拒绝，避免撑爆内存与请求体', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'big.wav'), Buffer.alloc(64))
    await assert.rejects(
      () => resolveAudioFile({ audioPath: 'big.wav', cwd, maxBytes: 16 }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /超过上限/.test(err.message),
    )
    const ok = await resolveAudioFile({ audioPath: 'big.wav', cwd, maxBytes: DEFAULT_MAX_AUDIO_BYTES })
    assert.equal(ok.bytes, 64)
  })
})

test('resolveAudioFile：audioPath 为空或非字符串报 INVALID_PARAMETER', async () => {
  await assert.rejects(
    () => resolveAudioFile({ audioPath: '   ' }),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
  )
  await assert.rejects(
    () => resolveAudioFile({ audioPath: 123 }),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
  )
  await assert.rejects(
    () => resolveAudioFile({}),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
  )
})

// ---------------------------------------------------------------- 凭据

test('resolveAsrCredentials：复用语音凭据解析并补上 ASR 资源 id', async () => {
  const config = resolveConfig({})
  const apiKey = await resolveAsrCredentials(config, apiKeyCreds())
  assert.deepEqual(apiKey, {
    scheme: 'apiKey',
    apiKey: 'api-key-1',
    resourceId: 'volc.seedasr.sauc.duration',
  })
})

test('resolveAsrCredentials：缺凭据报 MISSING_CREDENTIAL，缺资源 id 报 INVALID_PARAMETER', async () => {
  await assert.rejects(
    () => resolveAsrCredentials(resolveConfig({}), { resolve: async () => undefined }),
    (err) => err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL,
  )

  await assert.rejects(
    () => resolveAsrCredentials({ speech: { apiKeyCredential: 'VOLCENGINE_SPEECH_API_KEY' } }, apiKeyCreds()),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /resourceAsr/.test(err.message),
  )
})

// ---------------------------------------------------------------- transcribe

test('transcribe：走极速版端点、按实测字段发请求，转写文本与时间戳正确解析', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'voice.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]))
    const fetchImpl = recordingFetch(() => asrSuccess())

    const result = await transcribe(
      { config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'voice.mp3', cwd },
      { fetchImpl },
    )

    // ① 端点与鉴权（实测口径）
    assert.equal(fetchImpl.calls.length, 1)
    const call = fetchImpl.calls[0]
    assert.equal(call.url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers['X-Api-Key'], 'api-key-1')
    assert.equal(call.headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration')
    // 只支持新版：不得混发旧版双头
    assert.equal('X-Api-Access-Key' in call.headers, false)

    // ② 请求体字段名
    assert.equal(call.body.audio.format, 'mp3')
    assert.equal(typeof call.body.audio.data, 'string')
    assert.equal(call.body.request.model_name, 'bigmodel')
    assert.equal(call.body.request.enable_punc, true)

    // ③ 响应解析（毫秒时间戳）
    assert.equal(result.text, '你好呀！喜欢我送给你的礼物吗？')
    assert.equal(result.durationMs, 3240)
    assert.equal(result.segments.length, 2)
    assert.deepEqual(result.segments[0], { text: '你好呀！', startMs: 330, endMs: 930 })
    assert.equal(result.requestId, 'log-asr-1')
    assert.equal(result.format, 'mp3')
    assert.equal(result.bytes, 7)
  })
})

test('transcribe：HTTP 403 + 响应体 header.code 必须判为失败（不能只看 HTTP 之外的字段）', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'voice.mp3'), Buffer.from([1, 2, 3]))
    // 实测形态：资源未授权时是 403 + {"header":{"code":45000030,…}}
    const fetchImpl = recordingFetch(() => asrFailure(45_000_030, '[resource_id=x] requested resource not granted'))
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'voice.mp3', cwd }, { fetchImpl }),
      (err) =>
        err.code === ARK_ERROR_CODES.PERMISSION
        && /45000030/.test(err.message)
        && /volc\.seedasr\.sauc\.duration/.test(err.message),
    )

    // 鉴权类
    const authImpl = recordingFetch(() => asrFailure(45_000_010, 'Invalid X-Api-Key'))
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'voice.mp3', cwd }, { fetchImpl: authImpl }),
      (err) => err.code === ARK_ERROR_CODES.AUTHENTICATION,
    )

    // 资源名不被允许（旧版双头下的实测码）
    const notAllowed = recordingFetch(() => asrFailure(45_000_000, 'resourceId x is not allowed', 400))
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'voice.mp3', cwd }, { fetchImpl: notAllowed }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
  })
})

test('transcribe：缺 API Key 时报 MISSING_CREDENTIAL 并不发请求', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'voice.mp3'), Buffer.from([1, 2, 3]))
    const fetchImpl = recordingFetch(() => asrSuccess())
    await assert.rejects(
      () =>
        transcribe(
          { config: resolveConfig({}), creds: { resolve: async () => undefined }, audioPath: 'voice.mp3', cwd },
          { fetchImpl },
        ),
      (err) => err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL && /VOLCENGINE_SPEECH_API_KEY/.test(err.message),
    )
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('transcribe：成功但无文本时报 BAD_RESPONSE（空 transcript 不能当成功交付）', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'voice.mp3'), Buffer.from([1, 2, 3]))
    const fetchImpl = recordingFetch(
      () => new Response(JSON.stringify({ audio_info: { duration: 100 }, result: { text: '' } }), { status: 200 }),
    )
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'voice.mp3', cwd }, { fetchImpl }),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /没有识别到文本/.test(err.message),
    )
  })
})

test('transcribe：文件不存在 / 逃逸工作区时，在发请求之前就拒绝', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => asrSuccess())
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'nope.mp3', cwd }, { fetchImpl }),
      (err) => err.code === ARK_ERROR_CODES.FILE,
    )
    await assert.rejects(
      () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: '../../etc/passwd', cwd }, { fetchImpl }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
    assert.equal(fetchImpl.calls.length, 0, '校验失败不得发出请求')
  })
})

test('transcribe：已取消的调用直接 ABORTED，不发请求', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchImpl = recordingFetch(() => asrSuccess())
  await assert.rejects(
    () => transcribe({ config: resolveConfig({}), creds: apiKeyCreds(), audioPath: 'x.mp3' }, { signal: controller.signal, fetchImpl }),
    (err) => err.code === ARK_ERROR_CODES.ABORTED,
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('asrAudioFormat：按扩展名映射请求里的 audio.format', () => {
  assert.equal(asrAudioFormat('a.mp3'), 'mp3')
  assert.equal(asrAudioFormat('a.wav'), 'wav')
  assert.equal(asrAudioFormat('a.opus'), 'ogg_opus')
  assert.equal(asrAudioFormat('a.unknown'), 'mp3')
})

test('ASR 已实测：ASR_UNVERIFIED 应为空，且 ASR_VERIFIED 记录关键事实', () => {
  // 这条用例的意义：协议一旦实测通过，"待确认清单"必须清空 —— 留着它会让后来人以为仍未验证。
  assert.deepEqual([...ASR_UNVERIFIED], [])
  assert.ok(ASR_VERIFIED.length >= 4)
  assert.ok(ASR_VERIFIED.some((item) => /auc\/bigmodel\/recognize\/flash/.test(item)))
  assert.ok(ASR_VERIFIED.some((item) => /X-Api-Key/.test(item)))
  assert.ok(ASR_VERIFIED.some((item) => /volc\.seedasr\.sauc\.duration/.test(item)))
})
