/**
 * 直接（不经宿主）用库调 SeedAudio 1.0 音频生成，产出真实音频文件。
 * 用途：宿主还没重启加载新工具时也能验证/交付；同时作为端到端验收。
 *
 * 用法：
 *   node scripts/audio.mjs --prompt "..." [--format mp3] [--ref-audio <url>] [--out <dir>]
 *
 * 注意：音频生成模型**没有音色参数**（不是 TTS）。想指定声音请在 prompt 里描述，
 * 或用 --ref-audio 给一段参考音频。要"用某个音色念文本"请用 scripts/speak.mjs。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { generateAudio } from '../lib/volc-audio.mjs'

/** 从凭据文件读 refs 段（最小解析；与插件库共用同一份凭据）。 */
function fileRefs() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  let map = {}
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
    map = {}
  }
  return map
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const refs = fileRefs()
const prompt = arg(
  'prompt',
  '用温柔清澈的少女嗓音，轻快而愉快地说出这句话：你好呀！喜欢我送给你的礼物吗？',
)
const cwd = arg('out', 'E:/DeepSeek/插件')

const creds = createCredentialResolver({
  getCredentials: () => ({ resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined) }),
  env: process.env,
})

console.log('凭据：语音 API Key 长度 %d', (refs.VOLCENGINE_SPEECH_API_KEY || '').length)
console.log('提示词：%s', prompt)
console.log('输出到：%s\n', path.resolve(cwd, resolveConfig(undefined).output.dir))

const started = Date.now()
try {
  const result = await generateAudio({
    config: resolveConfig(undefined),
    creds,
    store: new ArtifactStore({ cwd }),
    textPrompt: prompt,
    format: arg('format', 'mp3'),
    // 注意：**没有 --speaker 选项** —— 音频生成模型没有音色概念（传了会被上游 45001115 拒绝）。
    // 想影响声音请在 prompt 里用文字描述，或用 --ref-audio 给参考音频。
    ...(arg('ref-audio') ? { references: [{ audioUrl: arg('ref-audio') }] } : {}),
  })
  console.log('✓ 生成成功（%ds）', Math.round((Date.now() - started) / 1000))
  console.log('  模型:', result.model)
  // 括号里写清"请求的格式"与"实际容器"——实测两者可能不一致（不传 format 时上游给 wav）
  console.log(`  容器: ${result.format}（请求 ${result.requestedFormat}）`)
  console.log('  时长:', result.durationSeconds, '秒')
  console.log('  文件:', result.audio.path)
  console.log('        %d 字节  %s', result.audio.bytes, result.audio.mime)
  if (result.requestId) console.log('  request_id:', result.requestId)
} catch (err) {
  console.error('✗ 失败:', err.code || '', err.message)
  if (err.requestId) console.error('  request_id:', err.requestId)
  process.exitCode = 1
}
