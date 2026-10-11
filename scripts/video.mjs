/**
 * 直接（不经宿主）用库生成视频，产出真实视频文件。
 *
 * 用法：
 *   node scripts/video.mjs --prompt "..." [--duration 3] [--ratio 16:9] [--resolution 720p] [--audio]
 *
 * 成本提醒：视频**按秒计费**，是本插件单价最高的能力。
 * 本脚本只提交一次任务；若等待超时，请用返回的 taskId 查询，**不要重新运行**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { createVideoTask, waitForVideo } from '../lib/ark-video.mjs'

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

const refs = fileRefs()
const prompt = arg('prompt')
if (!prompt) {
  console.error('用法: node scripts/video.mjs --prompt "..." [--duration 3] [--ratio 16:9] [--resolution 720p] [--audio]')
  process.exit(2)
}

const cwd = arg('out', process.cwd())
const duration = Number(arg('duration', '3'))
const config = resolveConfig(undefined)
const creds = createCredentialResolver({
  getCredentials: () => ({ resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined) }),
  env: process.env,
})

console.log('模型   : %s', config.ark.videoModel)
console.log('提示词 : %s', prompt)
console.log('时长   : %s 秒  比例: %s  分辨率: %s  音频: %s',
  duration, arg('ratio', '(默认)'), arg('resolution', '(默认)'), process.argv.includes('--audio') ? '开' : '关')
console.log('输出到 : %s\n', path.resolve(cwd, config.output.dir))

try {
  const submitted = await createVideoTask({
    config,
    creds,
    cwd,
    prompt,
    duration,
    ...(arg('ratio') ? { ratio: arg('ratio') } : {}),
    ...(arg('resolution') ? { resolution: arg('resolution') } : {}),
    ...(process.argv.includes('--audio') ? { generateAudio: true } : {}),
  })
  console.log('✓ 任务已提交（计费已开始）')
  console.log('  task_id : %s', submitted.taskId)
  console.log('  status  : %s', submitted.status)
  console.log('')

  const result = await waitForVideo({
    config,
    creds,
    cwd,
    store: new ArtifactStore({ cwd, dir: config.output.dir }),
    taskId: submitted.taskId,
  })

  if (result.timedOut) {
    console.log('⏱ 等待超时（任务仍在服务端渲染，不代表失败）')
    console.log('  请用 task_id=%s 查询，**不要重新提交**（那会另建一个计费任务）', submitted.taskId)
  } else if (result.status !== 'succeeded') {
    console.log('✗ 任务未成功，status=%s', result.status)
    if (result.failureReason) console.log('  原因: %s', result.failureReason)
  } else if (!result.videos || result.videos.length === 0) {
    console.log('⚠ 任务成功但没有取到产物文件')
    for (const w of result.warnings || []) console.log('  ⚠ %s', w)
  } else {
    console.log('✓ 生成成功')
    for (const v of result.videos) {
      console.log('  %s', v.path)
      console.log('    %s 字节  %s', v.bytes, v.mime)
    }
  }
} catch (err) {
  console.error('✗ 失败:', err.code || '', err.message)
  if (err.requestId) console.error('  request_id:', err.requestId)
  process.exitCode = 1
}
