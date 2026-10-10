/**
 * 核心层单测：错误归一、产物探测、配置与凭据解析。
 * 运行：node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ARK_ERROR_CODES,
  ArkError,
  classifyHttpStatus,
  readUpstreamError,
  toArkError,
  isAbortError,
} from '../lib/errors.mjs'
import { probeImage, extensionFor, slugify, ArtifactStore } from '../lib/artifacts.mjs'
import { resolveConfig, createCredentialResolver, resolveSpeechCredentials } from '../lib/config.mjs'

// ---------------------------------------------------------------- errors.mjs

test('回归（审计 P3-2）：ArkError 序列化是白名单，绝不含 cause', () => {
  // 背景：cause 里挂的是原始底层错误对象（fetch/undici）。当前代码从不序列化整个 error，
  // 所以没有泄露路径。但一旦有人写 JSON.stringify(err) 或交给序列化 logger，
  // 底层错误就可能被整体带出去。toJSON 白名单是结构性防御。
  const secret = 'ark-LEAKCANARY-0123456789abcdef'
  const inner = new Error(secret)
  const err = new ArkError(ARK_ERROR_CODES.NETWORK, '网络请求失败', {
    provider: 'ark',
    httpStatus: 500,
    requestId: 'req-1',
    cause: inner,
  })

  const serialized = JSON.stringify(err)
  assert.ok(!serialized.includes(secret), `JSON.stringify(err) 不应含 cause 内容：${serialized}`)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.code, ARK_ERROR_CODES.NETWORK)
  assert.equal(parsed.message, '网络请求失败')
  assert.equal(parsed.httpStatus, 500)
  assert.equal(parsed.requestId, 'req-1')
  assert.equal(parsed.provider, 'ark')
  // 白名单里明确**没有** cause
  assert.equal('cause' in parsed, false, 'toJSON 白名单不得包含 cause')
  // toSummary 同样不含 cause
  assert.ok(!err.toSummary().includes(secret))
})

test('classifyHttpStatus 按状态码与上游 code 归一', () => {
  assert.equal(classifyHttpStatus(401), ARK_ERROR_CODES.AUTHENTICATION)
  assert.equal(classifyHttpStatus(403), ARK_ERROR_CODES.PERMISSION)
  assert.equal(classifyHttpStatus(404), ARK_ERROR_CODES.MODEL_NOT_AVAILABLE)
  assert.equal(classifyHttpStatus(429), ARK_ERROR_CODES.RATE_LIMITED)
  assert.equal(classifyHttpStatus(400), ARK_ERROR_CODES.INVALID_PARAMETER)
  assert.equal(classifyHttpStatus(500), ARK_ERROR_CODES.HTTP)
  // 上游 code 优先于状态码：方舟限流可能以 400 返回
  assert.equal(classifyHttpStatus(400, 'ModelAccountIpmRateLimitExceeded'), ARK_ERROR_CODES.RATE_LIMITED)
  assert.equal(classifyHttpStatus(400, 'InvalidParameter'), ARK_ERROR_CODES.INVALID_PARAMETER)
  assert.equal(classifyHttpStatus(200, 'ContentRiskBlocked'), ARK_ERROR_CODES.CONTENT_BLOCKED)
})

test('readUpstreamError 兼容三种错误体形状', () => {
  assert.deepEqual(readUpstreamError('{"error":{"code":"X","message":"boom"}}'), {
    code: 'X',
    message: 'boom',
  })
  assert.deepEqual(readUpstreamError('{"code":123,"message":"nope"}'), { code: '123', message: 'nope' })
  assert.deepEqual(readUpstreamError('plain text'), { code: undefined, message: 'plain text' })
  assert.deepEqual(readUpstreamError(''), { code: undefined, message: '' })
})

test('ArkError 摘要包含码、状态码与 request_id', () => {
  const err = new ArkError(ARK_ERROR_CODES.RATE_LIMITED, '太频繁', { httpStatus: 429, requestId: 'req-1' })
  assert.equal(err.retryable, false)
  assert.match(err.toSummary(), /RATE_LIMITED/)
  assert.match(err.toSummary(), /HTTP 429/)
  assert.match(err.toSummary(), /request_id=req-1/)
})

test('toArkError 保留 ArkError、识别取消、兜底其它异常', () => {
  const original = new ArkError(ARK_ERROR_CODES.TIMEOUT, 'x')
  assert.equal(toArkError(original), original)

  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(toArkError(abort).code, ARK_ERROR_CODES.ABORTED)

  assert.equal(toArkError(new Error('weird')).code, ARK_ERROR_CODES.HTTP)
  assert.equal(toArkError(new Error('weird'), ARK_ERROR_CODES.NETWORK).code, ARK_ERROR_CODES.NETWORK)
  assert.ok(isAbortError(abort))
  assert.ok(!isAbortError(new Error('nope')))
})

// ------------------------------------------------------------- artifacts.mjs

/** 构造一张最小 PNG 头（含 IHDR 宽高与结尾 IEND）。 */
function pngBytes(width, height) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  Buffer.from('IHDR').copy(ihdr, 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const iend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  return new Uint8Array(Buffer.concat([head, ihdr, Buffer.alloc(8), iend]))
}

