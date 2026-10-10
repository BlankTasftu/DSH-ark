/**
 * lib/volc-tts.mjs 单测：分句、流解析（两个真实踩坑点）、产物校验、双通道合成。
 *
 * 所有用例都注入 mock fetchImpl，**不发真实网络请求**（真实 Key 的端到端验收由 Lead 统一做）。
 * 运行：node --test "tests/*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  TTS_END_CODE,
  TTS_LOCAL_PARSE_ERROR,
  TTS_SUCCESS_CODE,
  assertAudioDeliverable,
  isCloneSpeaker,
  parseTtsStream,
  probeAudioHeader,
  resourceForVoice,
  splitText,
  synthesizeSpeech,
} from '../lib/volc-tts.mjs'
import { ARK_ERROR_CODES } from '../lib/errors.mjs'
import { resolveConfig } from '../lib/config.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'

// ---------------------------------------------------------------- 测试工具

/** 造一段"像 MP3"的字节：ff fb 是 MPEG1 Layer3 帧同步头。 */
function mp3Bytes(length, tag = 0) {
  const bytes = new Uint8Array(length)
  bytes.set([0xff, 0xfb, 0x90, 0x64], 0)
  for (let i = 4; i < length; i++) bytes[i] = tag
  return bytes
}

function wavBytes(length = 13) {
  const bytes = new Uint8Array(length)
  for (const [i, c] of [...'RIFF'].entries()) bytes[i] = c.charCodeAt(0)
  return bytes
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

/** 把响应体做成真正的流式 ReadableStream（走 responseLines 的增量解码路径）。 */
function streamResponse(parts, { contentType = 'text/event-stream', requestId = 'log-1', status = 200 } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  const headers = { 'content-type': contentType }
  if (requestId) headers['X-Tt-Logid'] = requestId
  return new Response(body, { status, headers })
}

/** 一段完整音频按"整段 base64 的分片"下发（只有最后一片带 padding）。 */
function sseFramesForAudio(audio, { endMarker = true } = {}) {
  const full = b64(audio)
  const pieces = [full.slice(0, 7), full.slice(7, 14), full.slice(14)].filter(Boolean)
  const frames = pieces.map((p) => `data: ${JSON.stringify({ code: TTS_SUCCESS_CODE, data: p })}\n`)
  if (endMarker) frames.push(`data: ${JSON.stringify({ code: TTS_END_CODE, message: 'ok' })}\n`)
  return frames
}

/** 记录每次请求（URL / 头 / body）的 mock fetch。 */
function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const record = { url, init, headers: init.headers, body: JSON.parse(init.body) }
    calls.push(record)
    return handler(record, calls.length - 1)
  }
  impl.calls = calls
  return impl
}

/** 语音凭据：现在只有一条路 —— API Key。 */
function speechCreds(overrides = {}) {
  const values = {
    VOLCENGINE_SPEECH_API_KEY: 'api-key-1',
    ...overrides,
  }
  return { resolve: async (ref) => values[ref], require: async (ref) => values[ref] }
}

/** 计数用的 ArtifactStore：验证"校验失败时不落盘"。 */
function countingStore(cwd) {
  const store = new ArtifactStore({ cwd })
  const original = store.save.bind(store)
  store.saves = 0
  store.save = async (input) => {
    store.saves += 1
    return original(input)
  }
  return store
}

async function withWorkspace(fn) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-tts-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/**
 * 铁律：单测绝不发真实网络请求。
 * 任何忘记注入 fetchImpl 的用例都会在这里立刻失败，而不是悄悄打真实计费接口。
 */
globalThis.fetch = () => {
  throw new Error('单测禁止真实网络请求：请注入 mock fetchImpl')
}

// ---------------------------------------------------------------- splitText

test('splitText 按标点分句，标点保留在前一片，且不丢字符', () => {
  const text = '你好，世界。今天天气不错！'
  const parts = splitText(text, 200)
  assert.deepEqual(parts, ['你好，', '世界。', '今天天气不错！'])
  assert.equal(parts.join(''), text)
})

test('splitText 无标点长文按字数硬切，不产生空片段', () => {
  const parts = splitText('甲'.repeat(25), 10)
  assert.deepEqual(parts.map((p) => p.length), [10, 10, 5])
  assert.equal(parts.join(''), '甲'.repeat(25))
  assert.ok(parts.every((p) => p.length > 0))
})

test('splitText 边界：单字符 / 纯标点 / 纯空白 / 空串', () => {
  assert.deepEqual(splitText('甲', 10), ['甲'])
  // 纯标点不是"空句"：丢掉它们就等于丢字符，也会丢掉句间停顿。
  assert.deepEqual(splitText('。。。', 10), ['。', '。', '。'])
  assert.deepEqual(splitText('   \n\t ', 10), [])
  assert.deepEqual(splitText('', 10), [])
  assert.deepEqual(splitText(null, 10), [])
})

