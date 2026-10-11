/**
 * 直接（不经宿主）用库做图生 3D，产物为解包校验后的模型文件。
 *
 * 用法：
 *   node scripts/3d.mjs --image <工作区内相对路径|URL> [--model <id>] [--wait]
 *
 * 成本提醒：3D 生成**按次计费**，提交即产生费用。
 * 本脚本只提交一次任务；若等待超时，请用返回的 taskId 查询，**不要重新运行**。
 *
 * 实测行为（本脚本据此实现）：
 *   · 上游声明 fileformat=glb，但 file_url 给的是 .zip —— 需要解包 + 校验魔数
 *   · 耗时约 7~8 分钟
 *   · 本地图片会被内联成 base64 data URI（上游接受）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { create3dTask, waitFor3d, DEFAULT_3D_MODEL } from '../lib/ark-3d.mjs'

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

const image = arg('image')
if (!image) {
  console.error('用法: node scripts/3d.mjs --image <工作区内相对路径|URL> [--model <id>] [--wait] [--out <cwd>]')
  console.error('  例: node scripts/3d.mjs --image ../ark-output/cat.jpg --wait')
  process.exit(2)
}

const cwd = arg('out', process.cwd())
const config = resolveConfig(undefined)
const model = arg('model', config.ark.model3d || DEFAULT_3D_MODEL)
const refs = fileRefs()
const creds = createCredentialResolver({
  getCredentials: () => ({ resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined) }),
  env: process.env,
})

console.log('模型   : %s', model)
console.log('输入图 : %s', image)
console.log('输出到 : %s\n', path.resolve(cwd, config.output.dir))

try {
  const submitted = await create3dTask(
    { config, creds, cwd, image, model, subdivisionLevel: arg('subdivision') || undefined },
    {},
  )
  console.log('✓ 任务已提交（计费已开始）')
  console.log('  task_id : %s', submitted.taskId)
  console.log('  status  : %s', submitted.status)
  console.log('  （实测约需 7~8 分钟）\n')

  const result = await waitFor3d(
    {
      config,
      creds,
      cwd,
      store: new ArtifactStore({ cwd, dir: config.output.dir }),
      taskId: submitted.taskId,
    },
    {},
  )

  if (result.timedOut) {
    console.log('⏱ 等待超时（任务仍在服务端处理，不代表失败）')
    console.log('  请用 task_id=%s 查询，**不要重新提交**（会另建一个计费任务）', submitted.taskId)
  } else if (result.status !== 'succeeded' && result.status !== 'success') {
    console.log('✗ 任务未成功，status=%s', result.status)
    if (result.failureReason) console.log('  原因: %s', String(result.failureReason).slice(0, 300))
  } else if (!result.models || result.models.length === 0) {
    console.log('⚠ 任务成功但没有取到模型文件')
    for (const w of result.warnings || []) console.log('  ⚠️ %s', w)
  } else {
    console.log('✓ 生成成功')
    for (const m of result.models) {
      console.log('  %s', m.path)
      console.log('    %s 字节  %s', m.bytes, m.mime)
      if (m.fromArchive) {
        console.log('    （自 ZIP 内 %s 解出；原始压缩包 %s 字节）', m.entryName, m.archiveBytes)
      }
    }
    for (const w of result.warnings || []) console.log('  ⚠️ %s', w)
  }
} catch (err) {
  console.error('✗ 失败:', err.code || '', err.message)
  if (err.requestId) console.error('  request_id:', err.requestId)
  process.exitCode = 1
}
