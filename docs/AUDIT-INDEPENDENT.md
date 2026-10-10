# dsh-ark 独立安全审计报告（对抗式）

> 审计者：teammate `verifier`（独立于实现者）
> 任务：`task-4`「独立验证：dsh-ark 的密钥泄露、隐私与安全漏洞（对抗式）」
> 审计时间：2026-10-11 02:11 – 02:35 (Asia/Shanghai)
> 被测版本：`<工作区>\dsh-ark`，`lib/` 共 11 个文件（含 `client.js` 浏览器半侧）
> 基线：`node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"` → **167 tests / 167 pass / 0 fail / 0 skipped**
> 审计脚本：`<工作区>\_recon\verify\audit-a1..a7*.mjs`（**只读 `lib/**`，未修改任何被测代码**）
>
> **审计版本绑定（重要）**：审计期间实现方仍在并发改动 `lib/`（`errors.mjs` 02:12:34、`ark-video.mjs` 02:13:01、`volc-audio.mjs` 02:13:07）。
> 为确保结论可追溯，本报告的全部实测绑定到以下内容指纹（`Get-FileHash -Algorithm SHA256` 前 12 位）：
>
> ```
> ark-image.mjs=1DC1F2187998   ark-video.mjs=AC1D3DED4643   artifacts.mjs=BD06FA2F3F6D
> client.js=A68BC70DF6DF       config.mjs=80916B889D9B      errors.mjs=55C5A021B00A
> http.mjs=616C7FAC4FB5        index.js=9DBD3822AD50        volc-asr.mjs=2BA61CFA341A
> volc-audio.mjs=DA31A94058B0  volc-tts.mjs=D9F46A1186D5
> lib/ 聚合指纹 = ED45A1F32CE30B0F      HEAD = 5a238c2
> ```
>
> **并发改动影响评估**：02:12 之后 `lib/` 的改动是**纯删除未使用的 `isTransportError()`**（`git diff` 实测：`errors.mjs` -5 行、`ark-video.mjs` -2 行、`volc-audio.mjs` -1 行，共 8 行删除、0 行新增）。
> 它**不影响**本报告任何结论：`ArkError` 构造函数（`cause: info.cause`）、`toSummary()`、`http.mjs:115-119` 的 `cause: err` 均未改动（已逐行复核）。
> 全部脚本已在当前指纹上**回归复跑通过**（A1 15/0、A3 10/2、A6 36/0、A7 27/0）。
> **若上述指纹变化，本报告结论需重新验证。**
>
> **目标声明**：本报告的目标是**推翻**"安全"这一结论。因此下面**每一节都列出了实际试过的攻击向量与原始输出**；
> 空结论（"看代码觉得没问题"）不作为结论使用。

---

## 0. 结论摘要

| 级别 | 数量 | 说明 |
|---|---|---|
| **P0 密钥泄露** | **0** | **未发现任何真实密钥泄露路径**（详见 §1、§6） |
| P1 安全 | 0 | 路径逃逸、穿越、原型污染、ReDoS、注入、SSRF 均未复现 |
| P2 隐私 | 0 | 预览路由访问控制与产物内容均未发现越权读取 |
| P3 加固项 | 4 | 掩码退化、cause 携带请求头、凭据文件 ACL、_recon 残留测试密钥 |

**「是否发现密钥泄露」的明确结论：没有发现真实密钥泄露。** 具体地：
- 密钥**没有**进入 `ArkError.message` / `toSummary()` / 返回值 / 产物文件名 / `previewUrl` / 日志（实测 15 项全通过，§1）；
- **真实 undici 错误对象里不含 `Authorization`**（关键实测，§1.3）——这是本次审计最想推翻、但**没能推翻**的一条；
- git 全历史、`_recon/`、`_backup/` 中**没有真实密钥**（§2）。

**最严重的一条（P3-1）**：`ark_credential_status` 的掩码在凭据长度 ≤ 3 时**退化为完整回显**（实测 1 字符、2 字符密钥被完整打印）。真实火山密钥长度远大于此，故**当前不可利用**；但它是一条"若换用短凭据即失效"的脆弱掩码，且工具输出会进会话记录。

---

## 1. 密钥泄露（最高优先级）

