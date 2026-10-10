/**
 * ark-image.mjs 单测。
 *
 * 两条硬规则：
 *  1. **绝不发真实网络请求** —— 所有用例都注入 mock fetchImpl；真实 Key 的端到端验收由 Lead 统一做。
 *  2. 尺寸换算要穷举验证：`size` 写错是这接口最贵的错（一次 400 背后可能已计费一次），
 *     所以档位/比例/边界都要有断言，而不是只测一两条 happy path。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_SIDE,
  MAX_TOTAL_PIXELS,
  MIN_TOTAL_PIXELS,
  generateImage,
  resolveSize,
} from '../lib/ark-image.mjs'
import { ARK_ERROR_CODES, ArkError } from '../lib/errors.mjs'
import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const INVALID_PARAMETER = ARK_ERROR_CODES.INVALID_PARAMETER

// ------------------------------------------------------------------ 测试工具

/** 构造一张最小 PNG（含 IHDR 宽高与结尾 IEND），让 probeImage 能认出格式与完整性。 */
function pngBytes(width = 8, height = 8) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  Buffer.from('IHDR').copy(ihdr, 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const iend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  return new Uint8Array(Buffer.concat([head, ihdr, Buffer.alloc(8), iend]))
}

const PNG = pngBytes(8, 8)
const PNG_B64 = Buffer.from(PNG).toString('base64')

/** 记录每次调用的 mock fetch；handler 拿到的第一参数是 { url, init }。 */
function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const record = { url: String(url), init }
    calls.push(record)
    return handler(record, calls.length)
  }
  impl.calls = calls
  return impl
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function bytesResponse(bytes, contentType = 'image/png') {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } })
}

/** assert.rejects 的断言器：校验 ArkError 的稳定 code（错误语义全在 code 上）。 */
function rejectsWith(code, pattern) {
  return (err) => {
    assert.ok(err instanceof ArkError, `期望 ArkError，实际：${err}`)
    assert.equal(err.code, code, `错误码不符：${err.code}（${err.message}）`)
    if (pattern) assert.match(err.message, pattern)
    return true
  }
}

function assertThrowsCode(fn, code, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ArkError, `期望 ArkError，实际：${err}`)
    assert.equal(err.code, code, `错误码不符：${err.code}（${err.message}）`)
    if (pattern) assert.match(err.message, pattern)
    return true
  })
}

function testConfig(ark = {}) {
  // 退避压到 1ms：重试逻辑必须测，但测试不该真的等 25 秒。
  return resolveConfig({ ark: { rateLimitBackoffMs: 1, ...ark } })
}

/** 每个用例独立的工作区（cwd = store.cwd）+ 独立 mock fetch。 */
async function makeEnv(t, { config, creds, fetchImpl } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-image-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  return {
    cwd,
    store: new ArtifactStore({ cwd }),
    config: config || testConfig(),
    creds: creds || createCredentialResolver({ env: { ARK_API_KEY: 'test-key' } }),
    fetchImpl: fetchImpl || recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] })),
  }
}

// ------------------------------------------------------------ resolveSize

test('resolveSize：档位 × 宽高比 → 契约合法像素尺寸', () => {
  // 1K 的 1,048,576 总像素低于下限 ⇒ 等比放大到 3,686,400：1:1 → 1920x1920、16:9 → 2560x1440
  assert.deepEqual(resolveSize({ size: '1K', aspectRatio: '16:9' }), {
    size: '2560x1440',
    width: 2560,
    height: 1440,
  })
  assert.deepEqual(resolveSize({ size: '1K', aspectRatio: '1:1' }), {
    size: '1920x1920',
    width: 1920,
    height: 1920,
  })
  assert.deepEqual(resolveSize({ size: '1K', aspectRatio: '9:16' }), {
    size: '1440x2560',
    width: 1440,
    height: 2560,
  })
  assert.deepEqual(resolveSize({ size: '2K', aspectRatio: '1:1' }), {
    size: '2048x2048',
    width: 2048,
    height: 2048,
  })
  assert.deepEqual(resolveSize({ size: '2K', aspectRatio: '16:9' }), {
    size: '2731x1536',
    width: 2731,
    height: 1536,
  })
  assert.deepEqual(resolveSize({ size: '4K', aspectRatio: '1:1' }), {
    size: '4096x4096',
    width: 4096,
    height: 4096,
  })
  // 4K+16:9 的总像素在上限内，但长边会到 5461 ⇒ 必须等比缩到单边上限 4096
  assert.deepEqual(resolveSize({ size: '4K', aspectRatio: '16:9' }), {
    size: '4096x2304',
    width: 4096,
    height: 2304,
  })

  // 档位大小写不敏感；缺省 = 2K + 1:1（契约 §1.1 的示例尺寸）
  assert.equal(resolveSize({ size: '2k' }).size, '2048x2048')
  assert.equal(resolveSize({}).size, '2048x2048')
  assert.equal(resolveSize({ aspectRatio: '16:9' }).size, '2731x1536')
  // 数字形式的宽高比也接受
  assert.equal(resolveSize({ size: '2K', aspectRatio: 16 / 9 }).size, '2731x1536')
  // 空字符串等同缺省，不报错
  assert.equal(resolveSize({ size: '   ' }).size, '2048x2048')
})

