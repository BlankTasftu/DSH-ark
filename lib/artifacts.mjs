/**
 * 产物落盘与预览。
 *
 * 生成类接口（图片/视频/音频）返回的是 URL 或 base64，模型拿到的是一个**工作区
 * 文件**才有意义（可下载、可预览、可被后续工具读取）。本模块只做三件事：
 *  1. 把字节写到工作区，文件名可读且不冲突；
 *  2. 纯手写解析容器头得出宽高与真实格式（不引入 sharp 等原生库）；
 *  3. 维护产物 id → 绝对路径的登记表，供只读预览路由使用。
 *
 * **落盘边界**：唯一的写操作在 `ArtifactStore.save()`，落点经 `assertInsideWorkspace`
 * 判定必须落在工作区内（词法 + realpath 两层）。越界值会被拒绝而不是照写。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { assertInsideWorkspace } from './path-safety.mjs'

/** 扩展名 → MIME。 */
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'application/octet-stream': 'bin',
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
}

/**
 * 生成一个对文件系统与 URL 都安全的短标签。
 *
 * `maxLen` 是 **UTF-8 字节**上限，不是字符数。
 * 为什么按字节：中文提示词 24 个字符就是 72 字节，按字符截断会拼出很长很长的文件名
 * （实测生成的产物名长到几乎没法在资源管理器里看）。文件名上限按字节算才与文件系统一致。
 */
export function slugify(input, maxBytes = 40) {
  const base = String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!base) return 'asset'

  const encoder = new TextEncoder()
  if (encoder.encode(base).length <= maxBytes) return base

  // 逐字符累加，保证不会把一个多字节字符截成半个（会产生乱码文件名）。
  let out = ''
  let used = 0
  for (const ch of base) {
    const size = encoder.encode(ch).length
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out.replace(/[-.]+$/g, '') || 'asset'
}

/**
 * 从容器头推断真实图片格式与像素尺寸（纯字节解析）。
 * 只认 PNG / JPEG / GIF / WebP —— 这四个覆盖方舟全部图片产物。
 * @param {Uint8Array} bytes
 * @returns {{ format?: string, mime?: string, width?: number, height?: number, complete: boolean }}
 */
export function probeImage(bytes) {
  const b = bytes
  if (!b || b.length < 16) return { complete: false }

  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 宽高为大端 32 位（偏移 16 / 20）
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const width = readU32BE(b, 16)
    const height = readU32BE(b, 20)
    return {
      format: 'png',
      mime: 'image/png',
      width,
      height,
      complete: hasTrailingPngIend(b),
    }
  }

  // JPEG: FF D8 FF；逐段扫描 SOFn 拿宽高
  if (b[0] === 0xff && b[1] === 0xd8) {
    const size = readJpegSize(b)
    return { format: 'jpeg', mime: 'image/jpeg', ...size, complete: endsWith(b, [0xff, 0xd9]) }
  }

  // GIF: GIF87a / GIF89a，宽高为小端 16 位（偏移 6 / 8）
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return {
      format: 'gif',
      mime: 'image/gif',
      width: readU16LE(b, 6),
      height: readU16LE(b, 8),
      complete: b[b.length - 1] === 0x3b,
    }
  }

  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const size = readWebpSize(b)
    return { format: 'webp', mime: 'image/webp', ...size, complete: true }
  }

  return { complete: false }
}

function readU32BE(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}
function readU16LE(b, i) {
  return b[i] | (b[i + 1] << 8)
}
function endsWith(b, tail) {
  if (b.length < tail.length) return false
  for (let i = 0; i < tail.length; i++) {
    if (b[b.length - tail.length + i] !== tail[i]) return false
  }
  return true
}
function hasTrailingPngIend(b) {
  return endsWith(b, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
}

/**
 * 解析 JPEG 尺寸。
 *
 * 段结构（这是之前写错的地方，值得写清楚）：
 *   FF <marker> <len_hi> <len_lo> [payload...]      len 含自身的两字节，不含 marker
 * SOF 的负载依次是：精度(1) / 高(2) / 宽(2) / 分量数(1)…
 * 因此以 marker 位置 i 为基准：
 *   高 = b[i+5], b[i+6]      （i+2、i+3 是 len，i+4 是精度）
 *   宽 = b[i+7], b[i+8]
 * 早期版本把宽高读成了 i+3/i+4 与 i+5/i+6，正好错开一个字节 —— 真实图片会解析出
 * 荒谬的数值（实测一张 1774x2365 的图被读成高 3、宽 0x0ba0）。
 */
function readJpegSize(b) {
  let i = 2 // 跳过 SOI(FFD8)
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      // 不在 marker 边界上（填充或已损坏），逐字节前移容错。
      i += 1
      continue
    }
    const marker = b[i + 1]
    // 无负载的两字节 marker：SOI / EOI / TEM / RSTn
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    // 连续填充的 FF 视为填充字节，跳过
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (i + 3 >= b.length) break
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2) break

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      if (i + 8 >= b.length) break
      const height = (b[i + 5] << 8) | b[i + 6]
      const width = (b[i + 7] << 8) | b[i + 8]
      if (width > 0 && height > 0) return { width, height }
    }
    // SOS 之后是压缩数据，尺寸信息必定在此之前出现；没找到就放弃。
    if (marker === 0xda) break
    i += 2 + len
  }
  return {}
}

