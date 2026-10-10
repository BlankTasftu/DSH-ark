/**
 * 插件宿主桩：驱动 lib/index.js 的 apply()，把注册结果暴露出来供测试断言。
 *
 * 这个桩刻意保持"最小但真实"：工具注册表、服务注入、effect 释放、webServer 路由
 * 都按 DSH 的调用约定实现，从而能在不启动 DSH 的前提下验证：
 *   - 工具名/schema/并发标记是否正确注册；
 *   - execute 在凭据缺失、上游报错、取消时是否给出**模型可读**的失败文本而不是抛异常；
 *   - 产物预览路由的信任校验（跨站/非回环必须 403）。
 */

/**
 * 最小输出契约校验器。
 *
 * 为什么必须有：DSH 在真实运行时会拿 `output.schema` 校验 `execute()` 的返回值，
 * 不匹配就报 `tool "…" returned invalid output: …` 并且**调用直接失败**。
 * 而模型实际看到的是 `render` 产出的内容块 —— 这两个方向一旦搞混，
 * 用"不校验输出的桩"跑出来的测试会全绿，真实 GUI 里却一用就炸。这个校验器就是为了消掉这个盲区。
 */
function validateOutput(schema, value, where) {
  const type = schema && schema.type
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(
        `${where}: value must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`,
      )
    }
    return
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${where}: value must be an object`)
    }
    for (const key of schema.required || []) {
      if (!(key in value)) throw new Error(`${where}: missing required property "${key}"`)
    }
    return
  }
  throw new Error(`${where}: 桩未支持校验的 output schema 类型 ${JSON.stringify(type)}`)
}

export function createHost({ config, services = {}, builtins = [] } = {}) {
  const tools = new Map()
  const routes = []
  const effects = []
  const logs = []

  // 可用的服务名 = 显式注入的服务 + 由 builtins 声明的宿主内建能力。
  // 刻意不默认提供 tools/webServer：插件必须自己 inject 声明，测试也要能验证
  // 「服务缺失时插件应当安静跳过」这条路径（否则就是在测一个不存在的宿主）。
  const available = new Set([...Object.keys(services), ...builtins])

  function makeCtx() {
    const ctx = {
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
          // 把注册的 execute 包一层，按 output.schema 校验返回值 —— 复刻注册表在
          // 真实运行时的行为，这样"execute 返回类型与 schema 不符"会在测试里当场暴露。
          const inner = definition.execute
          const register = (args, exec) => {
            const value = inner(args, exec)
            return Promise.resolve(value).then((resolved) => {
              // 工具失败时返回的是失败文本（仍是字符串），一样要走校验。
              validateOutput(definition.output?.schema, resolved, `tool "${definition.name}" 的输出`)
              return resolved
            })
          }
          const wrapped = { ...definition, execute: register }
          tools.set(definition.name, wrapped)
          return () => tools.delete(definition.name)
        },
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const i = routes.indexOf(route)
            if (i >= 0) routes.splice(i, 1)
          }
        },
      },
      // 服务既可按属性访问（ctx.credentials）也可按 get 访问（ctx.get('connection')）
      get(name) {
        return services[name]
      },
      effect(fn) {
        const dispose = fn()
        effects.push(dispose)
        return () => {}
      },
      logger: {
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
        error: (...args) => logs.push(['error', ...args]),
      },
    }
    // 把服务挂成属性，插件里 `ctx.credentials`、`root.get('credentials')` 两种写法都能用。
    for (const [name, value] of Object.entries(services)) ctx[name] = value
    return ctx
  }

  const root = makeCtx()
  // inject: 只有声明的服务都存在时才执行回调 —— 与 DSH 的语义一致（不满足则静默跳过）。
  root.inject = (names, cb) => {
    if (names.some((n) => !available.has(n))) return
    return cb(makeCtx())
  }
  root.get = (name) => services[name]

  // 便捷方法：把宿主内建能力声明为可用。
  root.provide = (...names) => {
    for (const n of names) available.add(n)
    return root
  }

  return {
    root,
    tools,
    routes,
    effects,
    logs,
    /** 释放所有 effect（模拟插件卸载）。 */
    disposeAll() {
      for (const d of effects) {
        try {
          if (typeof d === 'function') d()
        } catch {
          // 卸载失败不应影响断言。
        }
      }
    },
    /** 伪造一个最小 req/res 对，用于驱动路由。 */
    async callRoute(path, { url, headers = {}, method = 'GET' } = {}) {
      const route = routes.find((r) => r.path === path)
      if (!route) throw new Error(`no route registered at ${path}`)
      const chunks = []
      const res = {
        statusCode: 200,
        headers: {},
        writeHead(code, hdrs) {
          this.statusCode = code
          Object.assign(this.headers, hdrs || {})
          return this
        },
        end(chunk) {
          if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        },
      }
      await route.handler({ url: url || path, method, headers, on() {} }, res)
      return { statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }
    },
  }
}

/** 造一个假的 Agent/exec，模拟工具执行上下文。 */
export function createExec({ cwd = process.cwd(), signal = new AbortController().signal } = {}) {
  return { signal, agent: { session: { header: { cwd } } } }
}

/** 造一个可注入的 fetch 记录器：按顺序回放响应。 */
export function createFetchStub(responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = responses.length > 1 ? responses.shift() : responses[0]
    if (!next) throw new Error(`fetch stub exhausted at ${url}`)
    if (typeof next === 'function') return next(url, init)
    const body = next.body === undefined ? '' : next.body
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: next.status ?? 200,
      headers: next.headers ?? { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}