test('splitText 换行与 CRLF 也分句', () => {
  assert.deepEqual(splitText('第一行\n第二行', 200), ['第一行', '第二行'])
  assert.deepEqual(splitText('a\r\nb', 200), ['a', 'b'])
})

test('splitText maxChars 非法时回落到默认 200', () => {
  assert.deepEqual(splitText('甲'.repeat(250), 0).map((p) => p.length), [200, 50])
  assert.deepEqual(splitText('甲'.repeat(250), Number.NaN).map((p) => p.length), [200, 50])
  assert.deepEqual(splitText('甲'.repeat(250), -5).map((p) => p.length), [200, 50])
})

test('splitText 硬切不劈开代理对（emoji 不能变成乱码）', () => {
  const parts = splitText('😀😀😀😀😀', 2)
  assert.deepEqual(parts.map((p) => Array.from(p).length), [2, 2, 1])
  assert.ok(parts.every((p) => p.isWellFormed()))
  assert.equal(parts.join(''), '😀😀😀😀😀')
})

test('isCloneSpeaker 按 S_ / clone_ 前缀判定克隆音色', () => {
  assert.ok(isCloneSpeaker('S_abc123'))
  assert.ok(isCloneSpeaker('clone_voice_1'))
  assert.ok(isCloneSpeaker('s_lower'))
  assert.ok(!isCloneSpeaker('zh_female_shuangkuaisisi_uranus_bigtts'))
  assert.ok(!isCloneSpeaker(''))
  assert.ok(!isCloneSpeaker(undefined))
})

// ------------------------------------------------- parseTtsStream：踩坑点 1

test('【踩坑点 1】结束标记 20000000 不是错误，且最后一段音频不能丢', async () => {
  const audio = mp3Bytes(13, 0x11)
  const frames = sseFramesForAudio(audio)
  // 混入哨兵行、SSE 注释心跳与空行，它们都必须被安静忽略。
  frames.splice(1, 0, '\n', ': keep-alive\n', '[DONE]\n')

  const parsed = await parseTtsStream(frames)
  assert.equal(parsed.chunks, 3)
  assert.equal(parsed.endMarkerSeen, true)
  assert.deepEqual(parsed.errors, [])
  // 关键断言：解码结果与完整音频逐字节相同 —— 少收最后一块就会在这里挂掉。
  assert.equal(hex(parsed.bytes), hex(audio))
  assert.ok(parsed.base64.endsWith('=='))
})

test('【踩坑点 1 反例】丢掉最后一片 ⇒ padding 缺失，校验闸门必须拦住', async () => {
  const audio = mp3Bytes(13, 0x22)
  const full = b64(audio)
  // 模拟"遇到非 0 码就以为流结束"的坏实现：它只收到前两片。
  const parsed = await parseTtsStream([
    `data: ${JSON.stringify({ code: 0, data: full.slice(0, 7) })}`,
    `data: ${JSON.stringify({ code: 0, data: full.slice(7, 14) })}`,
    `data: ${JSON.stringify({ code: TTS_END_CODE })}`,
  ])
  assert.equal(parsed.chunks, 2)
  assert.ok(!parsed.base64.endsWith('='))
  assert.throws(
    () => assertAudioDeliverable({ base64: parsed.base64, bytes: parsed.bytes }),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /截断/.test(err.message),
  )
})

test('parseTtsStream 兼容 NDJSON 裸 JSON 行', async () => {
  const audio = mp3Bytes(13, 0x33)
  const full = b64(audio)
  const parsed = await parseTtsStream([
    JSON.stringify({ code: 0, data: full.slice(0, 9) }),
    JSON.stringify({ code: 0, data: full.slice(9) }),
    JSON.stringify({ code: TTS_END_CODE }),
  ])
  assert.equal(parsed.chunks, 2)
  assert.equal(parsed.endMarkerSeen, true)
  assert.equal(hex(parsed.bytes), hex(audio))
})

test('parseTtsStream 兼容 data: 无空格、大小写与 \\r\\n 行尾', async () => {
  const payload = Buffer.from(mp3Bytes(13, 0x44)).toString('base64')
  const parsed = await parseTtsStream(`DATA:${JSON.stringify({ code: 0, data: payload })}\r\n`)
  assert.equal(parsed.chunks, 1)
  assert.equal(parsed.endMarkerSeen, false)
  assert.equal(hex(parsed.bytes), hex(mp3Bytes(13, 0x44)))
})

test('parseTtsStream 忽略 code=0 但无 data 的心跳块，不算块也不算错误', async () => {
  const audio = mp3Bytes(13, 0x55)
  const parsed = await parseTtsStream([
    `data: ${JSON.stringify({ code: 0, message: 'ok', data: null })}`,
    `data: ${JSON.stringify({ code: 0, data: '' })}`,
    ...sseFramesForAudio(audio),
  ])
  assert.equal(parsed.chunks, 3)
  assert.deepEqual(parsed.errors, [])
  assert.equal(hex(parsed.bytes), hex(audio))
})