### 1.1 审计方法

注入**可识别的假密钥**，对错误对象做**深度序列化**（遍历 `cause` 链、非枚举属性、`stack`、`util.inspect`），然后搜索密钥字符串。脚本：`_recon/verify/audit-a1-secret-in-errors.mjs`。

```js
const ARK_SECRET = 'FAKE-ARK-KEY-LEAKCANARY-0123456789abcdef'
const SPEECH_SECRET = 'FAKE-SPEECH-KEY-LEAKCANARY-fedcba9876543210'
```

### 1.2 实测结果：15 项检查全部未泄露

```
=== 1. 真实 undici 网络失败（未监听端口）===
  PASS  requestJson 网络失败 未泄露
   message = "网络请求失败：fetch failed"
   cause 类型 = TypeError | cause.message = "fetch failed"
   cause 属性 = stack,message,cause
  PASS    cause 子图 未泄露
   cause dump 片段 = "stack,message,cause | message= | fetch failed | cause= | stack,message | message= | bad port | Error: bad port\n    at makeNetworkError ..."

=== 2. 真实 TLS 握手失败（自签名证书，端口 1 必然失败）===
  PASS  requestJson TLS 失败 未泄露
   message = "网络请求失败：fetch failed"
   cause   = "fetch failed"

=== 3. 上游返回畸形/含敏感串的响应体 ===
  PASS  requestJson 非 JSON 200 响应体 未泄露
  PASS  requestJson 401 回显了请求头 未泄露
  PASS  requestJson 500 空体 未泄露
  PASS  requestJson 429 空体 未泄露

=== 4. 底层异常自带 init.headers 时（模拟最坏情况）===
     错误对象图（含 cause）含密钥 = true   ← http.mjs:118 把整个 err 挂到 cause
     ArkError.message        含密钥 = false
     toSummary()（工具层展示） 含密钥 = false
     JSON.stringify(err)      含密钥 = false   ← cause 是不可枚举属性，不被序列化
  PASS  底层异常带 headers 时，ArkError.message 不含密钥 未泄露
  PASS  底层异常带 headers 时，toSummary() 不含密钥 未泄露
  PASS  JSON.stringify(ArkError) 不含密钥 未泄露

=== 5. 真实工具层（generateImage / createVideoTask）失败 ===
  PASS  generateImage 网络失败 未泄露
  PASS  createVideoTask 网络失败 未泄露

=== 6. 语音链路（X-Api-Key）===
  PASS  synthesizeSpeech 网络失败 未泄露
   code = NETWORK | message = "语音合成网络请求失败：fetch failed"

=== 7. ArkError 自身 ===
  toSummary  = "X — msg"
  PASS  ArkError.toSummary 不回显 cause 内容

================ A1 结果: pass=15 泄露=0 ================
```

### 1.3 【重点】undici 失败异常里到底有没有请求信息？—— **没有**

任务是明确点名怀疑这一点："undici 的 fetch 失败异常里可能包含请求信息"。**我实际构造了失败请求并把整个错误对象图挖到最深处，结论是它不含 `Authorization`。**

`lib/http.mjs` 的 `catch` 分支把**整个** `err` 作为 `cause`：

```js
// lib/http.mjs:115-119
throw new ArkError(
  ARK_ERROR_CODES.NETWORK,
  `网络请求失败：${err && err.message ? err.message : String(err)}`,
  { provider, retryable: true, cause: err },   // ← 整个 err 进了 cause
)
```

实测挖到的 undici 错误图是：

```
ArkError("网络请求失败：fetch failed")
  └─ cause: TypeError("fetch failed")
       ├─ stack
       ├─ message = "fetch failed"
       └─ cause: Error("bad port")          ← 仅端口信息
            └─ stack（node:internal/deps/undici/undici:...）
```

**没有 URL、没有 method、没有 headers**。16 处失败注入（未监听端口 / TLS 失败 / 401 / 500 / 429 / 空体 / 非 JSON 体）中，密钥字符串一次都没出现。

