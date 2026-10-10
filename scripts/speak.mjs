/**
 * 直接（不经宿主）用库合成一次，用来区分：
 *   A. 宿主还在跑旧代码（没重启）
 *   B. 新的资源推断仍然不对
 * 只打印结论与 request_id，不打印密钥。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { resourceForVoice, synthesizeSpeech } from '../lib/volc-tts.mjs'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
let inRefs = false
const refs = {}
for (const line of text.split(/\r?\n/)) {
  if (/^refs:\s*$/.test(line)) {
    inRefs = true
    continue
  }
  if (inRefs && /^\S/.test(line)) break
  if (!inRefs) continue
  const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
  if (m) refs[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const voice = process.argv[2] || 'zh_female_roumeinvyou_emo_v2_mars_bigtts'
const emotion = process.argv[3] || undefined
console.log('音色:', voice)
console.log('推断资源:', resourceForVoice(voice))

const config = resolveConfig(undefined)
const creds = createCredentialResolver({
  getCredentials: () => ({ resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined) }),
  env: process.env,
})

try {
  const result = await synthesizeSpeech({
    config,
    creds,
    store: new ArtifactStore({ cwd: process.cwd() }),
    text: '你好呀！喜欢我送给你的礼物吗？',
    voice,
    ...(emotion ? { emotion } : {}),
  })
  console.log('✓ 成功:', result.audio.path)
  console.log('  通道:', result.channel, '| 格式:', result.format, '| 段数:', result.segments)
} catch (err) {
  console.log('✗ 失败:', err.code, '—', String(err.message).slice(0, 220))
  if (err.requestId) console.log('  request_id:', err.requestId)
}
