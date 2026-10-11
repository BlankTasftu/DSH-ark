/**
 * Seed3D 图生 3D 的回归测试。
 *
 * 重点钉住**实测发现的坑**，而不是复述happy path：
 *
 *  1. 响应声明 `fileformat: "glb"` 但 `file_url` 给的是 **zip** —— 二者不一致。
 *     所以解包必须按**内容**判定，不能信扩展名，也不能信 fileformat。
 *  2. zip 用 deflate 压缩（实测），要能解。
 *  3. 解出的模型必须校验 GLB 魔数与声明长度；不一致要报错而不是交付坏文件。
 *  4. 图片以 base64 data URI 内联（实测被接受）。
 *  5. duration 之类的视频字段不该出现在 3D 请求体里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

import {
  build3dRequestBody,
  create3dTask,
  extractModelFromZip,
  MIME_BY_MODEL_EXT,
  normalize3dTask,
  parseZipEntries,
  pickModelUrls,
  resolveInputImage,
  DEFAULT_3D_MODEL,
} from '../lib/ark-3d.mjs'
import { probeModelFile } from '../lib/artifacts.mjs'
import { ARK_ERROR_CODES } from '../lib/errors.mjs'

// ────────────────────────── 构造 ZIP（测试用） ──────────────────────────

/** 造一个最小 GLB：12 字节头 + 一个 JSON 块。 */
function makeGlb(payload = '{"asset":{"version":"2.0"}}') {
  const json = Buffer.from(payload, 'utf8')
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const total = 12 + 8 + padded.length
  const head = Buffer.alloc(12)
  head.write('glTF', 0, 'ascii')
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(total, 8)
  const chunkHead = Buffer.alloc(8)
  chunkHead.writeUInt32LE(padded.length, 0)
  chunkHead.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([head, chunkHead, padded])
}

const crc32Table = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 造一个 ZIP。`method` 支持 0(stored) / 8(deflate)。
 * 手工构造是因为测试不该依赖 archiver 之类的第三方库。
 */
function makeZip(entries, method = 8) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const comp = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + comp.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

// ────────────────────────── 魔数判定 ──────────────────────────

test('probeModelFile：认出 GLB（魔数 + 版本 + 声明长度）', () => {
  const glb = makeGlb()
  const p = probeModelFile(glb)
  assert.equal(p.format, 'glb')
  assert.equal(p.ext, 'glb')
  assert.equal(p.mime, 'model/gltf-binary')
  assert.equal(p.version, 2)
  assert.equal(p.declaredLength, glb.length)
  assert.equal(p.lengthMatches, true)

  // 长度被篡改时必须能察觉
  const bad = Buffer.from(glb)
  bad.writeUInt32LE(glb.length + 999, 8)
  const p2 = probeModelFile(bad)
  assert.equal(p2.format, 'glb')
  assert.equal(p2.lengthMatches, false)
  assert.equal(p2.complete, false, '声明长度不符时不得判为完整')
})

test('probeModelFile：认出 glTF(JSON) / OBJ / STL / PLY，未知内容返回未识别', () => {
  assert.equal(probeModelFile(Buffer.from('{"asset":{"version":"2.0"}}')).format, 'gltf')
  assert.equal(probeModelFile(Buffer.from('ply\nformat ascii 1.0\n')).format, 'ply')
  assert.equal(probeModelFile(Buffer.from('solid cube\nfacet normal 0 0 1\n')).format, 'stl')
  assert.equal(probeModelFile(Buffer.from('# comment\nv 0 0 0\n')).format, 'obj')
  assert.equal(probeModelFile(Buffer.from('PK\u0003\u0004')).format, undefined)
  assert.equal(probeModelFile(Buffer.alloc(4)).complete, false, '太短不算')
})

// ────────────────────────── ZIP 解包 ──────────────────────────

test('parseZipEntries：能列出条目（deflate 与 stored 两种）', () => {
  const glb = makeGlb()
  for (const method of [8, 0]) {
    const zip = makeZip([{ name: 'pbr/mesh_textured_pbr.glb', data: glb }], method)
    const entries = parseZipEntries(zip)
    assert.equal(entries.length, 1, `method=${method}`)
    assert.equal(entries[0].name, 'pbr/mesh_textured_pbr.glb')
    assert.equal(entries[0].uncompSize, glb.length)
    assert.ok(entries[0].dataStart > 0)
  }
})