test('parseTtsStream 把其它非 0 码收进 errors，且不影响已收到的音频', async () => {
  const audio = mp3Bytes(13, 0x66)
  const frames = sseFramesForAudio(audio, { endMarker: false })
  frames.splice(1, 0, `data: ${JSON.stringify({ code: 40_000_000, message: '语言不支持' })}\n`)
  const parsed = await parseTtsStream(frames)
  assert.equal(parsed.chunks, 3)
  assert.equal(hex(parsed.bytes), hex(audio))
  assert.deepEqual(parsed.errors, [{ code: 40_000_000, message: '语言不支持' }])
  assert.equal(parsed.endMarkerSeen, false)
})

test('parseTtsStream 只有结束标记时：endMarkerSeen=true、无字节、无错误', async () => {
  const parsed = await parseTtsStream([`data: ${JSON.stringify({ code: TTS_END_CODE })}`])
  assert.equal(parsed.endMarkerSeen, true)
  assert.equal(parsed.chunks, 0)
  assert.equal(parsed.bytes.length, 0)
  assert.deepEqual(parsed.errors, [])
})

test('parseTtsStream 非 JSON / 非对象行记为本地解析错误（-1），不冒充上游码', async () => {
  const parsed = await parseTtsStream(['oops not json', '123', '[1,2]', '{"noCode":true}'])
  assert.equal(parsed.chunks, 0)
  assert.equal(parsed.errors.length, 4)
  assert.ok(parsed.errors.every((e) => e.code === TTS_LOCAL_PARSE_ERROR))
})

test('parseTtsStream 逐块独立编码（每片自带 padding）时按字节序拼接', async () => {
  const first = mp3Bytes(13, 0x77)
  const second = mp3Bytes(13, 0x88)
  const parsed = await parseTtsStream([
    `data: ${JSON.stringify({ code: 0, data: b64(first) })}`,
    `data: ${JSON.stringify({ code: 0, data: b64(second) })}`,
    `data: ${JSON.stringify({ code: TTS_END_CODE })}`,
  ])
  assert.equal(parsed.chunks, 2)
  assert.equal(hex(parsed.bytes), hex(Buffer.concat([Buffer.from(first), Buffer.from(second)])))
})

test('parseTtsStream 兼容"非流式整体 JSON"响应（跨多行的单个对象）', async () => {
  const audio = mp3Bytes(13, 0x99)
  const pretty = JSON.stringify({ code: 0, message: 'ok', data: b64(audio) }, null, 2)
  const parsed = await parseTtsStream(pretty.split('\n'))
  assert.equal(parsed.chunks, 1)
  assert.equal(hex(parsed.bytes), hex(audio))
  // 逐行解析的误报必须被清掉，否则调用方会看到一堆假的"不是合法 JSON"。
  assert.deepEqual(parsed.errors, [])
})

test('parseTtsStream 整体回退时也要报真实上游错误码，而不是一串 -1', async () => {
  const pretty = JSON.stringify({ code: 40_000_002, message: '鉴权失败' }, null, 2)
  const parsed = await parseTtsStream(pretty.split('\n'))
  assert.equal(parsed.chunks, 0)
  assert.equal(parsed.endMarkerSeen, false)
  assert.deepEqual(parsed.errors, [{ code: 40_000_002, message: '鉴权失败' }])
})

test('parseTtsStream 接受字符串、逐行异步可迭代与"按字节分片"输入', async () => {
  const audio = mp3Bytes(13, 0xaa)
  const lines = [JSON.stringify({ code: 0, data: b64(audio) }), JSON.stringify({ code: TTS_END_CODE })]
  const text = `${lines.join('\n')}\n`

  const fromString = await parseTtsStream(text)
  assert.equal(hex(fromString.bytes), hex(audio))
  assert.equal(fromString.endMarkerSeen, true)

  async function* completeLines() {
    for (const line of lines) yield `${line}\n`
  }
  const fromLines = await parseTtsStream(completeLines())
  assert.equal(hex(fromLines.bytes), hex(audio))
  assert.deepEqual(fromLines.errors, [])

  // 分片边界不按行对齐（ByteStream → 文本流就是这种形态）：逐行解析会全失败，
  // 解析器必须靠"整体回退"把音频救回来，而不是静默丢掉 —— 静默丢音频是本模块最忌讳的失败模式。
  async function* byteChunks() {
    const encoder = new TextEncoder()
    yield encoder.encode(text.slice(0, 14))
    yield encoder.encode(text.slice(14))
  }
  const fromChunks = await parseTtsStream(byteChunks())
  assert.equal(hex(fromChunks.bytes), hex(audio))
  assert.equal(fromChunks.endMarkerSeen, true)
  assert.deepEqual(fromChunks.errors, [])
})

