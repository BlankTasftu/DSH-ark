/**
 * lib/volc-audio.mjs 单测：请求体组装（纯函数）+ 响应解析与落盘。
 *
 * 协议口径全部来自**实测**（2026-10-11，真实凭据），不是文档抄写：
 *   · 端点 POST /api/v3/tts/create，鉴权 X-Api-Key
 *   · 最小请求体 { model, text_prompt }
 *   · 响应 { audio: <base64>, duration, original_duration, url }
 *   · 不传 audio_config.format → 上游返回 **wav**（不是 mp3），体积约 20 倍
 *
 * 全部用例注入 mock fetchImpl，不发真实网络请求。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import {
  DEFAULT_AUDIO_FORMAT,
  MAX_REFERENCE_AUDIO,
  buildAudioRequestBody,
  generateAudio,
  normalizeAudioFormat,
} from '../lib/volc-audio.mjs'

// ------------------------------------------------------------------ 工具

/** 造一段最小 WAV（RIFF 头）。 */
function wavBytes(payload = 12) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + payload, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(24_000, 24)
  head.writeUInt32LE(48_000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(payload, 40)
  return new Uint8Array(Buffer.concat([head, Buffer.alloc(payload, 0x11)]))
}

/** 造一段最小 MP3（ID3 头）。 */
function mp3Bytes(payload = 24) {
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23])
  return new Uint8Array(Buffer.concat([head, Buffer.alloc(payload, 0x22)]))
}

function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const headers = {}
    for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v
    calls.push({
      url: String(url),
      method: init.method,
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    })
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

/** 有语音 API Key 的凭据。 */
const apiKeyCreds = () =>
  createCredentialResolver({ env: { VOLCENGINE_SPEECH_API_KEY: 'api-key-1' }, getCredentials: () => undefined })

/** 完全没有语音凭据（用于验证"缺凭据不发请求"）。 */
const noCreds = () => createCredentialResolver({ env: {}, getCredentials: () => undefined })

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-audio-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

const testConfig = () => resolveConfig({ ark: { rateLimitBackoffMs: 1 } })

// -------------------------------------------------------- 纯函数：格式

test('normalizeAudioFormat：默认 mp3，非法值报 INVALID_PARAMETER', () => {
  assert.equal(normalizeAudioFormat(undefined), 'mp3')
  assert.equal(normalizeAudioFormat('MP3'), 'mp3')
  assert.equal(normalizeAudioFormat('ogg_opus'), 'ogg_opus')
  assert.equal(DEFAULT_AUDIO_FORMAT, 'mp3')
  assert.throws(
    () => normalizeAudioFormat('flac'),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /不支持输出格式/.test(err.message),
  )
})

// -------------------------------------------------------- 纯函数：请求体

test('buildAudioRequestBody：最小形态就是 model + text_prompt + audio_config', () => {
  const { body, format } = buildAudioRequestBody({ textPrompt: '一句问候' })
  assert.equal(body.model, 'seed-audio-1.0')
  assert.equal(body.text_prompt, '一句问候')
  assert.deepEqual(body.audio_config, { format: 'mp3', sample_rate: 24_000 })
  assert.equal(format, 'mp3')
  // 没有参考时**不能**出现 references 字段（上游按它的有无切换 text_prompt 语义）
  assert.equal('references' in body, false)
})

test('buildAudioRequestBody：空 text_prompt 直接拒绝，不浪费一次计费往返', () => {
  assert.throws(
    () => buildAudioRequestBody({ textPrompt: '   ' }),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /text_prompt 不能为空/.test(err.message),
  )
})

test('buildAudioRequestBody：参考素材映射成 snake_case 字段', () => {
  const { body } = buildAudioRequestBody({
    textPrompt: '用 @音频1 的语气读：你好',
    references: [
      { audioUrl: 'https://example.com/a.mp3' },
      { audioUrl: 'https://example.com/b.mp3' },
    ],
  })
  assert.deepEqual(body.references, [
    { audio_url: 'https://example.com/a.mp3' },
    { audio_url: 'https://example.com/b.mp3' },
  ])
})