test('extractModelFromZip：实测形态 —— 目录前缀 pbr/ 下取到 glb 且字节一致', () => {
  const glb = makeGlb()
  const zip = makeZip([{ name: 'pbr/mesh_textured_pbr.glb', data: glb }])
  const r = extractModelFromZip(zip)
  assert.equal(r.name, 'mesh_textured_pbr.glb', '应去掉目录前缀')
  assert.deepEqual(r.bytes, glb, '解出的字节必须与原始完全一致')
})

test('extractModelFromZip：跳过目录项，多文件时取模型而非 readme', () => {
  const glb = makeGlb()
  const zip = makeZip([
    { name: 'pbr/', data: '' },
    { name: 'readme.txt', data: 'hello' },
    { name: 'pbr/mesh.glb', data: glb },
  ])
  const r = extractModelFromZip(zip)
  assert.equal(r.name, 'mesh.glb')
  assert.deepEqual(r.bytes, glb)
})

test('extractModelFromZip：没有模型文件时明确报错，不返回垃圾', () => {
  const zip = makeZip([{ name: 'readme.txt', data: 'no model here' }])
  assert.throws(
    () => extractModelFromZip(zip),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /没有可识别的 3D 模型/.test(err.message),
  )
})

test('extractModelFromZip：不支持的压缩方式要报错而不是瞎解', () => {
  const glb = makeGlb()
  const zip = makeZip([{ name: 'm.glb', data: glb }])
  // 把中央目录与局部头的 method 改成 99（不支持的算法）
  const b = Buffer.from(zip)
  const eocd = b.length - 22
  const cdOff = b.readUInt32LE(eocd + 16)
  b.writeUInt16LE(99, cdOff + 10)
  const lhOff = 0
  b.writeUInt16LE(99, lhOff + 8)
  assert.throws(
    () => extractModelFromZip(b),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /不支持的压缩方式/.test(err.message),
  )
})

test('parseZipEntries：非 ZIP 输入明确报错', () => {
  assert.throws(
    () => parseZipEntries(Buffer.from('this is not a zip at all, definitely not')),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /找不到中央目录/.test(err.message),
  )
})

// ────────────────────────── 请求体 ──────────────────────────

test('build3dRequestBody：实测形态 —— content[].image_url.url', () => {
  const body = build3dRequestBody({ image: 'data:image/jpeg;base64,AAAA' })
  assert.equal(body.model, DEFAULT_3D_MODEL)
  assert.deepEqual(body.content, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }])
  // 3D 不该带视频类字段
  assert.equal(body.duration, undefined)
  assert.equal(body.ratio, undefined)
  assert.equal(body.resolution, undefined)
  assert.equal(body.generate_audio, undefined)
})

test('build3dRequestBody：缺图直接拒绝（别浪费一次计费任务）', () => {
  for (const image of ['', '   ', undefined, null]) {
    assert.throws(
      () => build3dRequestBody({ image }),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /缺少 image/.test(err.message),
    )
  }
})

test('build3dRequestBody：只传用户显式给的细分级别与格式', () => {
  const none = build3dRequestBody({ image: 'x' })
  assert.equal(none.subdivisionlevel, undefined, '未指定就不填，交给服务端默认')
  assert.equal(none.fileformat, undefined)

  const both = build3dRequestBody({ image: 'x', subdivisionLevel: 'high', fileFormat: 'glb' })
  assert.equal(both.subdivisionlevel, 'high')
  assert.equal(both.fileformat, 'glb')
})

// ────────────────────────── 响应解析 ──────────────────────────

test('pickModelUrls：实测形态 content.file_url', () => {
  assert.deepEqual(pickModelUrls({ content: { file_url: 'https://x/a.zip' } }), ['https://x/a.zip'])
})

test('pickModelUrls：兼容别名，且去重', () => {
  const urls = pickModelUrls({
    content: { file_url: 'https://x/a.zip', url: 'https://x/a.zip' },
    file_url: 'https://x/b.zip',
    output_url: 'https://x/c.zip',
    output_urls: ['https://x/c.zip', 'https://x/d.zip'],
  })
  assert.deepEqual(urls, ['https://x/a.zip', 'https://x/b.zip', 'https://x/c.zip', 'https://x/d.zip'])
})

test('normalize3dTask：解析 id/status/file_url，兼容 {phase} 形态', () => {
  const a = normalize3dTask({
    id: 'cgt-1',
    status: 'succeeded',
    content: { file_url: 'https://x/a.zip' },
  })
  assert.equal(a.taskId, 'cgt-1')
  assert.equal(a.status, 'succeeded')
  assert.deepEqual(a.modelUrls, ['https://x/a.zip'])

  const b = normalize3dTask({ id: 'cgt-2', status: { phase: 'running' } })
  assert.equal(b.status, 'running')

  // 失败原因藏在 error 里也要能取到
  const c = normalize3dTask({ id: 'cgt-3', status: 'failed', error: { message: '内部错误' } })
  assert.equal(c.failureReason, '内部错误')
})