**为什么不该因此判"零风险"**：`cause` 确实是一个可序列化的对象，且**只要底层库（含未来版本的 undici、或任何自定义 `fetchImpl`）把请求信息附在错误上，密钥就会进入 `cause`**。我用一个"恶意 `fetchImpl`"证明了这一点（§1.2 第 4 项：错误对象图含密钥 = true），而恰好：
- `ArkError.message` 仍不含密钥（`message` 只取 `err.message`）；
- `toSummary()` 不含密钥；
- `JSON.stringify(err)` 不含密钥（`cause` 是不可枚举属性）。
所以**今天没有泄露路径**，但这是"未来一旦有人把 err 整体交给日志就会泄露"的脆弱点 → 记为 P3-2。

### 1.4 日志面：**代码里根本没有任何日志调用**

这是"密钥不会经日志泄露"的**结构性证据**（不是"我觉得不会"）：

```powershell
> Select-String -Path lib\*.js,lib\*.mjs -Pattern 'logger\.|console\.(log|error|warn|info|debug)'
(无匹配)
```

工具层失败时只把 `ArkError.toSummary()`（纯字符串，实测不含密钥）交给模型：

```js
// lib/index.js: failureText → ark.toSummary()
const ark = toArkError(err)
const lines = [`[${name}] 调用失败`, ark.toSummary()]
```

### 1.5 `ark_credential_status` 掩码：实测各长度表现

脚本 `_recon/verify/audit-a3-credential-status.mjs`，用真实工作区插件 + 假凭据驱动：

```
超长典型密钥(40)  → - ARK_API_KEY（图像 / 视频）：环境变量 ar…AA（40 字符）   ← 安全
中等(16)        → 环境变量 BB…BB（16 字符）                              ← 安全
短(8)           → 环境变量 CC…CC（8 字符）                               ← 安全
极短(6)         → 环境变量 DD…DD（6 字符）                               ← 安全
边界(5)         → 环境变量 EE…EE（5 字符）                               ← 安全
边界(4)         → 环境变量 FG…HI（4 字符）                               ← 安全（首尾各 2，恰好不重合）
边界(3)         → 环境变量 JK…KL（3 字符）                               ← **泄 2/3 字符**
边界(2)         → 环境变量 MN…MN（2 字符）                               ← **完整回显**
边界(1)         → 环境变量 O…O（1 字符）                                ← **完整回显**
```

掩码实现（`lib/index.js:684`）：

```js
const masked = value ? `${value.slice(0, 2)}…${value.slice(-2)}（${value.length} 字符）` : '—'
```

长度 ≤ 4 时首尾两段重叠 ⇒ 退化。见 §3 P3-1。

### 1.6 客户端（浏览器半侧）：密钥未进入 DOM 之外的任何位置

审计项 4 的实测结论：

| 检查 | 结果 |
|---|---|
| 客户端是否有 `console.*` / logger / 埋点 | **无匹配**（`Select-String` 实测为空） |
| 草稿是否进 `statusLine` / 错误文案 | **否** —— `statusLine` 只存 i18n 键名（`'nothingToSave'`/`'savedHint'`），`failed` 只存布尔 |
| 草稿是否被 `JSON.stringify` 到别处 | **否** |
| 草稿去向 | 只经 `props.controller.edit()` → `drafts` → `snapshot().fields[*].text` → `primitives.SettingsSecretField` 的 `text` prop（密码控件） |
| `lib/client.js` 是否有网络上报 | **无** |

`snapshot()` 确实把明文草稿放在 `state.fields[].text` 里（这是受控密码输入框的常规做法，值必须回填才能受控），并且该快照通过 `createStore` 发布给视图。**代码层面未发现把它写到磁盘、日志或远端**；控件本体在 DSH 宿主内置原语 `primitives.SettingsSecretField` 内（本仓库外），其 DOM 是否为 `type=password` **我无法在本仓库内验证** → 见 §7 未覆盖项。

---

## 2. git 历史与 _recon / _backup 的密钥残留

### 2.1 git 全历史扫描：**无真实密钥**

```powershell
> git log --all -p | Select-String <密钥形态> | Measure-Object
X-Api-Key 长值            命中行数=0
ark- 前缀长 token          命中行数=1     ← 逐条判定后为文档 URL
Bearer 长 token           命中行数=0
常见密钥环境变量赋值         命中行数=2     ← 逐条判定后为占位符
refs: 段出现               命中行数=0
credentials.yaml         命中行数=14    ← 仅文档中提及文件名，非内容
```