test('probeAudioHeader 认 ID3 / MP3 帧同步 / RIFF / OggS', () => {
  assert.equal(probeAudioHeader(new Uint8Array([0x49, 0x44, 0x33])), 'mp3')
  assert.equal(probeAudioHeader(new Uint8Array([0xff, 0xf3, 0x00])), 'mp3')
  assert.equal(probeAudioHeader(mp3Bytes(8)), 'mp3')
  assert.equal(probeAudioHeader(wavBytes(12)), 'wav')
  assert.equal(probeAudioHeader(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), 'ogg')
  assert.equal(probeAudioHeader(new Uint8Array([0x00, 0x01, 0x02, 0x03])), undefined)
  assert.equal(probeAudioHeader(new Uint8Array(0)), undefined)
})

// ------------------------------------------------- 踩坑点 2：产物校验闸门

test('【踩坑点 2】base64 缺 padding ⇒ BAD_RESPONSE 并说明疑似截断', () => {
  // 3 字节 'ID3' 的 base64 是 "SURJ"，本身没有 padding：文件头合法、padding 不合法。
  const bytes = new Uint8Array([0x49, 0x44, 0x33])
  assert.throws(
    () => assertAudioDeliverable({ base64: b64(bytes), bytes, requestId: 'log-x' }),
    (err) =>
      err.code === ARK_ERROR_CODES.BAD_RESPONSE
      && /base64/.test(err.message)
      && /截断/.test(err.message)
      && err.requestId === 'log-x',
  )
})

test('【踩坑点 2】文件头不是已知音频容器 ⇒ BAD_RESPONSE', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03])
  assert.throws(
    () => assertAudioDeliverable({ base64: `${b64(bytes)}=`, bytes }),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /文件头/.test(err.message),
  )
})

test('assertAudioDeliverable 通过时返回真实容器对应的 mime/ext', () => {
  const audio = mp3Bytes(13)
  assert.deepEqual(assertAudioDeliverable({ base64: b64(audio), bytes: audio }), {
    format: 'mp3',
    mime: 'audio/mpeg',
    ext: 'mp3',
    warnings: [],
  })
  const wav = wavBytes(13)
  assert.deepEqual(assertAudioDeliverable({ base64: b64(wav), bytes: wav }), {
    format: 'wav',
    mime: 'audio/wav',
    ext: 'wav',
    warnings: [],
  })
})

test('回归：base64 无 padding（字节数为 3 的倍数）不得被误判为截断', async () => {
  // 真实故障形态：一段完全正常的音频，字节数正好是 3 的倍数 ⇒ base64 没有 "="。
  // 若把"必须以 = 结尾"当成交付判据，这段音频会被误判为截断而拒绝交付。
  const audio = mp3Bytes(12, 0x5a) // 12 字节，12 % 3 === 0
  assert.ok(!b64(audio).endsWith('='), '前置条件：这段 base64 本身就没有 padding')

  await withWorkspace(async (cwd) => {
    // 有结束标记 ⇒ 流已被服务端正常收尾，必须接受，且不该有任何 warning。
    const okFetch = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    const okStore = countingStore(cwd)
    const ok = await synthesizeSpeech(
      { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: okStore, text: '正常。' },
      { fetchImpl: okFetch },
    )
    assert.equal(ok.endMarkerSeen, true)
    assert.deepEqual(ok.warnings, [])
    assert.equal(ok.format, 'mp3')
    assert.equal(okStore.saves, 1)
    assert.equal(hex(await fs.readFile(ok.audio.path)), hex(audio))

    // 同一段音频、同样没有 padding，但**缺结束标记** ⇒ 无法证明流完整，拒绝交付。
    const badFetch = recordingFetch(() =>
      streamResponse(sseFramesForAudio(audio, { endMarker: false })),
    )
    const badStore = countingStore(cwd)
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: badStore, text: '缺标记。' },
        { fetchImpl: badFetch },
      ),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE,
    )
    assert.equal(badStore.saves, 0)
  })
})

// ------------------------------------------------- synthesizeSpeech

test('synthesizeSpeech（SSE）：请求头/URL/请求体正确，音频落盘交付', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0xab)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    const config = resolveConfig({ ark: { rateLimitBackoffMs: 1 } })
    const store = countingStore(cwd)

    const result = await synthesizeSpeech(
      { config, creds: speechCreds(), store, text: '你好世界。' },
      { fetchImpl },
    )

    assert.equal(fetchImpl.calls.length, 1)
    const [call] = fetchImpl.calls
    assert.equal(call.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.headers['X-Api-Key'], 'api-key-1')
    // 旧版双头已整体移除：不得再出现这两个头
    assert.equal('X-Api-App-Id' in call.headers, false)
    assert.equal('X-Api-Access-Key' in call.headers, false)
    assert.equal(call.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
    assert.equal(call.headers.Accept, 'text/event-stream')
    assert.equal(call.headers['Content-Type'], 'application/json')
    assert.deepEqual(call.body.user, { uid: 'dsh-ark' })
    assert.equal(call.body.req_params.text, '你好世界。')
    assert.equal(call.body.req_params.speaker, 'zh_female_shuangkuaisisi_uranus_bigtts')
    assert.deepEqual(call.body.req_params.audio_params, { format: 'mp3', sample_rate: 24_000 })
    assert.equal(call.body.req_params.additions, undefined)

    assert.equal(result.channel, 'apiKey')
    assert.equal(result.segments, 1)
    assert.equal(result.format, 'mp3')
    assert.equal(result.sampleRate, 24_000)
    assert.equal(result.requestId, 'log-1')
    assert.deepEqual(result.errors, [])
    assert.match(result.audio.name, /\.mp3$/)
    assert.equal(result.audio.mime, 'audio/mpeg')
    assert.equal(hex(await fs.readFile(result.audio.path)), hex(audio))
    assert.equal(store.saves, 1)
  })
})