test('resolveSize：全档位 × 全比例都落在契约合法域内', () => {
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']
  for (const size of ['1K', '2K', '4K']) {
    for (const aspectRatio of ratios) {
      const out = resolveSize({ size, aspectRatio })
      const [w, h] = aspectRatio.split(':').map(Number)
      const label = `${size} ${aspectRatio} → ${out.size}`

      assert.equal(out.size, `${out.width}x${out.height}`, `${label} size 字符串与宽高不一致`)
      assert.ok(out.width <= MAX_SIDE && out.height <= MAX_SIDE, `${label} 单边超过 ${MAX_SIDE}`)
      assert.ok(out.width * out.height >= MIN_TOTAL_PIXELS, `${label} 总像素低于下限`)
      assert.ok(out.width * out.height <= MAX_TOTAL_PIXELS, `${label} 总像素超过上限`)
      // 等比缩放后比例漂移只应来自最后的整数取整
      assert.ok(Math.abs(out.width / out.height / (w / h) - 1) < 0.01, `${label} 宽高比漂移过大`)
    }
  }
})

test('resolveSize：显式「宽x高」原样通过并校验，非法值报 INVALID_PARAMETER', () => {
  assert.deepEqual(resolveSize({ size: '2560x1440' }), { size: '2560x1440', width: 2560, height: 1440 })
  assert.deepEqual(resolveSize({ size: ' 4096 X 2304 ' }), { size: '4096x2304', width: 4096, height: 2304 })
  // 显式像素是硬约束：同时给了宽高比也不再改尺寸
  assert.equal(resolveSize({ size: '2560x1440', aspectRatio: '1:1' }).size, '2560x1440')

  // 1024x1024 = 1,048,576，实测会被 InvalidParameter 拒绝 ⇒ 本地就要拦住
  assertThrowsCode(() => resolveSize({ size: '1024x1024' }), INVALID_PARAMETER, /总像素/)
  assertThrowsCode(() => resolveSize({ size: '100x100' }), INVALID_PARAMETER, /总像素/)
  // 单边上限 / 宽高比域 / 非正数
  assertThrowsCode(() => resolveSize({ size: '4097x4096' }), INVALID_PARAMETER, /单边/)
  assertThrowsCode(() => resolveSize({ size: '4000x100' }), INVALID_PARAMETER, /宽高比/)
  assertThrowsCode(() => resolveSize({ size: '0x100' }), INVALID_PARAMETER, /≥1/)

  // 形状像尺寸但格式不合法、或把比例写进 size，都不能被当成档位猜
  for (const bad of ['2560x', 'x1440', 'axb', '1x2x3', 'abc', '3K', '16:9', '-1x-1']) {
    assertThrowsCode(() => resolveSize({ size: bad }), INVALID_PARAMETER, /无法识别/)
  }
  // 宽高比本身不合法
  assertThrowsCode(() => resolveSize({ size: '2K', aspectRatio: 'abc' }), INVALID_PARAMETER, /无法识别/)
  assertThrowsCode(() => resolveSize({ size: '2K', aspectRatio: '0:1' }), INVALID_PARAMETER, /无法识别/)
  assertThrowsCode(() => resolveSize({ size: '2K', aspectRatio: ':9' }), INVALID_PARAMETER, /无法识别/)
  assertThrowsCode(() => resolveSize({ size: '2K', aspectRatio: '16:9:1' }), INVALID_PARAMETER, /无法识别/)
  assertThrowsCode(() => resolveSize({ size: '2K', aspectRatio: '17:1' }), INVALID_PARAMETER, /合法域/)
  assertThrowsCode(() => resolveSize({ size: '1K', aspectRatio: '1:17' }), INVALID_PARAMETER, /合法域/)
})