对唯一可疑的 `ark-` 命中做了脱敏定位（脚本 `audit-a4-git-secret.mjs`，**只打印脱敏形态**）：

```
--- commit 440620f1  dsh-ark: 火山方舟插件（图像/语音/视频/理解）+ 133 单测
    文件: dsh-ark/docs/ark-cli-skills/arkcli-train-finetune/references/ark-finetune-sdk.md
    token(脱敏): ark-pu*******************jing（共 29 字符）
    上下文: "   python -m pip install https://<TOKEN>.tos-cn-beijing.volces.com/ark-sdk/ark_s"
疑似真实密钥的命中数 = 0
```

⇒ 是 pip 安装 URL 里的 `ark-sdk` 桶名，**非密钥**。

**git 历史中从未出现过凭据类文件**：

```powershell
> git log --all --pretty=format: --name-only | Sort-Object -Unique |
    Where-Object { $_ -match 'credential|secret|\.env|key|token' }
dsh-ark/docs/ark-cli-skills/arkcli-auth/references/api-key-query.md
dsh-ark/docs/ark-cli-skills/arkcli-plans/references/arkcli-plans-personal-rotate-apikey.md
dsh-ark/docs/ark-cli-skills/arkcli-plans/references/arkcli-plans-team-rotate-apikey.md
dsh-ark/docs/ark-cli-skills/arkcli-profile/references/arkcli-profile-keys.md
```

全部是 ark-cli 的第三方技能文档。

### 2.2 `_recon/` / `_backup/`：**无真实密钥，但有一批测试用密钥**

扫描 294 个文件，命中 8 处；逐处脱敏判定后（脚本 `audit-a6-web-vectors.mjs` 第一节）：

```
--- _recon/diag-scenario-c.mjs            L28:  env: { <HIT:28字符>' }            ← 空字符串字面量
--- _recon/probe-audio-generation.mjs     L105: references: [{ speaker: <HIT:38字符> }]  ← speaker 音色 id，非密钥
--- _recon/toolkit/package/lib/plugin-update.js L449: `.dsh-<HIT:26字符>${token}`  ← 本地缓存目录名
--- _recon/verify/audit-leak-runtime.mjs  L23:  const ARK_SENTINEL = '<HIT:41字符>' ← 我自己的泄漏哨兵常量
--- _recon/verify/v2-path-escape.mjs      L23:  const SECRET_TEXT = <HIT:38字符>    ← 我自己的测试字符串
--- _recon/verify-apikey-covers-tts.mjs   L72:  tts('apiKey', 'seed-icl-2.0', <HIT:38字符>, {  ← 本地变量
--- _recon/verify-cred-e2e.mjs            L54:  env: { <HIT:28字符>' }             ← 空字符串字面量
```

⇒ **未见真实密钥**。
另有一批直接读写真实凭据的临时脚本（`_recon/diag-env-fallback.mjs`、`validate-credentials.mjs`、`verify-cred-e2e.mjs`、`_recon/inspect-cred-structure.py`、`commit-msg*.txt`），它们**没有硬编码密钥**，但属于"以后可能被塞进密钥"的高风险位置 → P3-4。

### 2.3 凭据文件本体：未被 git 跟踪，但 ACL 过宽

```powershell
存在=True 大小=711 修改时间=10/11/2026 01:36:59
是否被该 git 仓库跟踪:（空 = 未跟踪）
Owner=<主机名>\1121
  NT AUTHORITY\SYSTEM Allow FullControl
  BUILTIN\Administrators Allow FullControl
  <主机名>\1121 Allow FullControl
```

**未读取文件内容**（遵守任务约束）。仓库根 `<工作区>\.gitignore` 实测覆盖：

```powershell
> git status --porcelain --ignored
!! _backup/
!! _recon/
```

⇒ 未被跟踪且被显式忽略，不会误提交。但 ACL 给了 `SYSTEM` 与 `Administrators` 完全控制 → P3-3（本机任何以这两个身份运行的进程都能读到明文密钥；标准 Windows 用户态无法更细，属加固项）。

---

## 3. 发现清单（P3 加固项）