test('synthesizeSpeech（NDJSON）：换端点、换 Accept，多句逐句串行请求', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0xcd)
    const fetchImpl = recordingFetch(() => streamResponse(
      sseFramesForAudio(audio).map((line) => line.replace(/^data: /, '')),
      { contentType: 'application/x-ndjson' },
    ))
    const config = resolveConfig({ speech: { mode: 'ndjson' }, ark: { rateLimitBackoffMs: 1 } })

    const result = await synthesizeSpeech(
      { config, creds: speechCreds(), store: countingStore(cwd), text: '第一句。第二句。' },
      { fetchImpl },
    )

    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(fetchImpl.calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
    assert.equal(fetchImpl.calls[0].headers.Accept, 'application/json')
    assert.deepEqual(fetchImpl.calls.map((c) => c.body.req_params.text), ['第一句。', '第二句。'])
    assert.equal(result.segments, 2)
  })
})

test('synthesizeSpeech 多句按分句顺序拼接字节', async () => {
  await withWorkspace(async (cwd) => {
    const payloads = [mp3Bytes(13, 0x01), mp3Bytes(13, 0x02), mp3Bytes(13, 0x03)]
    const fetchImpl = recordingFetch((_record, index) => streamResponse(sseFramesForAudio(payloads[index])))
    const expected = Buffer.concat(payloads.map((p) => Buffer.from(p)))

    const result = await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '甲。乙。丙。',
      },
      { fetchImpl },
    )

    assert.equal(result.segments, 3)
    assert.equal(fetchImpl.calls.length, 3)
    assert.equal(hex(await fs.readFile(result.audio.path)), expected.toString('hex'))
  })
})

test('synthesizeSpeech 克隆音色走 seed-icl-2.0 并强制带 explicit_language', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0xef)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))

    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '这是一段克隆音色的合成文本。',
        voice: 'S_demo_clone_1',
      },
      { fetchImpl },
    )

    const [call] = fetchImpl.calls
    assert.equal(call.headers['X-Api-Resource-Id'], 'seed-icl-2.0')
    // additions 必须是"JSON 字符串"，不是 JSON 对象（官方口径）。
    assert.equal(typeof call.body.req_params.additions, 'string')
    assert.deepEqual(JSON.parse(call.body.req_params.additions), { explicit_language: 'zh' })
  })
})

test('synthesizeSpeech 克隆音色：显式 explicitLanguage 优先，英文文本兜底 en', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0xfa)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))

    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: 'hello world',
        voice: 'clone_a',
        explicitLanguage: 'ja',
      },
      { fetchImpl },
    )
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].body.req_params.additions), { explicit_language: 'ja' })

    const fetchImpl2 = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: 'hello world',
        voice: 'clone_b',
      },
      { fetchImpl: fetchImpl2 },
    )
    assert.deepEqual(JSON.parse(fetchImpl2.calls[0].body.req_params.additions), { explicit_language: 'en' })
  })
})

test('synthesizeSpeech 普通音色显式传 explicitLanguage 时才带 additions', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x0f)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: 'hi',
        explicitLanguage: 'en',
      },
      { fetchImpl },
    )
    const [call] = fetchImpl.calls
    assert.equal(call.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
    assert.deepEqual(JSON.parse(call.body.req_params.additions), { explicit_language: 'en' })
  })
})

test('synthesizeSpeech 透传语速/音量/音调/情感参数', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x1f)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '参数透传。',
        speedRatio: 1.2,
        volumeRatio: 0.8,
        pitchRatio: 1.1,
        emotion: 'happy',
      },
      { fetchImpl },
    )
    const { req_params: params } = fetchImpl.calls[0].body
    assert.equal(params.speed_ratio, 1.2)
    assert.equal(params.volume_ratio, 0.8)
    assert.equal(params.pitch_ratio, 1.1)
    assert.equal(params.emotion, 'happy')
  })
})

