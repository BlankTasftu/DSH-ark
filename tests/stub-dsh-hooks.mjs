/**
 * 桩 loader 的 resolve/load 钩子。
 *
 * resolve：把 `@deepseek-ai/dsh-tools` 指向虚拟说明符 `stub:dsh-tools`。
 * load   ：为虚拟说明符产出源码。
 *
 * 刻意只桩这一个模块：插件入口只 import 它一个 peer 包，多桩会掩盖真实的依赖错误。
 */

const STUB_ID = 'stub:dsh-tools'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB_ID, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === STUB_ID) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        // 最小 defineTool：保留注册表真正依赖的字段，并暴露参数 schema 供测试断言。
        export function defineTool(options) {
          if (!options || typeof options.name !== 'string') {
            throw new Error('defineTool: name is required')
          }
          if (typeof options.execute !== 'function') {
            throw new Error('defineTool(' + options.name + '): execute is required')
          }
          return {
            name: options.name,
            description: options.description,
            parameters: options.parameters,
            output: options.output,
            timeoutMs: options.timeoutMs,
            isConcurrencySafe: options.isConcurrencySafe,
            execute: options.execute,
          }
        }
        export class ToolRuntime {}
        export default ToolRuntime
      `,
    }
  }
  return nextLoad(url, context)
}