/** 构造一张最小 JPEG（SOF0 携带宽高）。 */
function jpegBytes(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]))
}

test('probeImage 解析 PNG 宽高并校验 IEND', () => {
  const ok = probeImage(pngBytes(2048, 1152))
  assert.equal(ok.format, 'png')
  assert.equal(ok.width, 2048)
  assert.equal(ok.height, 1152)
  assert.equal(ok.complete, true)

  // 截断的 PNG：能读到宽高，但 complete=false（用于识别网络截断）
  const truncated = pngBytes(2048, 1152).slice(0, 30)
  const bad = probeImage(truncated)
  assert.equal(bad.width, 2048)
  assert.equal(bad.complete, false)
})

test('probeImage 解析 JPEG 宽高并校验 EOI', () => {
  const ok = probeImage(jpegBytes(1024, 768))
  assert.equal(ok.format, 'jpeg')
  assert.equal(ok.width, 1024)
  assert.equal(ok.height, 768)
  assert.equal(ok.complete, true)
})

/** 构造一张"像真实相机/服务端输出"的 JPEG：SOI + APP0(JFIF) + APP1(EXIF) + SOF0 + SOS + EOI。 */
function realisticJpeg(width, height) {
  const parts = [Buffer.from([0xff, 0xd8])]

  // APP0 / JFIF：15 字节段长度
  const app0 = Buffer.alloc(2 + 15)
  app0[0] = 0xff
  app0[1] = 0xe0
  app0.writeUInt16BE(15 + 2 - 2, 2) // len = 字段自身 + 负载
  Buffer.from('JFIF\0').copy(app0, 4)
  parts.push(app0)

  // APP1 / EXIF：带一段任意负载，模拟真实照片里的元数据
  const exifPayload = Buffer.alloc(40, 0x11)
  const app1 = Buffer.alloc(4 + exifPayload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(2 + exifPayload.length, 2)
  exifPayload.copy(app1, 4)
  parts.push(app1)

  // SOF0：精度(1) + 高(2) + 宽(2) + 分量数(1) + 3 个分量描述(9)
  const sofPayload = Buffer.alloc(1 + 2 + 2 + 1 + 9)
  sofPayload[0] = 8 // 精度
  sofPayload.writeUInt16BE(height, 1)
  sofPayload.writeUInt16BE(width, 3)
  sofPayload[5] = 3
  const sof = Buffer.alloc(4 + sofPayload.length)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(2 + sofPayload.length, 2)
  sofPayload.copy(sof, 4)
  parts.push(sof)

  // SOS 之后本应是压缩数据；尺寸信息在此前已经出现。
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])
  parts.push(sos)
  parts.push(Buffer.from([0xff, 0xd9])) // EOI
  return new Uint8Array(Buffer.concat(parts))
}

test('回归：带 APP0/APP1 段的真实 JPEG 也要读对宽高（曾错开一个字节）', () => {
  // 真实故障：一张 1774x2365 的服务端产物被解析成 宽0x0ba0/高3 —— 因为 SOF 的
  // 宽高偏移漏算了段长度字段（应读 i+5..i+8，却读了 i+3..i+6）。
  // 旧用例的 JPEG 只有 SOI+SOF+EOI，恰好不经过长度字段的路径，所以没暴露。
  const ok = probeImage(realisticJpeg(1774, 2365))
  assert.equal(ok.format, 'jpeg')
  assert.equal(ok.width, 1774)
  assert.equal(ok.height, 2365)
  assert.equal(ok.complete, true)

  // 再挑几个尺寸，确保偏移修正不是"碰巧对上"
  for (const [w, h] of [[1, 1], [256, 256], [4096, 2304], [65535, 32768]]) {
    const p = probeImage(realisticJpeg(w, h))
    assert.equal(p.width, w, `宽度应为 ${w}`)
    assert.equal(p.height, h, `高度应为 ${h}`)
  }
})