function readWebpSize(b) {
  const fourCC = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (fourCC === 'VP8X' && b.length >= 30) {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
    return { width, height }
  }
  if (fourCC === 'VP8 ' && b.length >= 30) {
    const width = readU16LE(b, 26) & 0x3fff
    const height = readU16LE(b, 28) & 0x3fff
    return { width, height }
  }
  if (fourCC === 'VP8L' && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return {}
}

/** 依据 MIME 或魔数猜扩展名。 */
export function extensionFor(mime, bytes) {
  if (mime && EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()]) {
    return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()]
  }
  const probed = probeImage(bytes)
  if (probed.format) return probed.format === 'jpeg' ? 'jpg' : probed.format
  return 'bin'
}

/**
 * 产物仓库：负责命名、落盘、登记与预览 URL。
 *
 * ⚠️ **产物只能落在工作区内。** 这是本插件唯一的写入点，所以边界判定收口在这里：
 * `dir` 配成 `../..`、绝对路径、或指向工作区内的符号链接/junction 时，`save()`
 * 会拒绝并报 `INVALID_PARAMETER`，而不是照写。
 *
 * 为什么必须挡：实测过 `dir: '../../escaped'` 与绝对路径都会写到工作区外 ——
 * 产物是用户数据，写到意料之外的位置既难发现也难清理。
 */
export class ArtifactStore {
  /**
   * @param {object} options
   * @param {string} options.cwd 工作区根目录（产物写入其下的 dir）
   * @param {string} [options.dir] **相对 cwd** 的子目录名，默认 ark-output。
   *   绝对路径或含 `..` 逃逸的值会在 save() 时被拒绝。
   * @param {string} [options.previewBase] 预览路由的 pathname（不含 query）。
   *   产物 URL 形如 `${previewBase}?id=<id>` —— **必须与宿主实际注册的路由形态一致**：
   *   DSH 的 exact 路由按 pathname 精确匹配，把 id 塞进路径段会命不中任何路由（预览 404）。
   */
  constructor({ cwd, dir = 'ark-output', previewBase = '/dsh-ark/asset' }) {
    this.cwd = cwd
    this.dir = dir
    this.previewBase = previewBase
    /** @type {Map<string, { path: string, mime: string, name: string }>} */
    this.assets = new Map()
  }

  get outputDir() {
    return path.resolve(this.cwd, this.dir)
  }

  /**
   * 校验落点在工作区内，返回规范化后的绝对路径。
   * 判定用共享的 assertInsideWorkspace（词法 + realpath 两层，见 lib/path-safety.mjs）。
   * @returns {Promise<string>}
   */
  async resolveOutputDir() {
    return assertInsideWorkspace({
      root: this.cwd,
      target: this.outputDir,
      label: '产物目录（config.output.dir）',
    })
  }

  /**
   * 写入一份产物。
   * @param {object} input
   * @param {Uint8Array} input.bytes
   * @param {string} [input.hint] 文件名提示（通常是 prompt 摘要）
   * @param {string} [input.mime] 上游声明的 MIME
   * @param {string} [input.ext] 强制扩展名
   * @returns {Promise<{ id: string, name: string, path: string, relativePath: string, bytes: number, previewUrl: string, mime: string }>}
   */
  async save({ bytes, hint, mime, ext }) {
    const ext0 = ext || extensionFor(mime, bytes)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const id = randomUUID()
    const name = `${stamp}-${slugify(hint, 32)}-${id.slice(0, 8)}.${ext0}`
    // 落点必须在工作区内：越界直接拒绝，**不写、不建目录**。
    // 校验放在 mkdir 之前，避免"先建了目录再报错"留下垃圾。
    const dirPath = await this.resolveOutputDir()
    await fs.mkdir(dirPath, { recursive: true })
    const abs = path.join(dirPath, name)
    await fs.writeFile(abs, bytes)
    const resolvedMime = mime || MIME_BY_EXT[ext0] || 'application/octet-stream'
    this.assets.set(id, { path: abs, mime: resolvedMime, name })
    return {
      id,
      name,
      path: abs,
      relativePath: path.relative(this.cwd, abs).split(path.sep).join('/'),
      bytes: bytes.byteLength,
      // query 形态：与宿主注册的 exact 路由（按 pathname 匹配）保持一致。
      previewUrl: `${this.previewBase}?id=${encodeURIComponent(id)}`,
      mime: resolvedMime,
    }
  }

  /** 按 id 取回登记的产物（预览路由用）。 */
  get(id) {
    return this.assets.get(id)
  }
}