### P3-1 `ark_credential_status` 掩码在短凭据上退化为完整回显

- **级别**：P3（潜在密钥泄露 / 掩码缺陷）
- **位置**：`lib/index.js:684`
- **复现**：`node <工作区>\_recon\verify\audit-a3-credential-status.mjs`
- **实际输出**：
  ```
  边界(2)  → - ARK_API_KEY（图像 / 视频）：环境变量 MN…MN（2 字符）
  边界(1)  → - ARK_API_KEY（图像 / 视频）：环境变量 O…O（1 字符）
  ** 发现 ** 边界(2) 不得回显完整密钥  完整值出现在输出中
  ** 发现 ** 边界(1) 不得回显完整密钥  完整值出现在输出中
  ```
- **影响**：长度 ≤ 2 时完整回显；长度 3 时泄露 2/3 字符。真实火山密钥长度远超 4，**当前不可利用**；但该工具的输出会进入会话记录（DSH 会话日志导出），一旦有人用短 token（自建网关、测试 Key、短口令）就会把密钥写进可被分享的日志。
- **建议修法**：
  ```js
  const masked = value
    ? (value.length <= 8
        ? `${'*'.repeat(value.length)}（${value.length} 字符）`       // 短值全掩
        : `${value.slice(0, 3)}…${value.slice(-3)}（${value.length} 字符）`)
    : '—'
  ```
  原则：**永不回显超过 1/3 的字符**，且长度 ≤ 8 时完全不回显。

### P3-2 `ArkError.cause` 可携带含请求头的底层错误对象（日志脆弱点）

- **级别**：P3（设计脆弱点，**当前无泄露路径**）
- **位置**：`lib/http.mjs:115-119`（`cause: err`）、`lib/http.mjs:106/112`、`lib/errors.mjs:42`
- **复现**：`audit-a1-secret-in-errors.mjs` 第 4 节（注入一个"把 init.headers 挂到错误上"的 `fetchImpl`）
- **实际输出**：
  ```
  错误对象图（含 cause）含密钥 = true   ← http.mjs:118 把整个 err 挂到 cause
  ArkError.message        含密钥 = false
  toSummary()（工具层展示） 含密钥 = false
  JSON.stringify(err)      含密钥 = false
  ```
  另实测：`util.inspect(new ArkError(..., {cause: new Error(密钥)}))` **会把 cause 一并打印**。
- **影响**：今天**不泄露**（全仓无 `console.*`/`logger.*`；工具层只输出 `toSummary()`；`cause` 不可枚举故不被 `JSON.stringify`）。但若将来有人加一行 `logger.error(err)` 或自己做会话日志导出，密钥会随 `cause` 落盘。
- **建议修法**：给 `ArkError` 加显式 `toJSON()`，只导出 `{name, code, httpStatus, requestId, retryable, provider, message}`；并在 `errors.mjs` 顶部写明"**禁止把 ArkError 整体交给 logger，只能交给 `toSummary()`**"。这不是 bug，是防回归的护栏。

### P3-3 凭据文件 ACL 过宽

- **级别**：P3（加固）
- **位置**：`<用户目录>\.dsh\.credentials.yaml`（**未读取内容**）
- **复现**：`Get-Acl`（见 §2.3 输出）
- **影响**：`NT AUTHORITY\SYSTEM` 与 `BUILTIN\Administrators` 具备 FullControl。属 Windows 默认继承行为，但在"密钥明文落盘"的前提下，收紧为仅当前用户可读更稳妥。
- **建议修法**：
  ```powershell
  icacls "$env:USERPROFILE\.dsh\.credentials.yaml" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
  ```
  （需管理员；且要先确认 DSH 自身以何身份读取该文件，避免收紧后读不到。）

### P3-4 `_recon/` 下留有一批"直接读写真实凭据"的临时脚本

