/**
 * 编码与文案守卫。
 *
 * 为什么需要这个文件：本项目曾发生过一次真实事故 —— 一次 PowerShell 文本重写把
 * `lib/index.js` 的 UTF-8 中文按本地代码页解释后又以 UTF-8 写回，结果：
 *   1. 全部中文变成 mojibake；
 *   2. **「中文标点 + 换行」处的换行被吞掉**，导致下一行代码被并进上一行的 `//` 注释里。
 *
 * 最危险的地方在于：**125 个用例当时全绿**。因为既有断言只匹配 ASCII 子串
 * （错误码、`taskId`、`/计费/` 这类短词），乱码与结构损坏完全测不出来。
 *
 * 所以这里补两条"内容级"守卫：
 *   - 源码里的关键中文文案必须存在（乱码化会立刻打断它们）；
 *   - 源码里不得出现 mojibake 特征字符（换行被吞这类二次损伤也会带出这些字符）。
 * 这两条与终端编码无关（直接按码点判定），也不会因为文件变大而失效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** mojibake 高发字符：UTF-8 字节被 CP936/GBK 误读后几乎必然出现的汉字。 */
const MOJIBAKE_MARKERS = ['锛', '銆', '鈥', '鐏', '鍥', '鎻', '璺', '鐢', '鏂', '鐨']

/** 每个文件必须出现的关键中文串（覆盖该文件里"给模型/给人看"的核心文案）。 */
const REQUIRED_TEXT = {
  'index.js': [
    '火山方舟能力插件入口',
    '视频任务仍在渲染',
    '不要重新提交',
    '产物预览路由的 pathname',
    '按张数翻倍计费',
    '把音频文件转写成文字',
    '调用失败',
  ],
  'errors.mjs': ['调用已被取消'],
  'artifacts.mjs': ['产物'],
  'config.mjs': ['缺少凭据'],
  'http.mjs': ['下载产物失败'],
  'ark-image.mjs': ['参考图'],
  'ark-video.mjs': ['超时'],
  'volc-tts.mjs': ['结束标记'],
  'volc-asr.mjs': ['语音识别'],
  'volc-audio.mjs': ['音频生成'],
  // 落盘边界的报错文案是用户唯一能看到的提示，被编码破坏就失去可操作性
  'path-safety.mjs': ['必须位于工作区内', '符号链接'],
}

test('lib/*.js(mjs) 不含 mojibake 特征字符（编码事故回归）', async () => {
  const files = (await fs.readdir(LIB_DIR)).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  assert.ok(files.length >= 9, `lib 下源文件数量异常：${files.length}`)

  for (const file of files) {
    const text = await fs.readFile(path.join(LIB_DIR, file), 'utf8')
    const hits = MOJIBAKE_MARKERS.filter((m) => text.includes(m))
    assert.deepEqual(
      hits,
      [],
      `${file} 出现 mojibake 特征字符 ${hits.join('、')} —— 文件很可能被按错误编码重写过`,
    )
    // 替换字符意味着"有字节已经不可逆地丢了"，比乱码更严重。
    assert.ok(!text.includes('\uFFFD'), `${file} 含 U+FFFD 替换字符，说明已有字节丢失`)
  }
})

test('lib/*.js(mjs) 的关键中文文案必须存在（文案级守卫）', async () => {
  for (const [file, probes] of Object.entries(REQUIRED_TEXT)) {
    const text = await fs.readFile(path.join(LIB_DIR, file), 'utf8')
    for (const probe of probes) {
      assert.ok(
        text.includes(probe),
        `${file} 缺少关键文案「${probe}」—— 内容被改动或编码被破坏`,
      )
    }
  }
})

test('index.js 的文件头注释不得吞掉换行（结构级守卫）', async () => {
  const text = await fs.readFile(path.join(LIB_DIR, 'index.js'), 'utf8')
  const lines = text.split('\n')

  /**
   * 事故的直接后果是"代码被并进上一行的 `//` 注释里"。
   *
   * 判据必须避开**字符串与正则里的 `//`**（例如 `/^https?:\/\//i`），否则会误报。
   * 做法：逐字符扫描该行，跟踪是否处于字符串/正则字面量中，只在"真正的行注释"里找语句起始。
   */
  function codeAfterLineComment(line) {
    let inSingle = false
    let inDouble = false
    let inTemplate = false
    let inRegex = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const prev = i > 0 ? line[i - 1] : ''
      if (prev === '\\') continue
      if (inSingle) {
        if (ch === "'") inSingle = false
        continue
      }
      if (inDouble) {
        if (ch === '"') inDouble = false
        continue
      }
      if (inTemplate) {
        if (ch === '`') inTemplate = false
        continue
      }
      if (inRegex) {
        if (ch === '/') inRegex = false
        continue
      }
      if (ch === "'") { inSingle = true; continue }
      if (ch === '"') { inDouble = true; continue }
      if (ch === '`') { inTemplate = true; continue }
      if (ch === '/' && line[i + 1] === '/') {
        // 行注释开始：把后面当作注释内容返回
        return line.slice(i + 2)
      }
      // 正则字面量的粗判：`(` `,` `=` `:` `!` `&` `|` `?` `{` `;` 之后的 `/`
      if (ch === '/' && /[(,=:[!&|?{};\n]/.test(prev)) inRegex = true
    }
    return null
  }

  const suspicious = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const afterComment = codeAfterLineComment(line)
    // ① 注释里出现语句起始 —— 典型"代码被并进注释"。
    if (afterComment && /\b(if|for|while|const|let|function|return)\s*[({]/.test(afterComment)) {
      suspicious.push(`${i + 1}: ${line.trim().slice(0, 90)}`)
    }
    // ② 同一行里同时出现块注释的开与闭，且整行很长 —— 典型"多行块注释被压成一行"。
    const trimmed = line.trim()
    if (/^\/\*.*\*\/$/.test(trimmed) && trimmed.length > 120) {
      suspicious.push(`${i + 1}: [块注释被压成一行] ${trimmed.slice(0, 90)}`)
    }
  }

  assert.deepEqual(suspicious, [], 'index.js 可能存在被吞掉换行的注释（编码事故的结构性症状）')
})

test('index.js 仍然可被解析（防止语法级损坏）', async () => {
  // 直接 import 插件入口：语法错误会在这里炸掉，而不是等到运行时。
  const mod = await import('../lib/index.js')
  assert.equal(mod.default.name, 'dsh-ark')
  assert.equal(typeof mod.default.apply, 'function')
})
