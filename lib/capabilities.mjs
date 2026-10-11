/**
 * 能力开关的共享逻辑。
 *
 * ## 存在理由：两端必须读同一个位置
 *
 * 设置页（`lib/client.js`）把开关写进插件 config 的 `capabilities.<name>`；
 * 宿主（`lib/index.js`）在 `apply` 时读同一个位置来决定"注册哪些工具"。
 * 两边只要有一个键对不上，症状就是"页面勾了没用"，而且**不会有任何报错**。
 * 所以归一化与默认值只在这里声明一次，宿主侧从这里 import；
 * 客户端包不能依赖宿主包（DSH 官方硬性要求），只能在 `lib/client.js` 里
 * 再声明一份 `CAPABILITY_KEYS`，并由 `tests/client.test.mjs` 从两端各自
 * 提取后比对，防止漂移。
 *
 * ## 历史：这里曾有一个 host 侧读写控制器
 *
 * 早期版本在本文件里实现过 `createCapabilityController` / `findOwnEntry`，
 * 打算让浏览器侧经 `host.call` 调它来读写配置。**那套接线从未接通，也不可能接通**：
 * `host.call` / `harness.handle` 属于**动态** Cordis 半侧的能力，而本插件是
 * **静态** bundle（`window.__ModuleLoader__.load`），拿不到这对方法。
 *
 * 真正可用的通道是 DSH 官方的设置表单面 `ctx.configForms.get(entryId)`：
 * 它自带 revision 栅栏、断线重连后的重读、以及"写失败就把已接受的值读回来"的
 * 恢复路径。客户端已经改走那条路，所以那个控制器连同它的 `configEditor` 依赖
 * 一起删除了 —— 留着只会让人以为还有第二条写入路径。
 */

import { CAPABILITIES } from './config.mjs'

/**
 * 把开关归一化成"配置块里的形态"：**只保留被关掉的**。
 *
 * 为什么只写 false：默认是全开，所以 `{ image: false }` 已经表达完整语义，
 * 而把 7 个键全写进去会让用户的配置文件里多出一堆噪音 —— 更糟的是，
 * 将来新增能力时，旧配置里"显式的 true"会让人分不清"用户开了"还是"默认开"。
 */
export function toConfigPatch(capabilities) {
  const patch = {}
  for (const key of Object.keys(CAPABILITIES)) {
    if (capabilities?.[key] === false) patch[key] = false
  }
  return patch
}
