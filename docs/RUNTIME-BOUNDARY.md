# dsh-ark 运行边界验证：只以插件形式运行，不修改 DSH 本体

**问题**：dsh-ark 是否只作为插件运行？有没有改动 DSH 自身？
**结论**：**只以插件形式运行，DSH 本体零改动。** 下面每条都附可复现的证据。
**验证时间**：2026-10-11。

---

## 1. DSH 安装目录：一个字节都没动

```
resources/app.asar            115.7 MB   修改时间 2026-09-29T10:34:26Z
DeepSeek Harness.exe          233.2 MB   修改时间 2026-09-29T10:34:26Z
resources/ 下全部文件                     修改时间 2026-09-29 18:34
```

**关键点**：全部时间戳是 **2026/9/29 18:34**（DSH 安装时刻），而本插件的工作发生在
**10/10–10/11**。若插件改过 DSH，这里必然出现 10 月的修改时间 —— 没有。

app.asar 内部也搜不到任何插件痕迹：

```
✓ 未出现 dsh-ark
✓ 未出现 DeepSeek/插件（两种斜杠写法都查了）
✓ 未出现 ark-output
✓ 未出现 VOLCENGINE_SPEECH_API_KEY
```

复现：`node _recon/verify/check-dsh-untouched.mjs`

---

## 2. 插件装在哪：profile 数据目录，不是 DSH 目录

`dsh-ark` 在 `~/.dsh` 下的**全部**出现位置：

| 位置 | 内容 | 性质 |
|---|---|---|
| `profiles/desktop/package.json` | `"dsh-ark": "link:E:/…/dsh-ark"` + `dsh.profile.bundles` 列表 | profile 数据 |
| `profiles/desktop/pnpm-lock.yaml` | 依赖锁定 | profile 数据 |
| `storages/session_projcache/…` | 会话记录 | 运行时数据 |

加载路径是一个 **Junction**，指向插件自己的目录：

```
~/.dsh/profiles/desktop/node_modules/dsh-ark
  → Junction → <工作区>\dsh-ark
```

即：**DSH 把插件当普通 npm 依赖安装**，代码始终留在插件自己那里，从不拷进 DSH。

---

## 3. 接入方式：全部走 DSH 官方扩展点

配置组合顺序（`cordis.yml` 头部注释原文）：

> The tree is composed as patches: each bundle in package.json's
> `dsh.profile.bundles`, then `cordis.patch.yml`, then any `--patch` overlays.

