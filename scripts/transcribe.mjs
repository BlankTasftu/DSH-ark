/**
 * 直接（不经宿主）用库做语音转写，端到端验证 ASR。
 *
 * 用法：node scripts/transcribe.mjs --audio <工作区内路径> [--out <dir>] [--lang zh-CN]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { transcribe } from '../lib/volc-asr.mjs'

function fileRefs() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const map = {}
  try {
    const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
    let inRefs = false
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      if (inRefs && /^\S/.test(line)) break
      if (!inRefs) continue
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
      if (m) {
        const v = m[2].trim().replace(/^["']|["']$/g, '')
        if (v) map[m[1]] = v
      }
    }
  } catch {
    /* 空 */
  }
  return map
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const cwd = arg('out', process.cwd())
const audioArg = arg('audio')
if (!audioArg) {
  console.error('用法: node scripts/transcribe.mjs --audio <工作区内音频路径>')
  process.exit(2)
}

// 允许传绝对路径，但必须落在 cwd 内（与工具行为一致）
const relative = path.isAbsolute(audioArg) ? path.relative(cwd, audioArg) : audioArg
const refs = fileRefs()
const creds = createCredentialResolver({
  getCredentials: () => ({ resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined) }),
  env: process.env,
})

console.log('音频: %s', relative)
try {
  const started = Date.now()
  const result = await transcribe({
    config: resolveConfig(undefined),
    creds,
    cwd,
    audioPath: relative,
    language: arg('lang'),
  })
  console.log('✓ 转写成功（%ds）', Math.round((Date.now() - started) / 1000))
  console.log('  格式/体积: %s / %d 字节', result.format, result.bytes)
  console.log('  时长: %s 秒', result.durationMs !== undefined ? (result.durationMs / 1000).toFixed(2) : '?')
  console.log('  分段: %d', result.segments.length)
  for (const [i, seg] of result.segments.entries()) {
    console.log('    %d. [%s-%s ms] %s', i + 1, seg.startMs ?? '?', seg.endMs ?? '?', seg.text)
  }
  console.log('\n全文: %s', result.text)
  if (result.requestId) console.log('request_id: %s', result.requestId)
} catch (err) {
  console.error('✗ 失败:', err.code || '', err.message)
  process.exitCode = 1
}