test('probeImage 解析 GIF 与 WebP', () => {
  const gif = new Uint8Array(20)
  Buffer.from('GIF89a').copy(Buffer.from(gif.buffer))
  gif[6] = 0x40
  gif[7] = 0x01 // 320
  gif[8] = 0xf0
  gif[9] = 0x00 // 240
  gif[19] = 0x3b
  const g = probeImage(gif)
  assert.equal(g.format, 'gif')
  assert.equal(g.width, 320)
  assert.equal(g.height, 240)

  const webp = new Uint8Array(40)
  const view = Buffer.from(webp.buffer)
  view.write('RIFF', 0)
  view.write('WEBP', 8)
  view.write('VP8X', 12)
  webp[24] = 0xff
  webp[27] = 0x7f
  const w = probeImage(webp)
  assert.equal(w.format, 'webp')
  assert.equal(w.width, 256)
  assert.equal(w.height, 128)
})

test('probeImage 对非图片字节返回 complete=false', () => {
  assert.equal(probeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).complete, false)
  assert.equal(probeImage(new Uint8Array(0)).complete, false)
})

test('extensionFor 优先 MIME，其次魔数', () => {
  assert.equal(extensionFor('image/png'), 'png')
  assert.equal(extensionFor('image/jpeg; charset=binary'), 'jpg')
  assert.equal(extensionFor(undefined, pngBytes(8, 8)), 'png')
  assert.equal(extensionFor(undefined, jpegBytes(8, 8)), 'jpg')
  assert.equal(extensionFor(undefined, new Uint8Array(4)), 'bin')
})