test('buildAudioRequestBody：**不接受 speaker**（音频生成模型没有音色概念）', () => {
  // 实测：把 speaker 传进去，上游不是忽略而是明确拒绝 ——
  //   HTTP 400 code=45001115 "speaker xxx not found in speaker_map, speaker_audio, or mega_info"
  // 所以 buildAudioRequestBody 必须完全不产出 speaker 字段：
  // 静默带上一个必然报错的字段，比直接不传更糟（用户会以为音色设置生效了）。
  const { body } = buildAudioRequestBody({
    textPrompt: '用温柔少女嗓音念：你好',
    // 即使调用方（旧代码 / 误用）硬塞了 speaker，也不得进入请求体
    speaker: 'zh_female_shuangkuaisisi_uranus_bigtts',
    references: [{ speaker: 'zh_female_shuangkuaisisi_uranus_bigtts' }],
  })
  assert.equal('speaker' in body, false, '请求体不得出现顶层 speaker')
  // 只含 speaker 的条目会被过滤掉；但若因此 references 为空，就不应出现该字段
  const hasSpeakerField = JSON.stringify(body).includes('"speaker"')
  assert.equal(hasSpeakerField, false, `请求体任何位置都不得出现 speaker：${JSON.stringify(body)}`)
})

test('buildAudioRequestBody：只给 speaker 的 references 被过滤为空，不产生空条目', () => {
  const { body } = buildAudioRequestBody({
    textPrompt: 'x',
    // 上游错误信息明确要求每个条目"必须且只能"给一个素材字段：
    //   "reference[0] must have exactly one of speaker/audio_data/audio_url/image_data/image_url/video_url"
    // 空对象会被上游 400 拒掉，所以本地先过滤掉。
    references: [{ speaker: 'anything' }, {}],
  })
  assert.equal('references' in body, false, '全部条目都被过滤后不应留下 references')
})

test('buildAudioRequestBody：音频与图片参考不能混用（官方限制，提前拦）', () => {
  assert.throws(
    () =>
      buildAudioRequestBody({
        textPrompt: 'x',
        references: [{ audioUrl: 'https://example.com/a.mp3' }, { imageUrl: 'https://example.com/i.png' }],
      }),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /不能混用/.test(err.message),
  )
})

test('buildAudioRequestBody：参考音频最多 3 条', () => {
  const many = Array.from({ length: MAX_REFERENCE_AUDIO + 1 }, (_, i) => ({
    audioUrl: `https://example.com/${i}.mp3`,
  }))
  assert.throws(
    () => buildAudioRequestBody({ textPrompt: 'x', references: many }),
    (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /最多 3 条/.test(err.message),
  )
})

// ------------------------------------------------------------ generateAudio

test('generateAudio：走 /tts/create，只发 X-Api-Key，音频落盘', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes()
    const impl = recordingFetch(() =>
      jsonResponse({ audio: Buffer.from(audio).toString('base64'), duration: 3.08, original_duration: 3.08, url: 'https://x/y.mp3' }),
    )
    const store = new ArtifactStore({ cwd })

    const result = await generateAudio(
      { config: testConfig(), creds: apiKeyCreds(), store, textPrompt: '一句温柔的问候。' },
      { fetchImpl: impl },
    )

    assert.equal(impl.calls.length, 1)
    const call = impl.calls[0]
    assert.equal(call.url, 'https://openspeech.bytedance.com/api/v3/tts/create')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers['X-Api-Key'], 'api-key-1')
    // 音频生成要求新版鉴权：绝不能带旧版双头
    assert.equal('X-Api-Access-Key' in call.headers, false)
    assert.equal(call.body.model, 'seed-audio-1.0')
    assert.equal(call.body.text_prompt, '一句温柔的问候。')

    assert.equal(result.durationSeconds, 3.08)
    assert.equal(result.format, 'mp3')
    assert.equal(result.audio.bytes, audio.byteLength)
    assert.deepEqual(new Uint8Array(await fs.readFile(result.audio.path)), audio)
  })
})

