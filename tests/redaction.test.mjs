/**
 * 错误文本的**凭据脱敏**回归测试。
 *
 * 对应安全审计的 F1（唯一 medium，已实测复现）：底层 fetch 的异常消息里可能
 * **逐字包含请求头的值**（= 完整密钥），经 `ArkError.message` → `toSummary()`
 * → `guard()` 成为工具返回值，进入模型上下文与会话记录。
 *
 * 触发条件刻意写清楚：凭据里混进 `\r` 或 `\x00` 时，undici 抛
 * `Headers.append: "Bearer <完整密钥>…" is an invalid header value.` —— 而
 * Windows 剪贴板 / 脚本里的 `"…\r\n"` 很容易把 `\r` 带进密钥。
 *
 * 这里**不依赖网络**：直接喂审计实测到的消息形状给脱敏函数与 toSummary()。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ARK_ERROR_CODES, ArkError, redactSecrets, safeUrlForDisplay, toArkError } from '../lib/errors.mjs'

/** 审计实测到的真实形状（金丝雀密钥，非真实凭据）。 */
const CANARY = 'CANARY-SECRET-abcdef1234567890'
const F1_MESSAGE = `网络请求失败：Headers.append: "Bearer ${CANARY}\r\nX-Injected: 1" is an invalid header value.`

test('redactSecrets：擦掉 F1 实测形状里的完整密钥', () => {
  const out = redactSecrets(F1_MESSAGE)
  assert.equal(out.includes(CANARY), false, '完整密钥绝不能出现在脱敏结果里')
  assert.ok(out.includes('已脱敏'), '应当留下"已脱敏"标记，便于判断发生过擦除')
  // 上下文要保留，否则没法排障
  assert.ok(out.includes('invalid header value'), '上游错误语义应当保留')
})

test('redactSecrets：认证头的多种写法都擦掉', () => {
  const cases = [
    `Authorization: Bearer ${CANARY}`,
    `authorization=${CANARY}`,
    `x-api-key: ${CANARY}`,
    `X-Api-Key: ${CANARY}`,
    `api_key: ${CANARY}`,
    `access-token: ${CANARY}`,
    `sent Bearer ${CANARY}`,
    `sent bearer ${CANARY}`,
  ]
  for (const line of cases) {
    assert.equal(redactSecrets(line).includes(CANARY), false, `未擦除：${line}`)
  }
})

test('redactSecrets：32 位以上、大小写+数字齐全的高熵串兜底擦除', () => {
  // 形态与随机密钥一致：无连字符、够长、三类字符齐全（火山密钥的典型形状）
  const long = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE'
  assert.ok(long.length >= 32)
  const out = redactSecrets(`某处意外带出了 ${long} 这串东西`)
  assert.equal(out.includes(long), false, '长串应当被兜底擦掉')
})

test('redactSecrets：标识符**不被误擦**（模型 ID / request_id 必须能读出来）', () => {
  // 这是第一版兜底规则的翻车点：`[A-Za-z0-9]{24,}` 把模型 ID 也擦了，
  // 排障信息被毁。现在要求"无连字符 + ≥32 位 + 三类字符齐全"，这些都不命中。
  const keep = [
    'doubao-seedream-5-0-pro-260628',
    'doubao-seed3d-2-0-260328',
    '021791745537112d5d07458a5ab4d80457611556e9a6a106b2937',
    'zh_female_shuangkuaisisi_uranus_bigtts',
    'seed-tts-2.0',
  ]
  for (const token of keep) {
    assert.ok(redactSecrets(token).includes(token), `不该擦掉标识符：${token}`)
  }
})

test('redactSecrets：正常排障信息**不被误擦**（否则排障会变难）', () => {
  const keep = [
    '网络请求失败：fetch failed',
    '模型 doubao-seedream-5-0-pro-260628 不可用',
    '缺少凭据 ARK_API_KEY。请在「插件 → 已安装」里填入',
    'HTTP 404 · request_id=0217917455371',
    '上游返回 HTTP 401 (AuthenticationError)',
  ]
  for (const line of keep) {
    assert.equal(redactSecrets(line), line, `不该改动正常文案：${line}`)
  }
})

test('⚠️ 回归：ArkError.toSummary() 出口必须已脱敏（这是到达模型的唯一出口）', () => {
  const err = new ArkError(ARK_ERROR_CODES.NETWORK, F1_MESSAGE, { provider: 'ark' })
  const summary = err.toSummary()
  assert.equal(summary.includes(CANARY), false, 'toSummary 是工具返回值的来源，绝不能带出密钥')
  assert.ok(summary.startsWith('NETWORK'), '错误码仍应在最前，便于模型判断')
})

test('⚠️ 回归：toArkError 包装底层异常后，toSummary 也不带密钥', () => {
  // 模拟 undici 抛出的真实异常对象
  const underlying = new TypeError(`Headers.append: "Bearer ${CANARY}" is an invalid header value.`)
  const ark = toArkError(underlying)
  assert.equal(ark.toSummary().includes(CANARY), false, '包装后的摘要同样不能带出密钥')
})

/**
 * F9：上游产物直链是 **TOS 预签名 URL**，query 里带签名，24 小时内谁拿到都能
 * 取走产物。而"下载失败"的警告会进工具返回值 → 模型上下文 → 会话记录（可导出/分享）。
 */
test('⚠️ 回归 F9：safeUrlForDisplay 丢掉预签名 query，只留 host + path', () => {
  const signed =
    'https://tos-cn-beijing.volces.com/ark-output/a1b2.mp4?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=deadbeefcafe1234567890&X-Tos-Expires=86400'
  const shown = safeUrlForDisplay(signed)
  assert.equal(shown.includes('X-Tos-Signature'), false, '签名参数绝不能出现在展示文本里')
  assert.equal(shown.includes('deadbeefcafe1234567890'), false, '签名值不能泄漏')
  assert.ok(shown.startsWith('https://tos-cn-beijing.volces.com/'), 'host 与 path 要保留，否则没法排障')
  assert.ok(shown.includes('签名已省略'), '要明确标出"这里省略了东西"，避免读者以为地址不完整')
})

test('safeUrlForDisplay：无 query 的地址原样保留；非法地址不回显原文', () => {
  assert.equal(
    safeUrlForDisplay('https://example.com/a/b.glb'),
    'https://example.com/a/b.glb',
    '没有 query 时不该改动',
  )
  // 不是 URL 的串可能是"被误当成地址的敏感内容"，不该原样带出去
  assert.equal(safeUrlForDisplay(`Bearer ${CANARY}`).includes(CANARY), false)
  assert.equal(safeUrlForDisplay('').includes('空'), true)
})
