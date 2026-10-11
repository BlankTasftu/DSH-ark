/**
 * 绕过运行中的宿主，直接用插件库生成一张图。
 *
 * 为什么需要它：宿主里跑的是旧版代码，而本次修复要重启才生效 —— 但"生成一张图"
 * 这件事本身不依赖宿主，插件的客户端模块（lib/ark-image.mjs）是纯函数，
 * 只要给它 config / creds / store 就能跑。密钥仍从**凭据文件**读（与插件同一条链路），
 * 脚本只报"读到了 / 长度"，绝不打印密钥内容。
 *
 * 用法：node scripts/generate.mjs --prompt "..." [--size 2K] [--aspect 3:4]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { generateImage } from '../lib/ark-image.mjs'

/** 读 $DSH_HOME/.credentials.yaml 的 refs 段（version 1 布局），只取字符串值。 */
function fileBackedCredentials() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, '.credentials.yaml')
  let map = {}
  try {
    const text = fs.readFileSync(file, 'utf8')
    // 只做最小解析：找 refs: 段里 `  NAME: "value"` 形式的行。
    // 刻意不引 yaml 依赖 —— 这是临时排障脚本，够用即可，解析失败按"未配置"处理。
    const lines = text.split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      if (inRefs && /^\S/.test(line)) break
      if (!inRefs) continue
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
      if (!m) continue
      const raw = m[2].trim()
      const value = raw.replace(/^["']|["']$/g, '')
      if (value) map[m[1]] = value
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

const refs = fileBackedCredentials()
console.log('凭据文件读取：命中 %d 项', Object.keys(refs).length)
/**
 * 只报"有没有"和"多长"，**绝不切字符**（安全审计 F3）。
 *
 * 原实现打印 `v.slice(0,2)}…${v.slice(-2)`，而 1 字符 → `a…a`（**等于原文**）、
 * 2 字符 → `ab…ab`（等于原文）、3 字符 → 泄露 2/3。这正是 `lib/index.js` 的
 * `maskSecret` 已经修掉的退化，脚本里没修 —— 而且注释还写着"绝不打印密钥内容"，
 * 文档与实现相反。
 *
 * 另外这里遍历的是**整个凭据文件**（不只本插件那两把），别的插件/服务的密钥
 * 也会被一并打印。所以干脆只输出名字与长度。
 */
for (const [k, v] of Object.entries(refs)) {
  console.log('  %s -> 已读取（%d 字符）', k, String(v).length)
}

const config = resolveConfig(undefined)
const creds = createCredentialResolver({
  getCredentials: () => ({
    resolve: async (ref) => (refs[ref] ? { value: refs[ref] } : undefined),
  }),
  env: process.env,
})

const cwd = arg('cwd', process.cwd())
const prompt = arg(
  'prompt',
  '一位可爱的动漫风格猫娘少女，银白色长发配猫耳，琥珀色大眼睛，身穿白色蕾丝连衣裙，'
    + '坐在窗边的木地板上，午后阳光斜射进来，柔和光晕，蓬松的猫尾巴轻轻晃动，'
    + '治愈系日系插画风格，精致细节，高质量',
)

console.log('\n开始生成…')
console.log('  cwd    =', cwd)
console.log('  size   =', arg('size', '2K'), '| aspect =', arg('aspect', '3:4'))
console.log('  产物目录 =', path.resolve(cwd, config.output.dir))

const started = Date.now()
const store = new ArtifactStore({ cwd, dir: config.output.dir })
const model = arg('model')
const result = await generateImage({
  config,
  creds,
  store,
  cwd,
  prompt,
  size: arg('size', '2K'),
  aspectRatio: arg('aspect', '3:4'),
  // 只有显式传了 --model 才覆盖（generateImage 内部按 undefined 回落到配置默认值）。
  ...(model ? { model } : {}),
})

console.log('\n✓ 生成成功（耗时 %ds）', Math.round((Date.now() - started) / 1000))
console.log('  模型:', result.model, '| 尺寸:', result.size)
for (const img of result.images) {
  console.log('  文件: %s', img.path)
  console.log('        %d 字节  %s  %dx%d', img.bytes, img.mime, img.width ?? '?', img.height ?? '?')
}
if (result.requestId) console.log('  request_id:', result.requestId)