- **级别**：P3（供应链/卫生）
- **位置**：`_recon/diag-env-fallback.mjs`、`_recon/validate-credentials.mjs`、`_recon/verify-cred-e2e.mjs`、`_recon/verify-apikey-covers-tts.mjs`、`_recon/inspect-cred-structure.py`、`_recon/probe-audio-generation.mjs`、`_recon/commit-msg*.txt`
- **实测**：本次扫描**未见硬编码真实密钥**（§2.2）；这些脚本多数从环境变量/凭据服务取值。
- **影响**：它们目前被根 `.gitignore` 的 `_recon/` 覆盖（实测 `!! _recon/`），不会误提交。但文件名与用途均为"凭据验证"，是最容易被后人塞进真实密钥再 `git add -f` 的位置。
- **建议修法**：交付前把其中确实不再需要的删除或归档到仓库外；保留的脚本统一加"禁止硬编码密钥，只从 `process.env` 读"的文件头注释。

---

## 4. 我试图推翻但**没能推翻**的点（实际试过的攻击向量）

> 这一节是本次审计的主要产出：**每个向量都实际跑了**，附结果。

### 4.1 密钥泄露向量（15 项，全部未能推翻）

| # | 攻击向量 | 结果 |
|---|---|---|
| 1 | 真实 undici 网络失败（未监听端口 127.0.0.1:1） | 密钥未出现在 error graph / message / stack / cause |
| 2 | 真实 TLS 握手失败（https 到未监听端口） | 同上 |
| 3 | fetchImpl 抛异常且**自带 `init.headers`**（最坏情况） | `message`/`toSummary`/`JSON.stringify` 均不含密钥；仅 `cause` 图内含 |
| 4 | 上游 200 但响应体是非 JSON 文本 | `message` 只含响应体前 300 字符，不含请求头 |
| 5 | 上游 401 / 500 / 429 空体 | 不含密钥 |
| 6 | 429 退避重试期间取消 | 不含密钥 |
| 7 | `generateImage` 真实失败 | 不含密钥 |
| 8 | `createVideoTask` 真实失败 | 不含密钥 |
| 9 | `synthesizeSpeech`（`X-Api-Key` 链路）真实失败 | 不含密钥 |
| 10 | `ArkError.toSummary()` | 实测输出 `"X — msg"`，不回显 cause |
| 11 | `JSON.stringify(ArkError, getOwnPropertyNames)` | 不含密钥（cause 不可枚举） |
| 12 | 上游错误体里塞 `message: "…Bearer …"` | 只被当文本回显上游自己的内容，不含本地密钥 |
| 13 | 产物文件名（hint 来自 prompt） | 见 §4.4，被 slugify 清洗 |
| 14 | `previewUrl` | 只有 uuid，见 §4.3 |
| 15 | 全仓 `console.*` / `logger.*` 搜索 | **零匹配**（无日志面） |

**未能推翻的结论**：`lib/http.mjs` / `lib/errors.mjs` 的异常传播路径**不会**把 `Authorization: Bearer …` 或 `X-Api-Key: …` 带进 `ArkError.message` / 工具返回值。

### 4.2 本地文件越界读（隐私，72 项，全部未能推翻）

脚本 `audit-a2-path-escape.mjs`，三处本地读取入口 × 14 个向量：

- 入口：`ark-image.toReferenceUrl`（`referenceImages`）、`ark-video.localFileToDataUrl`（`firstFrame`/`lastFrame`/`referenceImages`）、`volc-asr.resolveAudioFile`（`audioPath`）
- 向量：junction（→界外目录、→`C:\Windows`）、`..` 与深层 `..`、绝对路径（正/反斜杠）、`C:` 相对形式、`C:/PROGRA~1` 8.3 短名、`\\.\` 设备前缀、`\\?\` 长路径、UNC（`\\localhost\E$\...`）、`..%2f` 编码、`NUL`、尾随点目录

```
junction 创建情况: {"junc":true,"mnt":true}
=== A. ark-image.generateImage(referenceImages) ===  14/14 PASS
=== B. ark-video (firstFrame / lastFrame / referenceImages) ===  42/42 PASS
=== C. volc-asr.resolveAudioFile(audioPath) ===  14/14 PASS
=== D. 参考视频/音频默认不得内联本地文件 ===  2/2 PASS
```

**每一条都实测到"界外内容未进入请求体"**（捕获真实请求体后搜索哨兵串）。`volc-asr` 还额外断言解析出的**真实路径**仍在工作区内。

> 说明：第 73 项「工作区内文件不被误拒」在我第一版脚本里报 FAIL，原因是我的桩返回 `data: []` 导致模块抛 `BAD_RESPONSE`（**harness 问题**，不是逃逸）；工作区内文件在 §4.3 的真实路由测试中正常读取。

### 4.3 预览路由 `/dsh-ark/asset` 的访问控制（27 项，全部未能推翻）

脚本 `audit-a7-preview-route.mjs`，真实工作区插件 + 真实注册路由 + 真实产物：

```
=== 1. 非本机 Host 一律拒绝（DNS 重绑定）===
  PASS  Host=evil.com → 403          PASS  Host=ark.cn-beijing.volces.com → 403
  PASS  Host=127.0.0.1.evil.com → 403 PASS  Host=0.0.0.0 → 403
  PASS  Host=localhost.evil.com → 403