`dsh-ark` 通过在 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`
成为**其中一个 bundle 层**，由 DSH 在组合时把它的 `insert` 行并入运行时树。
profile 自己的 `cordis.patch.yml` 里**没有** dsh-ark 条目，`cordis.yml` 是 `[]`
（空根，自动生成）—— 说明注入完全经由 bundle 层机制，没有污染用户的 patch 层。

### 运行时注册面（全部为官方 API）

| 半侧 | 调用 | 用途 |
|---|---|---|
| 宿主 | `root.inject(['tools'], ctx => ctx.tools.register(...))` × 6 | 6 个工具 |
| 宿主 | `root.inject(['webServer'], ctx => ctx.webServer.register({kind:'exact', …}))` | 产物预览路由 |
| 宿主 | `ctx.effect(() => () => dispose())` | 卸载清理 |
| 宿主 | `root.get('credentials')` → `creds.resolve()` | 读密钥（**只读**） |
| 客户端 | `ctx.slots.inject('plugins.bundle.config', …)` | 设置页（挂在**自己**的详情页，不占官方座位） |
| 客户端 | `ctx.locale.register(NS, {zh, en})` | 文案 |
| 客户端 | `ctx.remote.credentials.set/describe` | 写/读密钥状态 |
| 客户端 | `ctx.remote.$on('credentials/reference-updated', …)` | 订阅凭据变更 |

**没有** monkey-patch、没有覆盖宿主方法、没有替换官方实现。

---

## 4. 代码面：写操作只有一个，且强制落在工作区内

全量扫描 `lib/` 的写操作（`writeFile`/`mkdir`/`unlink`/`rm`/`rename`/`copyFile`/
`appendFile`/`createWriteStream`/`chmod`）—— 只有两处，同在 `lib/artifacts.mjs`：

```
lib/artifacts.mjs  fs.mkdir    ← ArtifactStore.save
lib/artifacts.mjs  fs.writeFile← ArtifactStore.save
```

落点 = `path.resolve(cwd, config.output.dir)`，`cwd` 取当前会话工作目录，
且**经 `assertInsideWorkspace()` 判定必须落在工作区内**（见下一节）。

同时确认 `lib/` 内**没有**：

- `child_process` / `exec` / `spawn`（无命令执行）
- `eval` / `new Function`（无动态代码）
- `process.env.X = …`（不改环境变量）
- 对 `DeepSeekHarness` / `app.asar` 的任何引用

### 落盘边界：已强制约束在工作区内

**曾经的状况**（本文档上一版如实记录过）：`output.dir` 是配置项却没有校验，
设成 `../../escaped` 或绝对路径时产物会写到工作区外。

**现已修复**（2026-10-11）。判定抽到共享模块 `lib/path-safety.mjs` 的
`assertInsideWorkspace()`，**分两层**执行：

| 层 | 做法 | 挡住的向量 |
|---|---|---|
| ① 词法层 | `path.resolve` 后逐段比较（`rel === '..'` 或 `'..' + sep` 开头即拒） | `../..` 相对上跳、绝对路径、盘符 |
| ② 真实路径层 | 对**已存在的最深祖先**取 `fs.realpath` 再比一次 | 工作区内的 junction / 符号链接指向界外 |

实测结果（`_recon/verify/verify-write-bound2.mjs`）：

```
应当放行：ark-output / out/2026 / .cache / a/b/c        ✓ 均写入工作区内
应当拒绝：../../escaped、../../../escaped、绝对路径、C:\  ✓ 均 INVALID_PARAMETER
应当拒绝：junction → 界外、junction 下的子目录            ✓ 均 INVALID_PARAMETER
拒绝后界外目录内容：空（校验在 mkdir 之前，不留垃圾）
```

**为什么必须两层**：只做词法挡不住 junction（链接路径字面上在工作区内）；
只做 realpath 又对"尚未创建的目录"无从下手 —— 产物目录按设计就是首次落盘时才创建。
所以第二层判的是"最深已存在祖先的真实路径 + 尚未创建的相对尾巴"。

**另外**：错误信息直接告诉用户该改成什么（"请改用工作区内的相对路径，例如 ark-output"），
而不是抛一个裸错误。校验发生在 `mkdir` 之前，所以被拒绝时**不会留下空目录**。

回归测试：`tests/artifact-boundary.test.mjs`（5 个用例），
并用变异测试确认用例有效（去掉校验后逃逸用例确实变红）。

---

## 5. 发布包的精简面

`npm pack` 实际只发 **19 个文件**（`files` 字段 = `lib` / `cordis.patch.yml` /
`README.md` / `docs`）：

- **不含** `tests/`、`scripts/`
- `scripts/*.mjs` 是**仓库里的开发脚本**，不在安装包里；它们会读
  `$DSH_HOME/.credentials.yaml` 取凭据（方便不经宿主直接试），但 **lib/ 从不读该文件**
  —— 插件运行期只经 `ctx.credentials`

---

## 6. 结论与免责说明

**是**：dsh-ark 只以插件形式运行。

- 不修改 DSH 的任何文件（时间戳 + asar 内容双重确认）
- 不替换、不 hook 宿主实现，只调用官方扩展 API
- 唯一的写操作落在工作区内的产物目录（已强制校验，越界即拒绝）
- 卸载 = 从 profile 移除依赖，DSH 本体无需任何还原

**两点要说清楚**：

1. **这个"不修改 DSH"来自代码自身的设计约束，而不是 DSH 的沙箱强制。**
   DSH 的插件与宿主同进程、同权限运行 —— 任何插件在技术上都能写任意路径。
   本插件的保证方式是：代码里根本不存在那样的写操作（已全量扫描），
   并由测试持续看住。所以这条结论的强度是
   "**该插件的实现确信不越界**"，而不是"**DSH 在架构上禁止插件越界**"。

2. **落盘边界现在是被强制执行的，不是靠约定。** `assertInsideWorkspace()` 在
   `mkdir` 之前判定，词法 + realpath 两层；越界直接报 `INVALID_PARAMETER`。
   代价是：如果你**确实**想用绝对路径把产物放到别的盘，现在会被拒绝 ——
   这是刻意的取舍（用户数据写到工作区外更难发现和清理）。若将来要放开，
   应当做成显式的 opt-in 开关并在文档里写明风险，而不是恢复"静默照写"。

---

## 复现命令

```bash
cd <工作区>

# DSH 本体是否被改动（时间戳 + asar 内容 + 文件指纹）
node _recon/verify/check-dsh-untouched.mjs

# 落盘边界：放行与拒绝的完整矩阵（含 junction 逃逸）
node _recon/verify/verify-write-bound2.mjs

# 配置层触发逃逸的端到端复现
node _recon/verify/verify-config-escape-e2e.mjs

# 变异测试：证明边界用例真的能抓住缺陷
node _recon/verify/audit-mutation-boundary.mjs

# 回归测试
cd dsh-ark && node --import ./tests/stub-dsh-loader.mjs --test "tests/artifact-boundary.test.mjs"

# 写操作全量扫描
grep -n "fs\.\(writeFile\|mkdir\|unlink\|rm\|rename\|copyFile\|appendFile\)" dsh-ark/lib/*.mjs
```