test('synthesizeSpeech 校验失败时抛 BAD_RESPONSE 且绝不落盘', async () => {
  await withWorkspace(async (cwd) => {
    // 场景一：base64 缺 padding 且**没有结束标记** ⇒ 无法证明流被正常收尾，按截断拒绝。
    // （反过来，若结束标记存在，则 padding 缺失不算截断证据——总字节数为 3 的倍数时
    //  base64 本来就没有 "="；这条分支由 parseTtsStream/合成用例正面覆盖。）
    const audio = mp3Bytes(13, 0x2f)
    const truncatedFetch = recordingFetch(() => streamResponse([
      `data: ${JSON.stringify({ code: 0, data: b64(audio).replace(/=+$/, '') })}\n`,
    ]))
    const storeA = countingStore(cwd)
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: storeA, text: '截断。' },
        { fetchImpl: truncatedFetch },
      ),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /base64/.test(err.message),
    )
    assert.equal(storeA.saves, 0)

    // 场景二：内容不是音频（文件头认不出），且无结束标记 ⇒ 拒绝。
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
    const junkFetch = recordingFetch(() => streamResponse(sseFramesForAudio(junk, { endMarker: false })))
    const storeB = countingStore(cwd)
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: storeB, text: '坏头。' },
        { fetchImpl: junkFetch },
      ),
      (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /文件头/.test(err.message),
    )
    assert.equal(storeB.saves, 0)

    // 校验失败 ⇒ 产物目录里不应该留下任何文件。
    const leftovers = await fs.readdir(path.join(cwd, 'ark-output')).catch(() => [])
    assert.deepEqual(leftovers, [])
  })
})

test('synthesizeSpeech 上游只给错误码不给音频 ⇒ BAD_RESPONSE 且带上错误码', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => streamResponse([
      `data: ${JSON.stringify({ code: 40_000_000, message: '语言不支持' })}\n`,
      `data: ${JSON.stringify({ code: TTS_END_CODE })}\n`,
    ]))
    const store = countingStore(cwd)
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store, text: '失败。' },
        { fetchImpl },
      ),
      (err) =>
        err.code === ARK_ERROR_CODES.BAD_RESPONSE
        && /40000000/.test(err.message)
        && /语言不支持/.test(err.message),
    )
    assert.equal(store.saves, 0)
  })
})

test('回归（实测证据）：上游 code 45000010 归类为 AUTHENTICATION 并给出凭据指引', async () => {
  // 该码是真实探测结果：凭据无效时语音服务仍返回 HTTP 200，
  // 错误藏在数据帧里：{"reqid":"…","code":45000010,"message":"load grant: …"}。
  // 若不按码分类，用户只会看到一句无从下手的 BAD_RESPONSE。
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => streamResponse([
      `data: ${JSON.stringify({ reqid: 'real-logid-1', code: 45_000_010, message: 'load grant: requested grant not found in SaaS storage' })}\n`,
    ]))
    const store = countingStore(cwd)
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store, text: '鉴权失败。' },
        { fetchImpl },
      ),
      (err) =>
        err.code === ARK_ERROR_CODES.AUTHENTICATION
        && /45000010/.test(err.message)
        && /X-Api-Key/.test(err.message)
        && /ARK_API_KEY/.test(err.message),
    )
    assert.equal(store.saves, 0)
  })
})

test('synthesizeSpeech HTTP 400 归类为 INVALID_PARAMETER 且带 request_id', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => new Response(
      JSON.stringify({ code: 40_000_001, message: '语言不支持' }),
      { status: 400, headers: { 'content-type': 'application/json', 'X-Tt-Logid': 'log-400' } },
    ))
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: countingStore(cwd), text: '400。' },
        { fetchImpl },
      ),
      (err) =>
        err.code === ARK_ERROR_CODES.INVALID_PARAMETER
        && err.httpStatus === 400
        && err.requestId === 'log-400'
        && /语言不支持/.test(err.message),
    )
  })
})

test('synthesizeSpeech 429 按 rateLimitRetries 退避重试后成功', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x3f)
    const fetchImpl = recordingFetch((_record, index) =>
      index === 0
        ? new Response('{"code":"RateLimitExceeded"}', { status: 429 })
        : streamResponse(sseFramesForAudio(audio)),
    )
    const result = await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitRetries: 1, rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '重试。',
      },
      { fetchImpl },
    )
    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(result.segments, 1)
  })
})

test('synthesizeSpeech 429 超过重试次数 ⇒ RATE_LIMITED（参数错误绝不重试）', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => new Response('{"error":{"code":"RateLimitExceeded"}}', { status: 429 }))
    await assert.rejects(
      () => synthesizeSpeech(
        { config: resolveConfig({ ark: { rateLimitRetries: 0 } }), creds: speechCreds(), store: countingStore(cwd), text: '限流。' },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.RATE_LIMITED,
    )
    assert.equal(fetchImpl.calls.length, 1)
  })
})

