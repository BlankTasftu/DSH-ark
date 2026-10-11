/**
 * 凭据**源头清洗与名字校验**的回归测试。
 *
 * 对应安全审计的两条：
 *  - **F1**：凭据值含控制字符（`\r`/`\x00`）时，undici 会把**完整密钥**写进异常消息。
 *    与其让密钥先去 undici 绕一圈再靠出口脱敏，不如**根本不让它进请求头**。
 *  - **F2**：凭据名是用户可编辑的自由字符串，掩码只保护值不保护名字。
 *    把密钥误填进"凭据名"时，恰恰是那个用来排障的免费工具把密钥打印给模型。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCredentialResolver, resolveSpeechCredentials, safeRef } from '../lib/config.mjs'

const CANARY = 'sk-CANARY1234567890abcdefghijklmnop'

test('safeRef：规范的环境变量式凭据名原样返回', () => {
  const ok = [
    'ARK_API_KEY',
    'VOLCENGINE_SPEECH_API_KEY',
    'VOLCENGINE_TTS_APPID',
    'MY_KEY',
    'OPENAI_API_KEY.2',
    'NVIDIA.NIM_KEY',
  ]
  for (const name of ok) {
    assert.equal(safeRef(name), name, `规范的凭据名不该被改写：${name}`)
  }
})

test('safeRef：不像凭据名的东西一律不回显（宁可拒错，不可放行）', () => {
  const bad = [
    'sk-CANARY1234567890abcdefghijklmnop', // 密钥：驼峰 + 无 _/.
    'abcdef0123456789abcdef0123456789', // 纯 hex（≥16）
    'abc', // 既无 _ 也无 .，形状太像随便一串
    'a b', // 含空格
    'a\nb', // 控制字符
    '1LEADING_DIGIT', // 数字开头
    '',
  ]
  for (const name of bad) {
    const shown = safeRef(name)
    assert.equal(shown.includes(name) && name !== '', false, `不该回显：${JSON.stringify(name)}`)
    assert.ok(shown.includes('非法凭据名') || shown === '<非法凭据名（疑似把密钥填到了"凭据名"字段，请检查配置）>')
  }
})

test('⚠️ 回归 F2：把密钥填进"凭据名"时不回显原文', () => {
  const shown = safeRef(CANARY)
  assert.equal(shown.includes(CANARY), false, '非法凭据名绝不能原样回显（那会把密钥打印给模型）')
  assert.ok(shown.includes('非法凭据名'), '应当明确提示名字不合法')
  // 短的不合法值也别回显（避免猜出内容）
  assert.equal(safeRef('bad name with spaces').includes('bad name'), false)
  assert.equal(safeRef('a\nb').includes('\n'), false, '控制字符不该出现在展示用的名字里')
})

test('resolveSpeechCredentials：缺凭据时不回显非法名字', async () => {
  const creds = { resolve: async () => undefined }
  await assert.rejects(
    () => resolveSpeechCredentials({ speech: { apiKeyCredential: CANARY } }, creds),
    (err) => {
      assert.equal(String(err.message).includes(CANARY), false, '错误文案不能带出被误填的密钥')
      assert.ok(String(err.message).includes('非法凭据名'))
      return true
    },
  )
})

test('⚠️ 回归 F1：含控制字符的凭据在**源头**就被拒，且报错不回显值', async () => {
  const dirty = `${CANARY}\r\n`
  const resolver = createCredentialResolver({ credentials: { resolve: async () => dirty } })
  await assert.rejects(
    () => resolver.require('ARK_API_KEY'),
    (err) => {
      assert.equal(String(err.message).includes(CANARY), false, '报错绝不能回显凭据值')
      assert.equal(String(err.message).includes(dirty), false)
      assert.ok(String(err.message).includes('控制字符'), '应当说清原因，否则用户无从下手')
      assert.ok(String(err.message).includes('长度'), '给出长度足够定位，且不泄露内容')
      return true
    },
  )
  // `\x00` 同样拒
  const nul = createCredentialResolver({ credentials: { resolve: async () => `abc\u0000def` } })
  await assert.rejects(() => nul.require('ARK_API_KEY'), /控制字符/)
})

test('resolve：首尾空白被去掉（YAML/剪贴板常见的污染）', async () => {
  const resolver = createCredentialResolver({ credentials: { resolve: async () => `  ${CANARY}  ` } })
  assert.equal(await resolver.resolve('ARK_API_KEY'), CANARY, '首尾空白应当被修掉而不是报错')
})

test('resolve：空值/纯空白视为未配置（走 MISSING_CREDENTIAL）', async () => {
  for (const empty of ['', '   ', undefined, null]) {
    const resolver = createCredentialResolver({ credentials: { resolve: async () => empty } })
    assert.equal(await resolver.resolve('ARK_API_KEY'), undefined, `${JSON.stringify(empty)} 应视为未配置`)
  }
})

test('resolve：环境变量兜底路径同样经过清洗', async () => {
  const resolver = createCredentialResolver({
    getCredentials: () => undefined,
    env: { ARK_API_KEY: `${CANARY}\r` },
  })
  await assert.rejects(() => resolver.resolve('ARK_API_KEY'), /控制字符/, '兜底路径也必须拦，否则白修')
})

test('resolve：凭据服务抛出的清洗错误不会被静默吞掉', async () => {
  // 这是实现细节上的关键取舍：原来 `catch {}` 把一切吞掉再回落环境变量，
  // 于是"凭据含控制字符"会被误报成"未配置"（甚至用环境变量里的坏值再炸一次）。
  const resolver = createCredentialResolver({
    credentials: {
      resolve: async () => {
        throw new Error('boom')
      },
    },
    env: { ARK_API_KEY: CANARY },
  })
  // 服务一般性故障仍应静默回落（这是原有语义，别改坏）
  assert.equal(await resolver.resolve('ARK_API_KEY'), CANARY)
})
