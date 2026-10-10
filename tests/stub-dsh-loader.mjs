/**
 * 测试用 ESM loader：把 `@deepseek-ai/*` 的 peer 依赖替换成最小桩。
 *
 * 为什么需要它：插件在 profile 里跑时，`@deepseek-ai/dsh-tools` 由 DSH 宿主提供；
 * 而在插件仓库里跑 `node --test` 时，这个包并不在 node_modules 里（也不该被复制一份
 * 进来——那样会与宿主版本漂移）。所以我们只桩掉**我们真正用到的那一个函数**
 * `defineTool`，让插件入口可以被真实加载并驱动，而不是把入口排除在测试之外。
 *
 * 用法：node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"
 * 注意：这个 loader 只解析 `@deepseek-ai/` 前缀且以 `/dsh-tools` 结尾的说明符，
 * 其余一律交还给 Node 默认解析，避免掩盖真实的解析失败。
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./stub-dsh-hooks.mjs', pathToFileURL(import.meta.filename))