=== 2. 跨站 / 不可验证 Origin ===
  PASS  cross-site → 403   PASS  Origin: evil → 403   PASS  Origin: null → 403
  PASS  Origin: file:// → 403   PASS  Origin 端口不同 → 403
=== 3. 本机正常请求（功能未被修坏）===
  PASS  Host=127.0.0.1 + 无 Origin → 200 且返回 PNG
  PASS  同源 Origin → 200
=== 4. 伪造 id（12 种）===
  PASS  ../../../../Windows/win.ini / ..%2f..%2foutside-secret.txt / 绝对路径
  PASS  constructor / __proto__ / toString / hasOwnProperty / valueOf / '' / null / undefined
  PASS  <真实id>/../../outside-secret.txt
=== 5. 产物是否泄露绝对路径/请求头 ===
  PASS  工具返回文本不含绝对路径
  PASS  工具返回文本不含请求头/凭据字样
  PASS  产物文件名不含绝对路径
```

⇒ **未能推翻**："伪造 id 读工作区外文件"、"跨站读产物"、"DNS 重绑定读产物"。

### 4.4 注入 / 穿越 / 原型污染 / ReDoS / 整数溢出（36 项，全部未能推翻）

脚本 `audit-a6-web-vectors.mjs`：

- **命令注入**：全仓搜索 `child_process` / `exec` / `spawn` / `eval(` / `new Function` → **零匹配**（`lib/` 内没有任何命令执行面）。
- **文件名穿越**：`slugify` 对 `../../etc/passwd` → `"etc-passwd"`、`..\..\windows\system32` → `"windows-system32"`、`a/b/c` → `"a-b-c"`、`C:evil` → `"C-evil"`、`\u0000` 被剔除、`..`/`.`/`...` → `"asset"`；14/14 不含路径分隔符。真实落盘 5 组恶意 hint 全部落在 cwd 内：
  ```
  实际文件名: 20261010181601-evil-afa3bfd2.png | ...-evil-4760bd67.png | ...-a-b-f722ad06.png | ...-asset-9516a724.png | ...-xxxxxxxx...-c7e1a96c.png
  ```
- **原型污染**：`JSON.parse` 三种 `__proto__`/`constructor.prototype` 载荷 + 走真实 `generateImage` 处理带 `__proto__` 的上游响应 → `Object.prototype` 未被污染（4/4）。
- **整数溢出/异常输入**：`resolveSize` 对 `999999999x999999999`、400 位数字串、负数、0、`Infinity`、`NaN`、`1e308:1`、`NaN:1`、`0:1`、`-1:1` → **10/10 抛 `INVALID_PARAMETER`**，无有限值溢出。
- **ReDoS**：对 `resolveSize` / `parseTtsStream` / `slugify` 各喂 5 组超长输入（20 万字符、10 万字符、5 万次重复、10 万大括号、50 万字符 base64）→ 总耗时 **1ms / 4ms / 4ms**，无灾难性回溯。
- **SSRF**：`ark-image` / `ark-video` / `volc-audio` 对 `http(s) URL` 一律**原样透传**给上游（不代抓、不下载），产物下载只走**上游响应里给出的 URL**；未发现"用户可控 URL → 服务端主动请求"的路径。注意这是**设计取向**（把抓取交给方舟），不是漏洞 → §7 未覆盖项。

### 4.5 虚假"发现"的自我纠正（避免误读）

审计过程中我有 **3 处误报**，均已定位为**我的 harness/判据问题**，不计入发现：

1. A1 初版 `check()` 的泄漏标签写反，把 `false`（未泄露）标成"泄露"；修正后 A1 = **15 pass / 0 泄露**。
2. A2 第 73 项「工作区内文件不被误拒」FAIL —— 我的桩返回 `data: []`，模块正当抛 `BAD_RESPONSE`。
3. A5 首轮把 8 处命中报为"疑似真实密钥"，逐条脱敏判定后**全部为占位符 / 空字符串字面量 / 我自己的哨兵 / speaker id**。

---

## 5. 修复优先级建议

| 优先级 | 项 | 动作 |
|---|---|---|
| 1 | P3-1 掩码退化 | `lib/index.js:684` 改为「长度 ≤ 8 全掩；否则首尾各 3」 |
| 2 | P3-2 cause 脆弱点 | 给 `ArkError` 加 `toJSON()`；注释里明令"不许把 err 整体交给 logger" |
| 3 | P3-4 `_recon` 卫生 | 交付前清理/归档直接操作凭据的临时脚本 |
| 4 | P3-3 凭据 ACL | 可选：`icacls /inheritance:r`（需先确认 DSH 读取身份） |

---

## 6. 「是否发现密钥泄露」——最终结论

**没有发现真实密钥泄露。**

依据（全部为实测）：
1. **16 处失败注入 × 深度序列化搜索**：密钥未出现在 `ArkError.message` / `toSummary()` / `stack` / `cause`（真实库异常）/ 返回值。
2. **真实 undici 异常不含请求头**：这是我花最大力气想推翻的一条，实际挖到 `TypeError("fetch failed") → Error("bad port")` 为止，**没有 URL / method / headers**。
3. **全仓零日志调用**（`console.*` + `logger.*` 搜索零匹配）⇒ 不存在"错误对象被日志整体打印"的路径。
4. **`JSON.stringify(ArkError)` 不含密钥**（`cause` 不可枚举）。
5. **git 全历史 + `_recon` + `_backup` 无真实密钥**（唯一的 `ark-` 命中是 pip URL，逐条脱敏判定）。
6. **凭据文件未被 git 跟踪且被 `.gitignore` 显式忽略**（`!! _recon/`、`!! _backup/`）。
7. **客户端半侧无 console / 无埋点 / 无远端上报**，草稿只进密码控件 prop。

唯一与"密钥"相关的缺陷是 **P3-1 掩码退化**（短凭据场景），它不是"已发生的泄露"，而是"掩码逻辑不稳健"。

---

## 7. 未覆盖的范围（诚实声明）

1. **未发起任何真实计费 API 调用**（遵守任务约束）：未跑 `scripts/smoke.mjs` 的 `--image/--tts/--audio/--asr`，未使用真实密钥打线上。所有"失败"均为本机未监听端口 / 注入桩 / 自签名握手，零外网请求。
2. **未读取凭据文件内容**（遵守任务约束），因此**无法验证**：凭据文件里的值是否真的是密钥形态、DSH 凭据服务是否可能把它回显到别处。
3. **`primitives.SettingsSecretField` 的 DOM 实现**：该原语由 DSH 宿主提供（本仓库外），我**没有**验证它是否渲染为 `type=password`、是否会写进 `data-*` 属性。未使用 Client Inspect Provider 检查实时 Slot 树。
4. **真实浏览器行为**：未在真实 GUI 里验证跨站 `fetch` 是否真被 `Origin` 判据拦住（按规范行为推导 + 单元级实测）。
5. **SSRF**：未构造"让方舟侧抓内网地址"的验证（需要真实调用，且属上游行为，本插件只是透传 URL）。
6. **供应链**：未审计 `docs/ark-cli-skills/**`（约 1.2MB 第三方 markdown）内容是否含示例密钥的**真实**值 —— 只做了形态扫描（§2.1），未逐文件人工阅读。
7. **并发/时序**：未做 TOCTOU 之外的竞态测试（`registry` 淘汰与读取的竞态、`credentials` 描述与保存的竞态）。
8. **`_recon/out/` 下从 DSH 宿主解包出的第三方 JS**（`cred-local.js` 33KB 等）：仅作为形态扫描对象，未做逻辑审计。