test('generateAudio：容器按**真实文件头**判定，而不是信任请求里的 format', async () => {
  await withWorkspace(async (cwd) => {
    // 实测发现：不传 audio_config 时上游给的是 wav（与"默认 mp3"的直觉相反）。
    // 所以即便请求写了 mp3、回来的却是 WAV，也应当按 WAV 落盘并在结果里如实反映。
    const wav = wavBytes()
    const impl = recordingFetch(() => jsonResponse({ audio: Buffer.from(wav).toString('base64'), duration: 1.2 }))
    const store = new ArtifactStore({ cwd })

    const result = await generateAudio(
      { config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x', format: 'mp3' },
      { fetchImpl: impl },
    )
    assert.equal(result.requestedFormat, 'mp3')
    assert.equal(result.format, 'wav', '应以文件头为准')
    assert.equal(result.audio.mime, 'audio/wav')
    assert.match(result.audio.name, /\.wav$/)
  })
})

test('generateAudio：缺语音 API Key 时报 MISSING_CREDENTIAL，不发请求', async () => {
  await withWorkspace(async (cwd) => {
    const impl = recordingFetch(() => jsonResponse({ audio: 'x' }))
    const store = new ArtifactStore({ cwd })

    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: noCreds(), store, textPrompt: 'x' }, { fetchImpl: impl }),
      (err) =>
        err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL
        && /API Key/.test(err.message)
        && /VOLCENGINE_SPEECH_API_KEY/.test(err.message),
    )
    assert.equal(impl.calls.length, 0, '缺新版凭据时不得发请求')
  })
})

test('generateAudio：上游以 HTTP 200 + code 报错时也要抛错（不能当成功）', async () => {
  await withWorkspace(async (cwd) => {
    const store = new ArtifactStore({ cwd })

    // 鉴权类错误：实测中 Speech 服务常用 200 + code 表达
    const authImpl = recordingFetch(() => jsonResponse({ code: 45_000_010, message: 'Invalid X-Api-Key' }))
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x' }, { fetchImpl: authImpl }),
      (err) => err.code === ARK_ERROR_CODES.AUTHENTICATION && /Invalid X-Api-Key/.test(err.message),
    )

    // 未授权资源
    const permImpl = recordingFetch(() => jsonResponse({ code: 45_000_030, message: 'requested resource not granted' }))
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x' }, { fetchImpl: permImpl }),
      (err) => err.code === ARK_ERROR_CODES.PERMISSION,
    )

    // 目录里不应留下任何产物
    const leftovers = await fs.readdir(path.join(cwd, 'ark-output')).catch(() => [])
    assert.deepEqual(leftovers, [])
  })
})

test('generateAudio：没有 audio 字段或空音频都报 BAD_RESPONSE，不落盘', async () => {
  await withWorkspace(async (cwd) => {
    const store = new ArtifactStore({ cwd })

    const noAudio = recordingFetch(() => jsonResponse({ duration: 1, url: 'https://x' }))
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x' }, { fetchImpl: noAudio }),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /没有 audio 字段/.test(err.message),
    )

    const emptyAudio = recordingFetch(() => jsonResponse({ audio: '' }))
    await assert.rejects(
      () => generateAudio({ config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x' }, { fetchImpl: emptyAudio }),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE,
    )

    const leftovers = await fs.readdir(path.join(cwd, 'ark-output')).catch(() => [])
    assert.deepEqual(leftovers, [])
  })
})

test('generateAudio：取消会透传为 ABORTED', async () => {
  await withWorkspace(async (cwd) => {
    const controller = new AbortController()
    const impl = recordingFetch((_url, init) => {
      // 模拟"请求已发出后被取消"
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
        setTimeout(() => controller.abort(), 5)
      })
    })
    const store = new ArtifactStore({ cwd })

    await assert.rejects(
      () =>
        generateAudio(
          { config: testConfig(), creds: apiKeyCreds(), store, textPrompt: 'x' },
          { fetchImpl: impl, signal: controller.signal },
        ),
      (err) => err.code === ARK_ERROR_CODES.ABORTED,
    )
  })
})