// ────────────────────────── 图片内联 ──────────────────────────

test('resolveInputImage：本地图片转 data URI，按扩展名给正确 MIME', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-3d-'))
  try {
    for (const [ext, mime] of [
      ['png', 'image/png'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['gif', 'image/gif'],
    ]) {
      await fs.writeFile(path.join(dir, `a.${ext}`), Buffer.from([1, 2, 3]))
      const uri = await resolveInputImage(`a.${ext}`, dir)
      assert.equal(uri, `data:${mime};base64,AQID`)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveInputImage：URL 与 data URL 原样透传，不做本地读取', async () => {
  for (const ref of ['https://example.com/a.jpg', 'http://example.com/a.png', 'data:image/png;base64,AAAA']) {
    assert.equal(await resolveInputImage(ref, process.cwd()), ref)
  }
})

test('resolveInputImage：工作区外的路径必须被拒绝（复用视频模块的两层判定）', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-3d-esc-'))
  const ws = path.join(base, 'ws')
  await fs.mkdir(ws, { recursive: true })
  const outside = path.join(base, 'secret.jpg')
  await fs.writeFile(outside, Buffer.from([0xff, 0xd8, 0xff]))
  try {
    // 词法越界
    await assert.rejects(
      () => resolveInputImage('../secret.jpg', ws),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /越界/.test(err.message),
      '相对上跳必须被拒',
    )
    // 绝对路径
    await assert.rejects(
      () => resolveInputImage(outside, ws),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER,
      '绝对路径越界必须被拒',
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('resolveInputImage：junction 指向界外时也要拒绝（真实路径层）', async (t) => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-3d-junc-'))
  const ws = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  await fs.mkdir(ws, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 's.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  const link = path.join(ws, 'mnt')
  try {
    try {
      await fs.symlink(outside, link, 'junction')
    } catch {
      return t.skip('本机不允许创建 junction')
    }
    await assert.rejects(
      () => resolveInputImage('mnt/s.jpg', ws),
      (err) => err.code === ARK_ERROR_CODES.INVALID_PARAMETER && /越界/.test(err.message),
      '链接字面上在工作区内，必须靠 realpath 层拦住',
    )
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('MIME_BY_MODEL_EXT：覆盖 glb/gltf', () => {
  assert.equal(MIME_BY_MODEL_EXT.glb, 'model/gltf-binary')
  assert.equal(MIME_BY_MODEL_EXT.gltf, 'model/gltf+json')
})

test('模型优先级：显式 model 覆盖配置，未给时用配置值（配置真的生效）', async () => {
  const { resolveConfig } = await import('../lib/config.mjs')
  const cfg = resolveConfig(undefined)
  const seen = []
  const jsonResponse = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-3d' },
    })

  // 未显式传 model → 用配置里的 model3d
  const viaConfig = await create3dTask(
    {
      config: cfg,
      creds: { require: async () => 'k' },
      cwd: process.cwd(),
      image: 'https://example.com/a.jpg',
    },
    {
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body))
        return jsonResponse({ id: 'cgt-1', status: 'running' })
      },
    },
  )
  assert.equal(viaConfig.taskId, 'cgt-1')
  assert.equal(seen[0].model, cfg.ark.model3d, '未传 model 时应使用配置里的 model3d')

  // 显式传 model → 必须覆盖配置
  await create3dTask(
    {
      config: cfg,
      creds: { require: async () => 'k' },
      cwd: process.cwd(),
      image: 'https://example.com/a.jpg',
      model: 'custom-3d-model',
    },
    {
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body))
        return jsonResponse({ id: 'cgt-2', status: 'running' })
      },
    },
  )
  assert.equal(seen[1].model, 'custom-3d-model', '显式 model 必须覆盖配置')
})

test('create3dTask：上游没返回 id 时报错且提示不要重复提交（避免重复计费）', async () => {
  const { resolveConfig } = await import('../lib/config.mjs')
  await assert.rejects(
    () =>
      create3dTask(
        {
          config: resolveConfig(undefined),
          creds: { require: async () => 'k' },
          cwd: process.cwd(),
          image: 'https://example.com/a.jpg',
        },
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ status: 'running' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
      ),
    (err) => err.code === ARK_ERROR_CODES.BAD_RESPONSE && /不要重复提交/.test(err.message),
  )
})
