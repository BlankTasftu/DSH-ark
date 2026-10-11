# dsh-ark 安全审计报告（Lead 侧）

> 本文件是**修复与结论摘要**。独立的对抗式验证报告见
> [`AUDIT-INDEPENDENT.md`](AUDIT-INDEPENDENT.md)（由独立验证者产出，目标是否证而非确认）。
>
> **审计范围**：`lib/`（11 文件）、`scripts/`（5 文件）、`tests/`（14 文件），约 8,300 行。
> **审计时间**：2026-10-11。**基线提交**：`5a238c2` → 修复后 `HEAD`。

## 1. 总结论

| 维度 | 结论 | 依据 |
|---|---|---|
| API 密钥泄露 | **无** | 内容扫描 + git 全历史 + 运行时 16 处失败注入 + 结构性证据（lib 内零 logger） |
| 隐私泄露 | **无** | 本地文件越界 72/72 拒绝；预览路由 27/27 鉴权正确 |
| 安全漏洞 | **无 P0/P1/P2** | 命令注入 / 原型污染 / ReDoS / SSRF / 整数溢出 全部实测未通过攻击 |
| 无用代码 | **发现并删除 3 处** | 见 §3.3 |
| 缺陷（BUG） | **发现并修复 3 处** | 见 §3.1、§3.2、§3.4 |
| 仓库卫生 | **发现 2 处并清理** | 见 §3.5（生成产物入库）、§3.6（第三方镜像） |

**可利用漏洞：0。** 全部发现均为加固项。

> ⚠️ **审计视角的教训**：§3.5 那条是**前三轮审计（含独立验证者）都漏掉的**。
> 原因是所有审计都在问"密钥会不会泄露到产物里"，没人问"产物该不该进仓库"。
> 「安全」与「仓库卫生」是两类问题，各自需要独立的检查清单 —— 不能指望前者覆盖后者。

## 2. 密钥不泄露的证明链

三层证据，缺一不可（只看代码不算证明）：

1. **静态**：把 4 个真实密钥载入内存逐字节比对 —— 工作区 883 个文本文件、
   全部文件名、`git log --all -p` 全历史、`_backup/` 备份，**零命中**。
   凭据文件在工作区**外**（`git` 实测 `outside repository`）。
2. **运行时**：注入哨兵密钥，构造 5 种失败模式 × 7 条工具失败路径，
   断言哨兵不出现在 `ArkError.message` / `toSummary()` / `JSON.stringify(err)` /
   `cause` 链。**零泄露**。独立验证者另做了 16 处注入（含恶意 `fetchImpl`
   把 `init.headers` 挂到错误上的最坏情况），同样零泄露。
3. **结构性**：`lib/` 内 `console.*` / `logger.*` **零匹配** —— 根本不存在
   "把错误对象整体打印"的代码路径。这是比"我检查了每条路径"更强的保证，
   因为它不依赖"我有没有想全"。

### 关键设计（改动前请先读）

- `http.mjs` 对**带凭据**的请求使用 `redirect: 'error'`，避免 Authorization 被
  重定向带到第三方主机；产物下载才用 `redirect: 'follow'`，且**不带任何凭据头**。
- `ArkError.toJSON()` 是**序列化白名单**，明确不含 `cause`（`cause` 挂着原始
  底层错误对象，是唯一的理论泄露面）。
- `failureText()` 只把 `toSummary()` 这一行字符串交给模型，不交出错误对象。

## 3. 发现与修复

### 3.1 P3-1 凭据掩码在短值上退化成回显（已修）

- **位置**：`lib/index.js` 的 `ark_credential_status`
- **缺陷**：`${value.slice(0,2)}…${value.slice(-2)}` 在长度 ≤ 3 时等于回显原文
  （2 字符 → `MN…MN`；3 字符 → 泄 2/3）。真实火山密钥远超 4 字符，故**当时不可利用**，
  但该输出会进会话记录，一旦换用短 token 就会把密钥写进可分享日志。
- **修复**：按长度分级 —— ≥12 才给首尾各 2 位；更短一律只报长度，不给任何字符。
- **验证**：`tests/plugin.test.mjs` 新增回归用例（逐档 1/2/3 字符 + 长值保持可辨识）；
  并做了**变异测试**（`_recon/verify/audit-mutation-mask.mjs`）：把修复还原成旧写法后
  该用例确实变红（15 pass / 1 fail），证明用例有效而非假绿。

### 3.2 P3-2 `cause` 可携带含 Authorization 的底层错误对象（已加固）

- **现状**：`ArkError` 是不可枚举 `cause` 的载体，`message` / `toSummary()` /
  `JSON.stringify` 均不含它 ⇒ **当前无泄露**。
- **风险**：将来若有人写 `logger.error(err)` 或自行导出会话日志，底层错误对象
  （在恶意/异常 `fetchImpl` 下可能含请求头）会被带出去。
- **加固**：新增 `ArkError.toJSON()` 白名单（`code`/`message`/`httpStatus`/
  `requestId`/`retryable`/`provider`/`name`），**明确不含 `cause`**。
- **验证**：`tests/core.test.mjs` 用哨兵断言 `JSON.stringify(err)` 不含 cause 内容。

### 3.3 无用代码（已删除 3 处）

| 符号 | 位置 | 说明 |
|---|---|---|
| `isTransportError()` | `lib/errors.mjs` | 导出但全仓零引用（含测试） |
| `DEFAULT_ALLOW_LOCAL_VIDEO_AUDIO` | `lib/ark-video.mjs` | 同上；实际开关是 `input.allowLocalVideoAudio` |
| `MAX_REFERENCE_AUDIO_BYTES` | `lib/volc-audio.mjs` | 同上 |