test('resolveSize：宽高比边界 16:1 / 1:16 以单边上限为硬约束', () => {
  const wide = resolveSize({ size: '1K', aspectRatio: '16:1' })
  const tall = resolveSize({ size: '1K', aspectRatio: '1:16' })
  assert.deepEqual(wide, { size: '4096x256', width: 4096, height: 256 })
  assert.deepEqual(tall, { size: '256x4096', width: 256, height: 4096 })

  // 契约遗留问题（已在完成信息中反馈）：域边界上「总像素下限 3,686,400」与「单边上限 4096」
  // 在数学上不可兼得 —— max(w*h) 在 16:1 时只有 1,048,576。这里选择保单边上限（否则必被 400 拒绝）。
  assert.ok(wide.width * wide.height < MIN_TOTAL_PIXELS)
  assert.equal(wide.width / wide.height, 16)
})

// ----------------------------------------------------------- generateImage

test('generateImage：请求 URL / 鉴权头 / 请求体与返回值映射', async (t) => {
  const fetchImpl = recordingFetch(() =>
    jsonResponse(
      { data: [{ b64_json: PNG_B64 }], usage: { generated_images: 1 } },
      { headers: { 'x-request-id': 'req-1' } },
    ),
  )
  const env = await makeEnv(t, { fetchImpl })

  const out = await generateImage(
    {
      config: env.config,
      creds: env.creds,
      store: env.store,
      prompt: '一只戴帽子的橘猫插画',
      size: '2K',
      aspectRatio: '16:9',
      guidanceScale: 7.5,
    },
    { fetchImpl },
  )

  assert.equal(fetchImpl.calls.length, 1)
  const [{ url, init }] = fetchImpl.calls
  assert.equal(url, `${BASE_URL}/images/generations`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer test-key')
  assert.equal(init.headers['Content-Type'], 'application/json')

  // 默认模型取自 config（不在这里硬编码模型名：模型快照名会随契约更新）
  assert.deepEqual(JSON.parse(init.body), {
    model: env.config.ark.imageModel,
    prompt: '一只戴帽子的橘猫插画',
    response_format: 'url',
    watermark: false,
    size: '2731x1536',
    guidance_scale: 7.5,
  })

  assert.equal(out.model, env.config.ark.imageModel)
  assert.equal(out.size, '2731x1536')
  assert.equal(out.requestId, 'req-1')
  assert.deepEqual(out.usage, { generated_images: 1 })
  assert.equal(out.images.length, 1)
})

test('generateImage：model / watermark 可覆盖，size:auto 不发送 size', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })

  const out = await generateImage(
    {
      config: env.config,
      creds: env.creds,
      store: env.store,
      prompt: 'x',
      model: 'doubao-seedream-4-5',
      size: 'auto',
      watermark: true,
    },
    { fetchImpl },
  )

  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.model, 'doubao-seedream-4-5')
  assert.equal(body.watermark, true)
  assert.ok(!('size' in body), 'size:auto 时不应发送 size（把画布交给服务端与 prompt）')
  assert.equal(out.size, 'auto')
  assert.equal(out.model, 'doubao-seedream-4-5')

  // auto 只表示「不锁像素总量」；给了宽高比就必须落成具体尺寸，不能静默丢参数
  const withRatio = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env2 = await makeEnv(t, { fetchImpl: withRatio })
  const out2 = await generateImage(
    {
      config: env2.config,
      creds: env2.creds,
      store: env2.store,
      prompt: 'x',
      size: 'auto',
      aspectRatio: '16:9',
    },
    { fetchImpl: withRatio },
  )
  assert.equal(JSON.parse(withRatio.calls[0].init.body).size, '2731x1536')
  assert.equal(out2.size, '2731x1536')
})