test('synthesizeSpeech 取消：请求挂起时 abort ⇒ ABORTED', async () => {
  await withWorkspace(async (cwd) => {
    let seenSignal
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        seenSignal = init.signal
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        )
      })
    const controller = new AbortController()
    const promise = synthesizeSpeech(
      { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: countingStore(cwd), text: '取消。' },
      { fetchImpl, signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(seenSignal, 'signal 必须透传给 fetch')
    controller.abort()
    await assert.rejects(promise, (err) => err.code === ARK_ERROR_CODES.ABORTED)
  })
})

test('synthesizeSpeech 取消：流读到一半 abort ⇒ ABORTED', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = (_url, init) => {
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"code":0,"data":"QUFB'))
          // 模拟连接悬挂：不 close，只在取消时让读端报错。
          init.signal.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    }
    const controller = new AbortController()
    const promise = synthesizeSpeech(
      { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: countingStore(cwd), text: '流中取消。' },
      { fetchImpl, signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await assert.rejects(promise, (err) => err.code === ARK_ERROR_CODES.ABORTED)
  })
})

test('synthesizeSpeech 多句中间取消：不再发后续请求', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x4f)
    const controller = new AbortController()
    const fetchImpl = recordingFetch(() => {
      // 第一句返回后立刻取消：第二句不该再发出去（按句计费，多发就是多花钱）。
      controller.abort()
      return streamResponse(sseFramesForAudio(audio))
    })
    await assert.rejects(
      () => synthesizeSpeech(
        {
          config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
          creds: speechCreds(),
          store: countingStore(cwd),
          text: '甲。乙。丙。',
        },
        { fetchImpl, signal: controller.signal },
      ),
      (err) => err.code === ARK_ERROR_CODES.ABORTED,
    )
    assert.equal(fetchImpl.calls.length, 1)
  })
})

test('synthesizeSpeech 超时 ⇒ TIMEOUT', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
          { once: true },
        )
      })
    await assert.rejects(
      () => synthesizeSpeech(
        {
          config: resolveConfig({ ark: { requestTimeoutMs: 20, rateLimitBackoffMs: 1 } }),
          creds: speechCreds(),
          store: countingStore(cwd),
          text: '超时。',
        },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.TIMEOUT,
    )
  })
})

test('synthesizeSpeech 缺凭据 ⇒ MISSING_CREDENTIAL，且不发请求', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => {
      throw new Error('不该发请求')
    })
    await assert.rejects(
      () => synthesizeSpeech(
        {
          config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
          creds: { resolve: async () => undefined, require: async () => undefined },
          store: countingStore(cwd),
          text: '凭据。',
        },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL,
    )
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('synthesizeSpeech 只发 X-Api-Key：不再带 App-Id / Access-Key（旧版已移除）', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x5f)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    const result = await synthesizeSpeech(
      { config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }), creds: speechCreds(), store: countingStore(cwd), text: '鉴权。' },
      { fetchImpl },
    )
    assert.equal(result.channel, 'apiKey')
    const h = fetchImpl.calls[0].headers
    assert.equal(h['X-Api-Key'], 'api-key-1')
    // 旧版双头已整体移除：它们既不是鉴权因子（App ID），也会让 ASR/音频生成直接报错
    assert.equal('X-Api-App-Id' in h, false, '不应再发 X-Api-App-Id')
    assert.equal('X-Api-Access-Key' in h, false, '不应再发 X-Api-Access-Key')
  })
})