同批检查发现的其它"疑似"经逐条核实**均在用**（`humanSize` / `previewJson` /
`describeFailure` / `truncate` / `hexPreview` / `ASR_FLASH_PATH` / `SIZE_TIERS` 等），
未误删。检测脚本：`_recon/audit-deadcode.mjs`。

### 3.4 `.gitignore` 首行编码损坏（已修）

- **缺陷**：首行中文注释已是**真实的 `?` 字节**（`23 20 3f 3f …`），不是显示问题 ——
  是早先那次 PowerShell 编码事故的残留。
- **影响**：仅注释，无功能影响（`_recon/`、`_backup/` 忽略规则正常）。
- **修复**：重写并补上 `dsh-ark/docs/ark-cli-skills/` 条目。

### 3.5 生成产物被当作源码提交（已清理）——**本次审计的漏项**

- **缺陷**：`ark-output/` 下的 **12 个生成产物**（2 张 JPEG 共约 1 MB + 10 个 MP3）
  被 `git add -A` 一并提交进了仓库，长期占用版本库体积，且让"仓库内容"与
  "运行结果"混在一起。
- **发现经过**：我在做"无用代码/无用文件"普查时按顶层目录统计 `git ls-tree`，
  才注意到 `ark-output/` 出现在提交里。**此前三轮审计（含独立验证者）都没发现** ——
  因为那些审计问的是"密钥会不会泄露到产物里"，而没人问"产物该不该进仓库"。
  这是两类不同的问题，值得记下来。
- **修复**：`git rm -r --cached ark-output`（**只取消跟踪，磁盘文件保留** ——
  它们是你实际要的交付物）+ `.gitignore` 增加 `ark-output/` 与 `dsh-ark/ark-output/`。

### 3.6 第三方 Skills 镜像的处置（已删除）

- `dsh-ark/docs/ark-cli-skills/` 是 `volcengine/ark-cli` v1.0.37 随包 Skills 的
  离线镜像（151 文件 / 1,350 KB，**第三方材料**）。
- **删除前置条件**：有两处源码注释把它当作证据引用，直接删会产生悬空引用。
  因此先把结论**就地内联**成自包含注释（`lib/ark-video.mjs`、`lib/ark-image.mjs`），
  再删除目录，并同步修正 `ARK-API-CONTRACT.md` 的证据来源段与 README 的文档清单。
- 需要原文时可从 npm 重新解包 `ark-cli` 取回（可复现，非不可逆损失）。

## 4. 审计中我自己犯的错误（记录以免误读结论）

1. **把"命令报错"当成"结果为空"**：PowerShell 的 `Get-ChildItem -Include` 用法错误
   直接抛异常，我一度当作"没有凭据副本"。改用 Node 按内容扫描后重做，
   并要求脚本**打印扫描计数**（883 个文件）—— 非零计数才证明结论有依据。
2. **误判 `isLoopbackRequest` 未被调用**：只看了函数定义处，实际调用在 `index.js:151`。
   教训：判断死代码必须用工具全仓搜，不能靠局部阅读。
3. **测试脚本自身的 bug**：ESM 下 `import fs from 'node:fs'` 得到的是**回调版** API，
   `await fs.mkdtemp()` 因此抛 `ERR_INVALID_ARG_TYPE`。这是我的脚本问题，与插件无关。

## 5. 复核方式（结论可复现）

```bash
cd E:/DeepSeek/插件

# 1. 密钥泄露：内容 + 文件名 + git 全历史 + 备份
node _recon/audit-secrets.mjs

# 2. 密钥泄露：运行时（哨兵注入，失败路径全覆盖）
node _recon/verify/audit-leak-runtime.mjs

# 3. 凭据副本：按内容扫全工作区
node _recon/verify/audit-cred-copies.mjs

# 4. 无用代码
node _recon/audit-deadcode.mjs

# 5. 修复项在位 + 版本指纹 + 安全不变量
node _recon/verify/audit-postfix-fingerprint.mjs

# 6. 变异测试（证明 P3-1 用例有效）
node _recon/verify/audit-mutation-mask.mjs

# 7. 全量单测
cd dsh-ark && node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"
```

### 版本指纹

修复后 `lib/` 聚合指纹：**`E26B7F254B91FAC5`**（逐文件 SHA256 见脚本输出）。

> **指纹变了就要重新验。** 独立验证报告绑定的是修复前的 `ED45A1F32CE30B0F`；
> 本次修复（掩码分级 + `toJSON` 白名单 + 删死代码）改动了 `lib/`，
> 因此该报告**不构成对当前 HEAD 的背书** —— 结论按本文件重算。

## 6. 客户端密钥面（原独立报告的盲区，已补验）

独立验证者无法验证 `primitives.SettingsSecretField` 是否真的用密文控件
（该 primitive 属于 DSH 宿主，在本仓库外）。**本次已实测确认**：

```
lib/index.js（DSH app.asar 内 dsh-client-ui-primitives 包）
  type: "password",
  autoComplete: "new-password",
```

即：输入框确为 `type=password`（不回显），且显式要求浏览器不要自动填充。
加上客户端只保留 `{configured, writable, known}` 三个元数据字段、
保存成功后立即清空草稿，**客户端不持有也不回显密钥明文**。盲区已关闭。

## 7. 未覆盖范围（诚实声明）

- 未发起任何**真实计费**调用（审计全程零成本）。
- 未读凭据文件内容（仅检查 ACL、git 跟踪状态与权限）。
- 未做：真实浏览器跨站行为验证、上游对参考 URL 的 SSRF 抓取行为、
  高并发下的竞态压测。
- `tests/` 与 `scripts/` 的覆盖率靠单测保证，本次未做覆盖率统计。