test('generateImage：b64_json 产物直接落盘，不额外发下载请求', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })

  const out = await generateImage(
    { config: env.config, creds: env.creds, store: env.store, prompt: '一张图' },
    { fetchImpl },
  )

  assert.equal(fetchImpl.calls.length, 1, 'b64_json 路径不该再发下载请求')
  const [img] = out.images
  assert.match(img.name, /\.png$/, '扩展名应来自魔数而不是 content-type')
  assert.equal(img.mime, 'image/png')
  assert.equal(img.bytes, PNG.byteLength)
  assert.ok(img.relativePath.startsWith('ark-output/'), img.relativePath)
  assert.deepEqual(new Uint8Array(await fs.readFile(img.path)), PNG)
  // 登记进预览表，工具层才能把图片渲染出来
  assert.equal(env.store.get(img.id).path, img.path)
  // query 形态：宿主注册的 exact 路由按 pathname 精确匹配，路径段形态会 404。
  assert.equal(img.previewUrl, `/dsh-ark/asset?id=${img.id}`)
})

test('generateImage：count>1 走 sequential auto，URL 产物逐张下载落盘', async (t) => {
  const urls = ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png', 'https://cdn.example.com/c.png']
  const downloaded = pngBytes(4, 4)
  const fetchImpl = recordingFetch(({ url }) =>
    url.endsWith('/images/generations')
      ? jsonResponse({ data: urls.map((u) => ({ url: u })) })
      : bytesResponse(downloaded),
  )
  const env = await makeEnv(t, { fetchImpl })

  const out = await generateImage(
    { config: env.config, creds: env.creds, store: env.store, prompt: '未来城市天际线 3 个风格变体', count: 3 },
    { fetchImpl },
  )

  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.sequential_image_generation, 'auto')
  assert.deepEqual(body.sequential_image_generation_options, { max_images: 3 })
  // 1 次生成 + 3 次下载：直链 24h 失效，必须当场落盘
  assert.equal(fetchImpl.calls.length, 4)
  assert.deepEqual(fetchImpl.calls.slice(1).map((c) => c.url), urls)
  assert.equal(out.images.length, 3)
  for (const img of out.images) {
    assert.match(img.name, /\.png$/)
    assert.equal(img.bytes, downloaded.byteLength)
    assert.deepEqual(new Uint8Array(await fs.readFile(img.path)), downloaded)
  }
})

test('generateImage：参考图支持本地路径 / https URL / data URL', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })
  await fs.writeFile(path.join(env.cwd, 'ref.png'), PNG)

  await generateImage(
    {
      config: env.config,
      creds: env.creds,
      store: env.store,
      prompt: '指令编辑：把背景换成蓝色',
      referenceImages: ['ref.png', 'https://cdn.example.com/ref.jpg', `data:image/png;base64,${PNG_B64}`],
    },
    { fetchImpl },
  )

  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.deepEqual(body.image, [
    `data:image/png;base64,${PNG_B64}`, // 本地路径被读成 data URL 内联
    'https://cdn.example.com/ref.jpg', // 远程 URL 原样透传
    `data:image/png;base64,${PNG_B64}`, // data URL 原样透传
  ])
})

test('generateImage：本地参考图逃逸 cwd 一律拒绝，且不发任何请求', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })

  // 真实存在于工作区**之外**的文件：这样命中的是逃逸检查，而不是「文件不存在」
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-outside-'))
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }))
  const outsideFile = path.join(outsideDir, 'secret.png')
  await fs.writeFile(outsideFile, PNG)

  const escapeRelative = path.relative(env.cwd, outsideFile) // 形如 ..\dsh-ark-outside-xxx\secret.png
  const base = { config: env.config, creds: env.creds, store: env.store, prompt: 'x' }

  await assert.rejects(
    () => generateImage({ ...base, referenceImages: [escapeRelative] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /工作区/),
  )
  await assert.rejects(
    () => generateImage({ ...base, referenceImages: [outsideFile] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /工作区/),
  )
  assert.equal(fetchImpl.calls.length, 0, '参数错误必须在计费请求之前失败')
})