test('slugify 生成安全的文件名片段', () => {
  assert.equal(slugify('  a b/c:d  '), 'a-b-c-d')
  assert.equal(slugify(''), 'asset')
  assert.equal(slugify('x'.repeat(80)).length, 40)
  assert.ok(!slugify('a\\b*c?d"e<f>g|h').match(/[\\/:*?"<>|]/))
})

test('slugify 按 UTF-8 字节截断，且不切出半个多字节字符', () => {
  // 中文提示词按字符数截断会拼出很长的文件名（24 个中文字 = 72 字节）。
  // 上限必须按字节算，且不能把一个汉字截成半个（会产生乱码文件名）。
  const zh = '一位可爱的动漫风格猫娘少女银白色长发配猫耳琥珀色大眼睛白色蕾丝连衣裙'
  const out = slugify(zh, 24)
  assert.ok(new TextEncoder().encode(out).length <= 24, `字节数应 <= 24，实际 ${new TextEncoder().encode(out).length}`)
  assert.ok(out.length < zh.length, '应当被截断')
  // 截断后仍是合法 UTF-8（不含替换字符），且能被原串前缀匹配
  assert.ok(!out.includes('\uFFFD'))
  assert.ok(zh.startsWith(out), `截断结果应是原串前缀：${out}`)
  // 空/全被过滤掉时回落到 asset，而不是空串
  assert.equal(slugify('///', 10), 'asset')
  assert.equal(slugify('', 10), 'asset')
})

test('ArtifactStore 落盘、登记并返回相对路径与预览 URL', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-test-'))
  const store = new ArtifactStore({ cwd })
  const saved = await store.save({ bytes: pngBytes(64, 32), hint: '一只橘猫', mime: 'image/png' })
  assert.equal(saved.mime, 'image/png')
  assert.match(saved.name, /\.png$/)
  assert.equal(saved.relativePath, path.posix.join('ark-output', saved.name))
  // 预览 URL 必须是 query 形态：宿主注册的 exact 路由按 pathname 精确匹配，
  // 把 id 塞进路径段会让模型拿到的地址命不中路由（预览 404）。
  assert.equal(saved.previewUrl, `/dsh-ark/asset?id=${saved.id}`)
  assert.equal((await fs.readFile(saved.path)).byteLength, saved.bytes)
  const entry = store.get(saved.id)
  assert.equal(entry.path, saved.path)
  assert.equal(entry.mime, 'image/png')
  await fs.rm(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------- config.mjs

test('resolveConfig 用默认值补齐缺字段，且忽略 null/undefined', () => {
  const cfg = resolveConfig({ ark: { imageModel: 'my-model', videoModel: null } })
  assert.equal(cfg.ark.imageModel, 'my-model')
  // videoModel 显式为 null 时回落默认值（而不是写成 null）
  assert.equal(cfg.ark.videoModel, resolveConfig(undefined).ark.videoModel)
  assert.equal(cfg.ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(cfg.speech.resourceTts, 'seed-tts-2.0')
  assert.equal(cfg.output.dir, 'ark-output')
  // 未提供 config 时全部走默认值，且默认值本身是完整的（关键字段不得缺失）
  const d = resolveConfig(undefined)
  assert.ok(d.ark.imageModel && d.ark.videoModel)
  assert.equal(typeof d.ark.requestTimeoutMs, 'number')
  assert.ok(d.ark.requestTimeoutMs > 0)
  // 语音只留一个凭据名，且不该再有旧版 App ID / Access Token 的配置项
  assert.equal(d.speech.apiKeyCredential, 'VOLCENGINE_SPEECH_API_KEY')
  for (const gone of ['appIdCredential', 'accessKeyCredential', 'appIdForApiKey']) {
    assert.equal(d.speech[gone], undefined, `config.speech 不应再有 ${gone}`)
  }
  // 多模态理解相关的配置已随该工具一并移除
  assert.equal(d.ark.visionModel, undefined, 'config.ark 不应再有 visionModel')
})

test('凭据解析：DSH 凭据优先，环境变量兜底', async () => {
  const creds = createCredentialResolver({
    credentials: { resolve: async (ref) => (ref === 'ARK_API_KEY' ? { value: 'from-service' } : undefined) },
    env: { ARK_API_KEY: 'from-env', OTHER: 'env-only' },
  })
  assert.equal(await creds.resolve('ARK_API_KEY'), 'from-service')
  assert.equal(await creds.resolve('OTHER'), 'env-only')
  assert.equal(await creds.resolve('MISSING'), undefined)
  await assert.rejects(() => creds.require('MISSING'), (err) => err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL)
})

test('凭据解析：凭据服务抛错时静默回落到环境变量', async () => {
  const creds = createCredentialResolver({
    credentials: {
      resolve: async () => {
        throw new Error('service down')
      },
    },
    env: { K: 'env-value' },
  })
  assert.equal(await creds.resolve('K'), 'env-value')
})

test('回归：凭据服务在首次解析之后才就绪，也必须能读到（不能固化 apply 时的快照）', async () => {
  // 真实故障形态：插件的 apply 早于 credentials 服务挂载 ⇒ apply 时拿到 undefined。
  // 若把那一刻的结果固化下来，凭据文件里的值**永远**读不到，
  // 而环境变量兜底仍然生效 —— 症状是"文件里明明有值却报 MISSING_CREDENTIAL"，极具误导性。
  let service
  const creds = createCredentialResolver({
    getCredentials: () => service,
    env: {},
  })

  // 服务尚未就绪
  assert.equal(await creds.resolve('ARK_API_KEY'), undefined)

  // 服务随后挂载
  service = { resolve: async (ref) => (ref === 'ARK_API_KEY' ? { value: 'from-late-service' } : undefined) }
  assert.equal(await creds.resolve('ARK_API_KEY'), 'from-late-service')

  // 服务被替换（热重载）后也应当立即跟着变
  service = { resolve: async () => ({ value: 'after-reload' }) }
  assert.equal(await creds.resolve('ARK_API_KEY'), 'after-reload')
})

test('回归：getCredentials 抛错时不影响环境变量兜底', async () => {
  const creds = createCredentialResolver({
    getCredentials: () => {
      throw new Error('ctx not ready')
    },
    env: { K: 'env-wins' },
  })
  assert.equal(await creds.resolve('K'), 'env-wins')
})

test('resolveSpeechCredentials：只认 API Key，旧版凭据不再生效', async () => {
  const cfg = resolveConfig(undefined)

  // ① 有 API Key → 通过，且只带 apiKey（不再有 appId / accessKey 字段）
  const ok = await resolveSpeechCredentials(cfg, {
    resolve: async (ref) => (ref === 'VOLCENGINE_SPEECH_API_KEY' ? 'api-key-1' : undefined),
  })
  assert.equal(ok.scheme, 'apiKey')
  assert.equal(ok.apiKey, 'api-key-1')
  assert.equal('accessKey' in ok, false)
  assert.equal('appId' in ok, false)

  // ② 即便旧版的 App ID + Access Token 都在，也不再被接受 ——
  //    否则会退回一个已被上游拒绝的方案（ASR/音频生成直接 45000000）。
  await assert.rejects(
    () =>
      resolveSpeechCredentials(cfg, {
        resolve: async (ref) =>
          ref === 'VOLCENGINE_TTS_APPID'
            ? 'app-1'
            : ref === 'VOLCENGINE_TTS_ACCESS_KEY'
              ? 'tok-1'
              : undefined,
      }),
    (err) => err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL,
  )

  // ③ 都没有 → MISSING_CREDENTIAL，且错误信息点明该填哪个凭据名
  await assert.rejects(
    () => resolveSpeechCredentials(cfg, { resolve: async () => undefined }),
    (err) =>
      err.code === ARK_ERROR_CODES.MISSING_CREDENTIAL
      && /VOLCENGINE_SPEECH_API_KEY/.test(err.message)
      && /API Key/.test(err.message),
  )
})
