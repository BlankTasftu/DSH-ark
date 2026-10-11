/**
 * 桩 loader 的 resolve/load 钩子。
 *
 * resolve：把两个由 DSH 宿主提供的 peer 包指向虚拟说明符。
 * load   ：为虚拟说明符产出源码。
 *
 * 刻意**只桩这两个**：多桩会掩盖真实的依赖错误。
 * 两者都是"仓库里跑测试时不存在、宿主里存在"的包（不能复制一份进来，会与宿主版本漂移）：
 *   · `@deepseek-ai/dsh-tools`     → defineTool
 *   · `@deepseek-ai/schemastery`   → Config schema 构造器（z.object / z.boolean …）
 */

const STUB_TOOLS = 'stub:dsh-tools'
const STUB_SCHEMA = 'stub:schemastery'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB_TOOLS, shortCircuit: true, format: 'module' }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: STUB_SCHEMA, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === STUB_SCHEMA) {
    return {
      format: 'module',
      shortCircuit: true,
      /**
       * 最小 schemastery 桩：**链式调用返回自身**，并把字段名记录下来。
       *
       * 为什么不写成空实现：`lib/config.mjs` 里用 `z.object({...})` 声明了设置页的
       * 字段路径，而"字段路径"正是最容易写错、且写错后**只会静默失效**的地方
       * （页面写到 A，host 从 B 读，两边都不报错）。桩把 `.default` / `.volatile`
       * 记在 __meta 上，测试就能断言路径与默认值，而不是只断言"没抛异常"。
       *
       * 还必须复刻宿主判定"这是不是一个 schema"的两个标记：
       *   · `toJSON()`            —— `dsh-settings` 的 `schema(entry)` 要求 `"toJSON" in schema`；
       *   · `~standard.vendor`    —— `cordis` 的 `isSchemastery()` 要求它等于 'schemastery'。
       * 缺了它们，测试就断言不了"Config 确实会被宿主当成 schema 用"这件事 ——
       * 而"plugin.Config 为 undefined / 形状不对"正是曾经让设置页开关全灰的 bug。
       */
      source: `
        function makeNode(kind) {
          const node = {
            __kind: kind,
            __meta: {},
            default(v) { this.__meta.default = v; return this },
            volatile() { this.__meta.volatile = true; return this },
            required(v) { this.__meta.required = v; return this },
            pattern(re) { this.__meta.pattern = re; return this },
            description(d) { this.__meta.description = d; return this },
            // 宿主读的是 meta（不是 __meta），所以真实形状要能投影出来。
            get meta() { return this.__meta },
            toJSON() {
              const out = { type: this.__kind, meta: { ...this.__meta } }
              if (this.__kind === 'object') {
                out.dict = {}
                for (const [k, v] of Object.entries(this.__shape || {})) {
                  out.dict[k] = v && typeof v.toJSON === 'function' ? v.toJSON() : v
                }
              }
              if (this.__kind === 'array') {
                out.list = [this.__inner && typeof this.__inner.toJSON === 'function' ? this.__inner.toJSON() : this.__inner]
              }
              return out
            },
          }
          Object.defineProperty(node, '~standard', {
            value: { vendor: 'schemastery', version: 1 },
            enumerable: false,
          })
          return node
        }
        export function boolean() { return makeNode('boolean') }
        export function string() { return makeNode('string') }
        export function number() { return makeNode('number') }
        export function object(shape) {
          const node = makeNode('object')
          node.__shape = shape || {}
          return node
        }
        export function array(inner) {
          const node = makeNode('array')
          node.__inner = inner
          return node
        }
        const z = { boolean, string, number, object, array }
        export default z
      `,
    }
  }
  if (url === STUB_TOOLS) {
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