test('generateImage：参考图的其它非法输入（不存在/非文件/超大/非图片 data URL）', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })
  const base = { config: env.config, creds: env.creds, store: env.store, prompt: 'x' }

  await assert.rejects(
    () => generateImage({ ...base, referenceImages: ['missing.png'] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /不存在/),
  )

  await fs.mkdir(path.join(env.cwd, 'subdir'))
  await assert.rejects(
    () => generateImage({ ...base, referenceImages: ['subdir'] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /不是文件/),
  )

  // >8MB 的内联素材会把 base64 请求体撑爆，明确要求改用 URL（与视频模块同一策略）
  await fs.writeFile(path.join(env.cwd, 'big.png'), Buffer.alloc(8 * 1024 * 1024 + 1))
  await assert.rejects(
    () => generateImage({ ...base, referenceImages: ['big.png'] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /内联上限/),
  )

  await assert.rejects(
    () => generateImage({ ...base, referenceImages: ['data:text/plain;base64,aGk='] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /data:image/),
  )
  await assert.rejects(
    () => generateImage({ ...base, referenceImages: ['  '] }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /非空字符串/),
  )

  assert.equal(fetchImpl.calls.length, 0)
})

test('generateImage：429 按 config.ark.rateLimitRetries 退避重试', async (t) => {
  let attempt = 0
  const fetchImpl = recordingFetch(() => {
    attempt += 1
    if (attempt === 1) {
      // 方舟限流码可能挂在 429 或 400 上，http 层按 code/状态码统一识别
      return jsonResponse(
        { error: { code: 'ModelAccountIpmRateLimitExceeded', message: '请求过于频繁' } },
        { status: 429 },
      )
    }
    return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
  })
  const env = await makeEnv(t, { fetchImpl, config: testConfig({ rateLimitRetries: 2 }) })

  const out = await generateImage(
    { config: env.config, creds: env.creds, store: env.store, prompt: 'x' },
    { fetchImpl },
  )
  assert.equal(fetchImpl.calls.length, 2, '限流应当重试一次后成功')
  assert.equal(out.images.length, 1)

  // 额度为 0 时直接上抛 RATE_LIMITED，不重试
  const exhausted = recordingFetch(() =>
    jsonResponse({ error: { code: 'ModelAccountIpmRateLimitExceeded' } }, { status: 429 }),
  )
  const env2 = await makeEnv(t, { fetchImpl: exhausted, config: testConfig({ rateLimitRetries: 0 }) })
  await assert.rejects(
    () => generateImage({ config: env2.config, creds: env2.creds, store: env2.store, prompt: 'x' }, { fetchImpl: exhausted }),
    rejectsWith(ARK_ERROR_CODES.RATE_LIMITED),
  )
  assert.equal(exhausted.calls.length, 1)
})

test('generateImage：参数错误绝不重试（避免重复计费）', async (t) => {
  const fetchImpl = recordingFetch(() =>
    jsonResponse(
      { error: { code: 'InvalidParameter', message: 'image size is too small' } },
      { status: 400, headers: { 'x-request-id': 'req-400' } },
    ),
  )
  const env = await makeEnv(t, { fetchImpl, config: testConfig({ rateLimitRetries: 3 }) })

  await assert.rejects(
    () => generateImage({ config: env.config, creds: env.creds, store: env.store, prompt: 'x' }, { fetchImpl }),
    (err) => {
      assert.equal(err.code, INVALID_PARAMETER)
      assert.equal(err.requestId, 'req-400')
      assert.match(err.message, /size is too small/)
      assert.equal(err.retryable, false)
      return true
    },
  )
  assert.equal(fetchImpl.calls.length, 1, '给足重试额度也不能重试参数错误')
})

test('generateImage：opts.signal 透传到生成请求，取消抛 ABORTED', async (t) => {
  const controller = new AbortController()
  let seenSignal
  const hangFetch = (url, init) => {
    seenSignal = init && init.signal
    return new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (init && init.signal && init.signal.aborted) return onAbort()
      if (init && init.signal) init.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  const env = await makeEnv(t, { fetchImpl: hangFetch })
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(
    () =>
      generateImage(
        { config: env.config, creds: env.creds, store: env.store, prompt: 'x' },
        { fetchImpl: hangFetch, signal: controller.signal },
      ),
    rejectsWith(ARK_ERROR_CODES.ABORTED),
  )
  assert.ok(seenSignal, 'fetch 必须收到 signal')
  assert.equal(seenSignal.aborted, true, '调用方取消必须传导到传输层')
})

test('generateImage：下载产物阶段的取消同样抛 ABORTED', async (t) => {
  const controller = new AbortController()
  const fetchImpl = recordingFetch(({ url, init }) => {
    if (url.endsWith('/images/generations')) {
      return jsonResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] })
    }
    return new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (init.signal && init.signal.aborted) return onAbort()
      if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true })
    })
  })
  const env = await makeEnv(t, { fetchImpl })
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(
    () =>
      generateImage(
        { config: env.config, creds: env.creds, store: env.store, prompt: 'x' },
        { fetchImpl, signal: controller.signal },
      ),
    rejectsWith(ARK_ERROR_CODES.ABORTED),
  )
  assert.equal(fetchImpl.calls.length, 2, '应当已经进入下载阶段')
})

