/**
 * 真实凭据端到端冒烟脚本（由人工/持凭据方运行）。
 *
 * 为什么不在单测里做真实调用：单测必须可重复、零成本、离线可跑；而这里每一次调用
 * **都会真实计费**。所以把它拆成独立脚本，并强制要求显式传 `--yes` 才会发出计费请求。
 *
 * 用法：
 *   # 只读探测（不计费）：确认端点可达、鉴权头形态正确
 *   node scripts/smoke.mjs --probe
 *
 *   # 真实调用（计费）：图片 + 语音合成
 *   ARK_API_KEY=... VOLCENGINE_SPEECH_API_KEY=... \
 *     node scripts/smoke.mjs --image --tts --yes
 *
 * 凭据来源与插件一致：环境变量。脚本不会打印凭据，也不会把它们写进任何文件。
 */

import process from 'node:process'

import { ArtifactStore } from '../lib/artifacts.mjs'
import { createCredentialResolver, resolveConfig } from '../lib/config.mjs'
import { generateImage } from '../lib/ark-image.mjs'
import { synthesizeSpeech } from '../lib/volc-tts.mjs'
import { generateAudio } from '../lib/volc-audio.mjs'
import { transcribe } from '../lib/volc-asr.mjs'

const args = new Set(process.argv.slice(2))
const has = (flag) => args.has(flag)

const config = resolveConfig(undefined)
const creds = createCredentialResolver({ env: process.env })

function log(step, message) {
  console.log(`[${step}] ${message}`)
}

function fail(step, err) {
  console.error(`[${step}] ✗ ${err && err.code ? `${err.code}: ` : ''}${err && err.message ? err.message : err}`)
  if (err && err.requestId) console.error(`        request_id=${err.requestId}`)
  process.exitCode = 1
}

/**
 * 只读探测：不携带凭据打一次真实端点上，用返回的状态码判断可达性与路由形态。
 * 401/403 说明"端点存在且要求鉴权"（正是我们要确认的），网络错误才是问题。
 */
async function probe() {
  const targets = [
    `${config.ark.baseUrl}/images/generations`,
    `${config.speech.baseUrl}/tts/unidirectional/sse`,
  ]
  for (const url of targets) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      })
      const requestId = res.headers.get('x-request-id') || res.headers.get('x-tt-logid') || '(none)'
      log('probe', `${url} → HTTP ${res.status}（${res.status === 401 || res.status === 403 ? '端点存在且要求鉴权 ✓' : '需人工判读'}），request_id=${requestId}`)
    } catch (err) {
      fail('probe', new Error(`${url} 不可达：${err.message}`))
    }
  }
}

async function runImage() {
  const store = new ArtifactStore({ cwd: process.cwd() })
  try {
    const result = await generateImage({
      config,
      creds,
      store,
      prompt: '一枚简约的蓝色圆形徽标，白色背景，居中，扁平风格',
      size: '2K',
      aspectRatio: '1:1',
    })
    log('image', `✓ 生成 ${result.images.length} 张，模型 ${result.model}，尺寸 ${result.size}`)
    for (const img of result.images) log('image', `  → ${img.path}（${img.bytes} 字节，${img.mime}）`)
  } catch (err) {
    fail('image', err)
  }
}

async function runTts() {
  const store = new ArtifactStore({ cwd: process.cwd() })
  try {
    const result = await synthesizeSpeech({
      config,
      creds,
      store,
      text: '你好，这是一次语音合成连通性测试。',
    })
    log('tts', `✓ 通道 ${result.channel}，${result.segments} 段，${result.format}/${result.sampleRate}Hz，结束标记=${result.endMarkerSeen}`)
    if (result.warnings.length > 0) for (const w of result.warnings) log('tts', `  ⚠️ ${w}`)
    log('tts', `  → ${result.audio.path}（${result.audio.bytes} 字节）`)
  } catch (err) {
    fail('tts', err)
  }
}

async function runAudioGen() {
  const store = new ArtifactStore({ cwd: process.cwd() })
  try {
    const result = await generateAudio({
      config,
      creds,
      store,
      textPrompt: '用温柔清澈的少女嗓音，轻快而愉快地说出这句话：你好，这是一次音频生成连通性测试。',
    })
    log('audio', `✓ ${result.format}（请求 ${result.requestedFormat}），时长 ${result.durationSeconds} 秒`)
    log('audio', `  → ${result.audio.path}（${result.audio.bytes} 字节）`)
  } catch (err) {
    fail('audio', err)
  }
}

async function runAsr() {
  // 复用上一步产物；也可用 SMOKE_AUDIO_PATH 显式指定。
  const audioPath = process.env.SMOKE_AUDIO_PATH || 'ark-output'
  try {
    const result = await transcribe({ config, creds, audioPath, cwd: process.cwd() })
    log('asr', `✓ 时长 ${(result.durationMs / 1000).toFixed(2)} 秒，${result.segments.length} 段`)
    log('asr', `  ${result.text}`)
  } catch (err) {
    fail('asr', err)
  }
}

async function main() {
  if (has('--probe')) {
    await probe()
    return
  }

  const wantsBilling = has('--image') || has('--tts') || has('--audio') || has('--asr')
  if (!wantsBilling) {
    console.log(
      '没有指定动作。可用：--probe（只读探测）/ --image / --tts / --audio / --asr'
        + '（后四者会真实计费，需同时传 --yes）',
    )
    return
  }
  if (!has('--yes')) {
    console.error('拒绝执行：真实调用会产生费用。确认后请显式加上 --yes。')
    process.exitCode = 2
    return
  }

  if (has('--image')) await runImage()
  if (has('--tts')) await runTts()
  if (has('--audio')) await runAudioGen()
  if (has('--asr')) await runAsr()
}

await main()