test('synthesizeSpeech 缺 API Key 时报 MISSING_CREDENTIAL 且不发请求', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => {
      throw new Error('不该发请求')
    })
    await assert.rejects(
      () =>
        synthesizeSpeech(
          {
            config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
            creds: { resolve: async () => undefined, require: async () => undefined },
            store: countingStore(cwd),
            text: '缺凭据。',
          },
          { fetchImpl },
        ),
      (err) =>
        err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL
        && /VOLCENGINE_SPEECH_API_KEY/.test(err.message),
    )
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('synthesizeSpeech 参数不合法：空文本 / 未知 mode / 无 store，都不发请求', async () => {
  await withWorkspace(async (cwd) => {
    const fetchImpl = recordingFetch(() => {
      throw new Error('不该发请求')
    })
    const base = {
      creds: speechCreds(),
      store: countingStore(cwd),
      text: '   ',
    }
    await assert.rejects(
      () => synthesizeSpeech({ ...base, config: resolveConfig({}) }, { fetchImpl }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
    await assert.rejects(
      () => synthesizeSpeech(
        { ...base, text: '正常文本。', config: resolveConfig({ speech: { mode: 'websocket' } }) },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /mode/.test(err.message),
    )
    await assert.rejects(
      () => synthesizeSpeech(
        { ...base, text: '正常文本。', store: undefined, config: resolveConfig({}) },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
    )
    await assert.rejects(
      () => synthesizeSpeech(
        { ...base, text: '正常文本。', config: resolveConfig({ speech: { format: 'pcm' } }) },
        { fetchImpl },
      ),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /格式/.test(err.message),
    )
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('synthesizeSpeech 长文本按 maxCharsPerRequest 分句并逐句请求', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x6f)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    const result = await synthesizeSpeech(
      {
        config: resolveConfig({ speech: { maxCharsPerRequest: 6 }, ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '甲甲甲。乙乙乙。丙丙丙。',
      },
      { fetchImpl },
    )
    assert.equal(result.segments, 3)
    assert.deepEqual(fetchImpl.calls.map((c) => c.body.req_params.text), ['甲甲甲。', '乙乙乙。', '丙丙丙。'])
  })
})

// ------------------------------------------------- 资源 id 随音色推断

test('resourceForVoice：音色克隆走克隆资源，其余一律走 TTS 资源', () => {
  // 为什么这条要钉死：语音服务把"音色"与"资源"绑在一起校验，配错的表现是
  // HTTP 200 + code 55000000「resource ID is mismatched with speaker related resource」
  // 且音频为空 —— 看起来像音色不存在，极难定位。
  const cases = [
    // 2.0 音色
    ['zh_female_shuangkuaisisi_uranus_bigtts', 'seed-tts-2.0'],
    ['zh_female_vv_uranus_bigtts', 'seed-tts-2.0'],
    ['ICL_uranus_zh_female_keainvsheng_tob', 'seed-tts-2.0'],
    // 大小写不敏感
    ['ZH_FEMALE_VV_URANUS_BIGTTS', 'seed-tts-2.0'],
    // 声音克隆
    ['S_abc123', 'seed-icl-2.0'],
    ['clone_xyz', 'seed-icl-2.0'],
    // 认不出的形态：回落 TTS 资源，让上游报准确的 mismatch，而不是瞎指一个资源
    ['mystery-voice', 'seed-tts-2.0'],
  ]
  for (const [voice, want] of cases) {
    assert.equal(resourceForVoice(voice), want, `${voice} 应推断为 ${want}`)
  }

  // 配置可覆盖（用户明确指定资源时以配置为准）
  assert.equal(resourceForVoice('zh_female_vv_uranus_bigtts', { resourceTts: 'custom.2.0' }), 'custom.2.0')
  assert.equal(resourceForVoice('S_x', { resourceTtsClone: 'custom.icl' }), 'custom.icl')
})

test('回归：不得再按"代"把音色路由到未经证实的资源 id（曾因此报错误导用户）', () => {
  // 真实事故：我曾按"`_mars_bigtts` 是 1.0 代音色"把它们路由到
  // `volc.service_type.10029`。实测该资源**不存在** —— 用**已确认可用**的 2.0 音色
  // 去配它，照样返回 45000030「requested resource not granted」；对照组 seed-tts-2.0
  // 正常出音频。后果不只是无效，而是**把错误信息变差**：
  // 用户看到"资源未授权"（会去控制台白折腾开通），真相只是"音色不属于这个资源"。
  //
  // 更根本的教训：`_mars_bigtts`/`_uranus_bigtts` 的"代"划分出自第三方音色表，
  // 不是官方口径。真正的官方产品线里 **TTS 与 SeedAudio 音频生成是两回事**，
  // 不能因为都带 "1.0" 就混为一谈 —— 那正是当初出错的根源。
  for (const voice of [
    'zh_male_beijingxiaoye_emo_v2_mars_bigtts',
    'zh_female_roumeinvyou_emo_v2_mars_bigtts',
    'zh_female_wanqudashu_moon_bigtts',
  ]) {
    assert.equal(
      resourceForVoice(voice),
      'seed-tts-2.0',
      `${voice} 应回落到 seed-tts-2.0，不得指向未证实的资源`,
    )
  }

  // 该凭据/配置项应已彻底移除
  const cfg = resolveConfig(undefined)
  assert.equal(cfg.speech.resourceTtsV1, undefined, 'config.speech 不应再有 resourceTtsV1')
  assert.equal(
    resourceForVoice('zh_male_x_mars_bigtts', { resourceTtsV1: 'volc.service_type.10029' }),
    'seed-tts-2.0',
    '即使外部传入 resourceTtsV1 也必须被忽略（该配置项已废弃）',
  )
})

test('synthesizeSpeech：克隆音色走 seed-icl-2.0，普通音色走 seed-tts-2.0', async () => {
  await withWorkspace(async (cwd) => {
    const audio = mp3Bytes(13, 0x3c)
    const fetchImpl = recordingFetch(() => streamResponse(sseFramesForAudio(audio)))
    await synthesizeSpeech(
      {
        config: resolveConfig({ ark: { rateLimitBackoffMs: 1 } }),
        creds: speechCreds(),
        store: countingStore(cwd),
        text: '测试。',
        // 克隆音色（S_ 前缀）必须换资源，否则上游报 mismatch
        voice: 'S_clonevoice1234',
      },
      { fetchImpl },
    )
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].headers['X-Api-Resource-Id'], 'seed-icl-2.0')
  })
})