test('generateImage：缺少凭据时不发请求，报 MISSING_CREDENTIAL', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl, creds: createCredentialResolver({ env: {} }) })

  await assert.rejects(
    () => generateImage({ config: env.config, creds: env.creds, store: env.store, prompt: 'x' }, { fetchImpl }),
    rejectsWith(ARK_ERROR_CODES.MISSING_CREDENTIAL),
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('generateImage：prompt / count / guidanceScale / referenceImages / size 非法时提前报错', async (t) => {
  const fetchImpl = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const env = await makeEnv(t, { fetchImpl })
  const base = { config: env.config, creds: env.creds, store: env.store, prompt: 'x' }

  await assert.rejects(() => generateImage({ ...base, prompt: '   ' }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /prompt/))
  await assert.rejects(() => generateImage({ ...base, count: 0 }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /count/))
  await assert.rejects(() => generateImage({ ...base, count: 1.5 }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /count/))
  await assert.rejects(
    () => generateImage({ ...base, guidanceScale: Number.NaN }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /guidanceScale/),
  )
  await assert.rejects(
    () => generateImage({ ...base, referenceImages: 'ref.png' }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /referenceImages/),
  )
  await assert.rejects(() => generateImage({ ...base, size: '3K' }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /无法识别/))
  await assert.rejects(
    () => generateImage({ ...base, size: '1024x1024' }, { fetchImpl }),
    rejectsWith(INVALID_PARAMETER, /总像素/),
  )
  // 依赖注入缺失同样是参数错误，而不是运行到一半才炸
  await assert.rejects(() => generateImage({ ...base, store: null }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /store/))
  await assert.rejects(() => generateImage({ ...base, creds: null }, { fetchImpl }), rejectsWith(INVALID_PARAMETER, /creds/))

  assert.equal(fetchImpl.calls.length, 0)
})

test('generateImage：响应没有可用产物时报 BAD_RESPONSE', async (t) => {
  const empty = recordingFetch(() => jsonResponse({ data: [] }, { headers: { 'x-request-id': 'req-empty' } }))
  const env = await makeEnv(t, { fetchImpl: empty })
  await assert.rejects(
    () => generateImage({ config: env.config, creds: env.creds, store: env.store, prompt: 'x' }, { fetchImpl: empty }),
    (err) => {
      assert.equal(err.code, ARK_ERROR_CODES.BAD_RESPONSE)
      assert.equal(err.requestId, 'req-empty')
      return true
    },
  )

  const malformed = recordingFetch(() => jsonResponse({ data: [{ finish_reason: 'stop' }] }))
  const env2 = await makeEnv(t, { fetchImpl: malformed })
  await assert.rejects(
    () => generateImage({ config: env2.config, creds: env2.creds, store: env2.store, prompt: 'x' }, { fetchImpl: malformed }),
    rejectsWith(ARK_ERROR_CODES.BAD_RESPONSE, /url|b64_json/),
  )

  // CDN 回 200 但 0 字节：不能当成功交付
  const truncated = recordingFetch(({ url }) =>
    url.endsWith('/images/generations')
      ? jsonResponse({ data: [{ url: 'https://cdn.example.com/x.png' }] })
      : bytesResponse(new Uint8Array(0)),
  )
  const env3 = await makeEnv(t, { fetchImpl: truncated })
  await assert.rejects(
    () => generateImage({ config: env3.config, creds: env3.creds, store: env3.store, prompt: 'x' }, { fetchImpl: truncated }),
    rejectsWith(ARK_ERROR_CODES.BAD_RESPONSE, /0 字节/),
  )
})
