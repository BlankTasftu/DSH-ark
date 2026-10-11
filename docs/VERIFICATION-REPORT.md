# dsh-ark 独立验证报告

> 验证者：teammate `verifier`（独立于实现者）
> 验证时间：2026-10-10 23:50 – 2026-10-11 00:10 (Asia/Shanghai)
> 被测版本：`<工作区>\dsh-ark`（无 git 仓库，故以文件内容与时间戳为准）
> 验证脚本：`<工作区>\_recon\verify\`（v1–v11，全部只读被测代码；**未修改任何 `lib/**`、`tests/**`、`package.json`、`cordis.patch.yml`**）
> 本报告为本次验证唯一新增到 `dsh-ark` 内的文件。

---

## 0. 结论摘要

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 0 | 未发现可导致错误计费、数据损坏或安全失守的 P0 |
| P1 | 1 | 路径逃逸（junction/符号链接）——**已由 Lead 修复，本轮复验通过 + 变异测试确认测试有效** |
| P2 | 11 | 功能/契约/文档不一致与健壮性瑕疵，均未修复 |

**计费安全（最高优先级）结论：未能推翻。** 视频模块在任何故障模式下「一个 taskId 只对应一次提交 POST」成立；图片/语音/理解的参数类错误（400）均不重试。

**最重要的两条 P2**（建议优先处理）：
1. `lib/artifacts.mjs:228` 生成的预览地址 `/dsh-ark/asset/<id>` 与 `lib/index.js:34` 注册的 exact 路由 `/dsh-ark/asset`（query 传 id）**形态不一致** → 工具回传给模型的预览地址在真实 DSH GUI 里不可达（P2-4）。
2. `ark_generate_video` 的 `action="status"` 在任务 `succeeded` 时**不下载产物**，只回传 24h 失效直链，与契约 §1.2「拿到即下载落盘」相悖（P2-6）。

---

## 1. 基线确认

```
<工作区>\dsh-ark> node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"
ℹ tests 123
ℹ suites 0
ℹ pass 123
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 527.9371
```

节点版本 `v24.20.0`。**基线成立：123/123 通过，0 失败 0 跳过。**

> 注意：任务书给出的基线是 119 个测试；中途 Lead 修复路径逃逸后新增 `tests/path-escape.test.mjs`（4 个用例），基线更新为 123。本报告中的其余结论均基于 123 版本复验。

---

## 2. P1：本地素材路径逃逸（已修复，本轮复验通过）

### 2.1 原始缺陷（**实测复现，非推断**）

- **位置**：`lib/ark-understand.mjs` 的 `toMaterialUrl`、`lib/ark-video.mjs` 的 `localFileToDataUrl`
- **性质**：只做 `path.resolve` + `path.relative` 的**词法**包含判定，未做 `fs.realpath`。工作区内的 junction / 符号链接字面上在 cwd 内、实际指向界外，于是界外文件被 base64 后进入发往方舟的请求体。
- **违反**：`docs/ARK-API-CONTRACT.md` §3.5「上传素材路径限定在 cwd 内：读本地参考图时拒绝逃逸路径」。
- **对照**：同一仓库的 `lib/ark-image.mjs:479-498` 与 `lib/volc-asr.mjs:80-99` 都做了 realpath，对同一向量**正确拒绝** → 属模块间实现不一致，而非有意取舍。

**复现命令**（`_recon/verify/v2-path-escape.mjs`，修复前输出）：

```
cmd /c mklink /J <workspace>\junc <workspace 外目录>      # 无需管理员，实测成功

[ark-understand] junction 相对路径 junc/secret.png
    => *** 逃逸成功：工作区外文件内容已进入请求体 ***
[ark-video(firstFrame)] junc/secret.png
    => *** 逃逸成功：工作区外文件已 base64 进请求体 ***
[ark-image(referenceImages)] junc/secret.png
    => 被拒绝: INVALID_PARAMETER
[volc-asr.resolveAudioFile] junc/secret.png
    => 被拒绝: INVALID_PARAMETER
```

### 2.2 修复后复验（**实测**）

同一脚本（修复后）：

```
[ark-understand] junction 相对路径     => 被拒绝: INVALID_PARAMETER
[ark-video(firstFrame)] junc/secret.png => 被拒绝: INVALID_PARAMETER
[ark-image(referenceImages)] junc/secret.png => 被拒绝: INVALID_PARAMETER
[volc-asr.resolveAudioFile] junc/secret.png  => 被拒绝: INVALID_PARAMETER
```

`ark-understand` 与 `ark-video` 的 junction 向量现在**均被拒绝，且未发出任何请求**（`fetch` 调用数 = 0）。

### 2.3 变异测试：确认 Lead 新增的回归测试不是「假绿」（**实测**）

Lead 新增 `tests/path-escape.test.mjs`（4 用例，全绿）。但「全绿」本身不能证明用例有效，因此做了变异测试（`_recon/verify/v11-mutation-test.mjs`）：把 `lib/ark-understand.mjs` 复制到临时目录，**忠实还原修复前的写法**（第二层 realpath 判定替换为 `const real = abs`），再让 junction 向量打在这个变异体上。

```
变异是否生效（删除了 realpath 第二层判定）: true
变异后仍含 fs.realpath(abs): false
junction 创建: true
变异体行为：请求数=1 外泄=true
>>> 变异体确实恢复了漏洞（界外内容进入请求体）
```

原用例断言「必须抛 `INVALID_PARAMETER` 且 `fetch` 调用数为 0」，在变异体上必然失败 ⇒ **用例确实能捕获该回归，不是假绿。**

同时确认用例是**真跑**而非跳过：

```
> node --import ./tests/stub-dsh-loader.mjs --test --test-reporter=spec "tests/path-escape.test.mjs"
✔ ark_understand：工作区内符号链接指向界外时，拒绝读取（不得外泄内容） (11.3114ms)
✔ ark_generate_video：工作区内符号链接指向界外时，拒绝读取参考素材 (5.5956ms)
✔ 字面越界的相对路径仍归类为 INVALID_PARAMETER，且不泄漏界外路径是否存在 (2.5377ms)
✔ 回归：工作区内名为 "..foo.png" 的合法文件不得被误判为路径逃逸 (28.8099ms)
ℹ tests 4 / pass 4 / fail 0 / skipped 0
```

`skipped 0` ⇒ junction 用例在本机**真的执行了**（`fs.symlink(..., 'junction')` 在 Windows 上不需要管理员权限）。

### 2.4 Lead 点名的进阶向量复验（**实测**，`_recon/verify/v6b-advanced.mjs`）

| 向量 | 构造 | 结果 |
|---|---|---|
| 目录联接 → `C:\Windows` | `mklink /J ws\mnt C:\Windows`，读 `mnt/win.ini` | ✅ understand / video 均 `INVALID_PARAMETER`，无请求 |
| 目录联接 → 界外目录 | `mklink /J ws\ro <outside>` | ✅ 均拒绝 |
| 嵌套联接 | `ws\deep\inner → <outside>` | ✅ 均拒绝 |
| 只读目标 | 对界外目录 `attrib +R` 后重试 | ✅ 仍拒绝（判定不依赖目标可写性） |
| `..` 相对路径 | `../outside/secret.png` | ✅ 拒绝 |
| 绝对路径 | `C:/PROGRA~1/Windows/win.ini` | ✅ 拒绝 |
| 8.3 短名 + 相对跳转 | `C:/PROGRA~1/../Windows/win.ini` | ✅ 拒绝 |
| 设备前缀 | `\\.\E:\...`、`\\?\E:\...`、`//?/E:/...` | ✅ 均拒绝 |
| UNC 长路径 | `\\.\UNC\localhost\E$\...` | ✅ 拒绝 |
| DOS 设备名 | `CON` / `NUL` / `AUX` / `COM1` / `LPT1` | ✅ `FILE`（不存在），无请求 |

**TOCTOU（realpath 之后目标被替换）**：按 Lead 要求专门构造了竞态 —— 工作线程在「界内 / 界外」之间反复重建联接，主线程并发发起 600 次读取（`_recon/verify/v6b-advanced.mjs` 第 D 节）：

```
尝试 600 次 / 360ms，联接切换 10 次
发出请求=145 被拒(INVALID_PARAMETER)=96 其它错误=359 **泄漏=0**
结论：未复现 TOCTOU 泄漏
```

**诚实标注**：这是「**未能构造出**」，不等于「证明不存在」。分析上，`fs.realpath()` 返回的是**已解析的规范路径**（其自身不含 reparse point），因此把联接换向并不会改变 `real` 字符串指向的位置 —— 要利用必须在 realpath 之后、readFile 之前替换 `real` 所指向的**真实**目录，攻击者通常无法预先放置那样的目录。因此我判断 TOCTOU **不可实用化**，但没有构造出确定性证明，故保留为纵深防御建议而非缺陷。

---

## 3. P2 发现清单（均未修复）

### P2-1 `ark-understand` 曾误判 `..` 开头的合法文件名（已修复，复验通过）

- **位置**：`lib/ark-understand.mjs:47`（修复前为 `if (rel.startsWith('..') || path.isAbsolute(rel))`）
- **性质**：`rel.startsWith('..')` 会把工作区内合法文件名 `..foo.png`、目录 `..weird/`、`..../` 一律判为逃逸。同仓库 `lib/ark-image.mjs` 的 `isInside` 用 `rel.split(sep)[0] !== '..'`，是正确的 —— 又一处模块间不一致。
- **实测（修复前）**：
  ```
  path.relative(ws, ws/..foo.png) = "..foo.png"
    → .startsWith("..") = true   （ark-understand 判为逃逸）
    → .split(sep)[0] === ".." = false（ark-image 判为区内）
  [ark-understand] ..foo.png  => ** 被拒绝: INVALID_PARAMETER **（工作区内合法文件被误判）
  ```
- **实测（修复后）**：`..foo.png` / `..weird/x.png` / `..../x.png` 全部 **接受（正确）**。
- **状态**：✅ 已修复，已纳入 Lead 的回归用例。

### P2-2 `previewUrl` 与预览路由形态不一致 → 预览地址在真实 GUI 里不可达

- **位置**：`lib/artifacts.mjs:190,228` 对 `lib/index.js:34,410-411,419-420`
- **证据（两侧均为直接引文）**：
  - `artifacts.mjs:190`：`constructor({ cwd, dir = 'ark-output', previewBase = '/dsh-ark/asset' })`
  - `artifacts.mjs:228`：`previewUrl: \`${this.previewBase}/${id}\`` → `/dsh-ark/asset/<uuid>`
  - `index.js:34`：`const ASSET_ROUTE = '/dsh-ark/asset'`，`index.js:410` 以 `kind: 'exact'` 注册，`index.js:419-420` 从 **query** 取 id：`url.searchParams.get('id')`
  - 两个既有单测把错误形态**固化**了：`tests/core.test.mjs:165` 与 `tests/ark-image.test.mjs:322` 均断言 `previewUrl === '/dsh-ark/asset/<id>'`
- **DSH 侧路由语义（读源码确证）**：`app.asar` 内 `webServer` 的注册表实现为
  ```js
  register(route) {
    const table = route.kind === "exact" ? this.exact : this.prefixes;
    ...
  }
  match(pathname) {
    const exact = this.exact.get(pathname);
    if (exact !== void 0) return exact;
    ...
  }
  ```
  exact 表按 **pathname** 精确查表 ⇒ `/dsh-ark/asset/<uuid>` ≠ `/dsh-ark/asset`，**不会命中**，落到 fallback owner。
- **实测（`_recon/verify/v7c-asset-route.mjs`，逐行复刻 `lib/index.js:34/37-75/109-124/406-450`）**：
  ```
  回传 URL        = /dsh-ark/asset/<uuid>
  其 pathname     = /dsh-ark/asset/<uuid>
  路由 exact key  = /dsh-ark/asset
  ** FAIL ** 回传 URL 的 pathname 能命中 exact 路由
  PASS  换成路由真正接受的 ?id= 形态 → 200 且字节一致
  PASS  Content-Type = image/png
  ```
- **影响**：`ark_generate_image` 与 `ark_speak` 回传给模型的「预览地址（仅本机可访问）」在 GUI 中 404 / 返回 HTML 外壳。路由本身工作正常（`?id=` 形态 200 且字节一致），只有**回传给用户的 URL 是坏的**。
- **测试盲区**：`tests/plugin.test.mjs:119-161` 用 `?id=x` 直接调 handler（只验路由自身），另两个单测只验 `previewUrl` 字符串形状。两者各自「绿」，组合起来不可达 —— **没有任何一条测试覆盖「工具产出的 URL 能否被路由命中」**。
- **建议**：`previewBase` 与路由形态二选一统一。最小改动是让 `ArtifactStore` 产出 `${previewBase}?id=${id}`；或把路由改为 `kind: 'prefix'`（DSH 的 prefix 匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`）并在 handler 内解析尾段 id。

### P2-3 429 退避期间取消：抛 `DOMException` 而非 `ArkError(ABORTED)`，违反模块契约

- **位置**：`lib/http.mjs:137` 的 `await sleep(retryBackoffMs * attempt, callerSignal)`；`sleep` 在 `http.mjs:43-53` 只把取消 reason 原样 reject，**没有经过 `requestJson` 的 catch 归一化**（那个 catch 只覆盖 `fetchImpl(...)` 那一句）。
- **契约**：`docs/MODULE-INTERFACES.md:38-39`「取消要求（硬性）：每个导出的异步函数都必须把 `opts.signal` 透传给 `lib/http.mjs`，并在收到取消时抛 `ArkError(ABORTED)`」。
- **实测（`_recon/verify/v9-cancel-during-backoff.mjs`）**：
  ```
  === 场景：429 退避等待期间调用方 cancel ===
     instanceof ArkError : false
     constructor.name    : DOMException
     e.name              : AbortError
     e.code              : 20                 ← 数字 20，不是字符串 'ABORTED'
     e.message           : "This operation was aborted"
     符合"抛 ArkError(ABORTED)"契约 : *** NO ***
     提交 POST 次数 : 1

  === 对照：取消发生在 fetch 进行中（走另一条路径）===
     instanceof ArkError : true  code = "ABORTED"  name = ArkError
  ```
- **影响面（已评估，非夸大）**：
  - **不影响工具调用方**：`lib/index.js:139` 的 `failureText` 会调 `toArkError(err)`，而 `errors.mjs:63` 对 `name === 'AbortError'` 会归一成 `ABORTED` ⇒ 模型看到的仍然是 `ABORTED`。
  - **影响直接用 lib 的调用方**（`docs/MODULE-INTERFACES.md` 明确把这些模块定义为可独立使用的模块接口）：拿到的 `e.code` 是数字 `20`，按契约用 `err.code === 'ABORTED'` 判断会漏判。
  - **不产生重复提交**：实测提交次数仍为 1。
- **建议**：`sleep` 抛 `ArkError(ABORTED)`，或在重试分支外包一层 `try/catch` 走 `toArkError`。

### P2-4 `ark_generate_video action="status"` 在 `succeeded` 时不下载产物

- **位置**：`lib/index.js:361-369`
  ```js
  if (action === 'status') {
    if (!args.taskId) return textBlock('[ark_generate_video] action=status 需要提供 taskId。')
    const seen = await getVideoTask({ config: cfg, creds, taskId: args.taskId, cwd }, { signal: exec.signal })
    return textBlock(renderVideoStatus({ ...seen, timedOut: false, videos: [] }))
  }
  ```
  `videos: []` 被硬编码为空；`getVideoTask`（`ark-video.mjs:432-455`）只做 GET + 解析，不下载、不落盘。
- **违反**：契约 §1.2「`output_url` 是 TOS 预签名 URL，24 小时后失效 ⇒ 拿到即下载落盘，不要只回传 URL」；`ark-video.mjs:16-17` 的模块注释也把这条写成设计要求。
- **影响**：模型按工具自身指引（`index.js:380`：「用 `ark_generate_video({ action: "status", taskId })` 查询进度」）查到 `succeeded` 时，`renderVideoStatus`（`index.js:463-470`）走 `status !== 'succeeded'` 那支之前的分支……实际进入 `result.status !== 'succeeded'` 判断为 false，于是走 `result.videos.map(...)`，而 `videos` 是空数组 ⇒ **返回「视频已生成并下载到工作区」但列表为空**，既没有文件也没有可用的直链。
- **补充**：`action=status` 也没有 `wait` 语义，无法「查到成功就补下载」；用户只能重新用 `submit + wait`，但那会**新建一个计费任务**（工具描述已警告不要重复提交）⇒ 这是一个会把用户推向重复计费的行为缺口。
- **建议**：`action=status` 命中 `succeeded` 时走 `saveOutputs` 落盘（或在 status 结果里带上 `outputUrls` 并明确提示用 `wait` 补下载）；`renderVideoStatus` 对空 `videos` 应给出明确文案而不是「已下载到工作区：」+ 空列表。

### P2-5 `ark_transcribe` 的工具描述读起来像可用功能，实际永远返回 `NOT_IMPLEMENTED`

- **位置**：`lib/index.js:296-305`（工具注册）对 `lib/volc-asr.mjs:178-193`（`transcribe` 无条件抛 `NOT_IMPLEMENTED`）
- **实测输出**（`_recon/verify/v10-docs-vs-code.mjs`）：
  ```
  ark_transcribe 的工具描述片段：
    '把音频文件转写成文字（语音识别），可选标点。按音频时长计费。' + '音频路径必须在工作区内。'
  ** 不一致 ** 工具描述如实说明 ASR 未实现
  ```
- **对比**：`docs/ARK-API-CONTRACT.md` §2.2 与 `docs/MODULE-INTERFACES.md:172-176` **都已如实标注未实现** —— 文档是诚实的，**只有工具描述没有**。
- **影响**：模型会为一个必然失败的功能反复调用（描述里写着「按音频时长计费」，会让人以为只是要花钱）。
- **建议**：在 `ark_transcribe` 的 description 里直接写明「当前未实现（ASR 协议未经真实凭据实测，返回 `NOT_IMPLEMENTED`，不会发起网络请求、不产生费用）」。

### P2-6 `ark_generate_video` 的工具参数远窄于模块能力，多个已实现能力不可达

- **位置**：`lib/index.js:337-351`（工具 schema）对 `lib/ark-video.mjs:177-237`（`buildContentArray` / `buildRequestBody`）
- **实测（`_recon/verify/v10-docs-vs-code.mjs`）**：
  ```
  ark_generate_video 暴露的参数: prompt, action, taskId, wait, resolution, ratio, duration, firstFrame, watermark, generateAudio
  ** 不一致 ** 暴露 frames 参数（模块支持且与 duration 互斥）
  ** 不一致 ** 工具暴露 lastFrame / referenceImages / referenceVideo / referenceAudio / cameraFixed / allowLocalVideoAudio / frames
  ```
- **具体不可达能力**（模块全部已实现且有单测）：`lastFrame`（尾帧）、`referenceImages`（参考图）、`referenceVideo` / `referenceAudio`（参考视频/音频）、`cameraFixed`、`allowLocalVideoAudio`、`frames`（帧数，与 `duration` 互斥且契约 §1.2 明确其语义）。
- **附带**：`prompt` 是 `required: true`，而 `action="status"` 查询**不需要** prompt ⇒ 模型做纯查询时也被迫编造一段提示词；且 `cameraFixed` 的默认值是模块刻意「未传则不发送」的语义，工具层不暴露就无法表达。
- **另**：`count` 无上限（契约 §1.1 说上限未公布，故代码「如实透传」符合契约），实测 `count=100000` 会原样发出 `max_images: 100000` ⇒ 工具描述缺少成本告警（`ark_generate_image` 描述只说「按张计费」，没说「count 很大时费用线性增长」）。

### P2-7 预览路由的信任校验可被非常规 `Host` 值绕过；`Origin: null` 直接放行

- **位置**：`lib/index.js:37-47`（`isLoopbackRequest`）与 `:54-75`（`assetRequestRejected`）
- **实测（`_recon/verify/v7c-asset-route.mjs`）**：
  ```
  PASS  缺 Host → 403
  PASS  Host=evil.com → 403
  PASS  Host=127.0.0.1.evil.com → 403
  PASS  Host=localhost.evil.com → 403
  PASS  Host=127.0.0.1@evil.com → 403
  PASS  Host=[::ffff:127.0.0.1] → 403
  PASS  Host=127.0.0.1:99999 → 403
  PASS  Host=127.0.0.1 + cross-site → 403
  PASS  Host + Origin=evil → 403
  ** FAIL ** Host=2130706433（十进制回环） → 期望 403，实际 200 且返回了 PNG 字节
  ** FAIL ** Host=127.0.0.1#evil.com     → 期望 403，实际 200 且返回了 PNG 字节
  ```
- **判定逻辑为何被绕过**：`isLoopbackRequest` 用 `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` 直接匹配 `new URL('http://' + host).hostname`。
  - `new URL('http://127.0.0.1#evil.com').hostname` → `127.0.0.1`（`#` 起被当 fragment 丢掉）⇒ 正则命中 ⇒ 判为本机。
  - `2130706433` 是回环地址的十进制整数写法，多数栈（含 Chrome）会归一成 `127.0.0.1`；本插件的校验**不**归一，因此按「非回环」拒绝 —— 这是**误拒**方向，安全上无害，但说明 hostname 归一化缺失。
  - `Origin: null`（沙箱化 iframe / 本地 `file:` 页）在 `index.js:59` 被显式跳过（`origin !== 'null'`）⇒ Origin 判据失效，只剩 Host 判据。
- **影响评估（不夸大）**：
  - **不构成任意文件读**：路由只从 `registry` 查 id（`index.js:421-427`），实测 13 种伪造 id（含 `../../../etc/passwd`、`%2e%2e%2f...`、绝对路径、`constructor`、`__proto__`、`toString`、`hasOwnProperty`）**全部 404、无泄漏**；`registry` 是 `Map`，无原型链污染面。
  - **不构成非本机访问**：`Host` 校验挡得住 DNS 重绑定（`Host=evil.com` / `127.0.0.1.evil.com` 均 403），也不防本机任意进程（本机进程本就能直接读磁盘，这不构成缺陷）。
  - **实际性质**：纵深防御缺口 —— 组合「非常规 Host 写法 + `Origin: null`」时，浏览器侧的跨站读取防线会同时失效。
- **建议**：`isLoopbackRequest` 改为用 DSH 同款的 `isTrustedApiRequest` 逻辑（`app.asar` 内可见：先 `parseAuthority` 再 `isLoopbackHostname`，且 `host === undefined` 时 fail-closed），或至少对 hostname 做归一化（`.` 结尾、整数形式、`#` 截断）后再判定；`Origin: null` 应当 fail-closed。

### P2-8 `registry` 永不淘汰（长驻服务内存单调增长）

- **位置**：`lib/index.js:100`（`const registry = new Map()`）与 `:117`（每次 `save` 写入）
- **性质**：只增不减，且没有按数量/时间淘汰。每个条目是 `{ entry: { path, mime }, cwd }`，字符串量级，泄漏速率取决于生成次数。同一 `id` 不会重复（`randomUUID()`），因此不会覆盖，只会累积。
- **实测**：无法在有限时间内量化「内存增长到多少」，仅作代码事实陈述（**推断，非实测**）。
- **建议**：加 LRU 上限（如 500 条）或按 `mtime` 定期清理；`ArtifactStore.assets` 也有同样问题。

### P2-9 `ark-image` 对 `count` 缺成本防护（实测透传 100000）

- 见 P2-6 末尾。实测 `count=100000` 会原样发出 `sequential_image_generation_options.max_images = 100000`。契约 §1.1 明确「上限官方未公布，实现只校验 ≥1 的整数」，故**代码符合契约**；但工具描述未提示成本，属健壮性瑕疵。

---

## 4. 我尝试推翻但**未能推翻**的结论

以下均为**实测**，凡实测通过即视为「该结论在当前攻击面下成立」。

### 4.1 计费安全：视频「一次调用只提交一次」（最高优先级）—— 未能推翻

`_recon/verify/v5-billing.mjs`（34 通过 / 0 有效失败）。统计口径是**真实拦截 `POST /contents/generations/tasks` 的次数**：

```
=== 1. 基线 ===
  PASS  提交 POST 次数 = 1
=== 2. 429 限流重试 ===
  PASS  429 后重试 → 提交 POST 次数 = 2（设计允许：429 时上游未建任务）
  PASS  429 耗尽抛 RATE_LIMITED，提交次数=1+retries=3
=== 3. 参数类错误（400）绝不重试 ===
  PASS  视频 createVideoTask 400 → INVALID_PARAMETER，请求次数=1
  PASS  图片 generateImage 400 → INVALID_PARAMETER，请求次数=1
  PASS  理解 understand 400 → INVALID_PARAMETER，请求次数=1
  PASS  HTTP 401 / 403 / 404 / 500 / 502 / 503 → 提交次数=1（均不重试）
  PASS  HTTP 200 + 限流码 → 不重试（仅按 HTTP 状态判定）
=== 4. 超时路径（真实 fetch + 本机"接受连接但不响应"的 TCP 服务器）===
  PASS  超时抛 TIMEOUT
  PASS  超时后提交 POST 次数 = 1（未重发，不会重复建任务）
  PASS  超时在 requestTimeoutMs 附近收尾（未叠加退避）
=== 5. 取消路径 ===
  PASS  取消抛 ABORTED；取消后提交 POST 次数 = 1
  PASS  退避期间取消后提交次数 = 1（未重发）
=== 6. createVideoTask + waitForVideo 组合 ===
  PASS  提交 1 次 + 查询 N 次（查询走 GET）
  PASS  waitForVideo 内部无提交 POST（仅有 GET）
  PASS  超时返回 timedOut=true 且保留 taskId；超时路径无提交 POST
  PASS  waitForVideo 取消抛 ABORTED，无提交
  PASS  下载失败 → warnings 非空、videos 为空，且无重新提交 POST，仍回传 taskId
=== 7. 语音合成 ===
  PASS  TTS 400 → 请求次数=1
  PASS  多句 TTS 遇 400 立即停止，只发 1 次请求
=== 8. 异常路径 ===
  PASS  上游接受任务但不返回 id → BAD_RESPONSE，提交次数=1（不重试）
  PASS  retries=5 但 500 不重试 → 提交次数=1
```

**代码级确证**（`lib/http.mjs:134-139`）——重试分支只认限流：

```js
// 仅限流重试；其余错误直接上抛，避免把参数错误重试成多次计费（图片/视频为计费接口）。
if (code === ARK_ERROR_CODES.RATE_LIMITED && attempt < retries) {
  attempt += 1
  await sleep(retryBackoffMs * attempt, callerSignal)
  continue
}
throw new ArkError(code, ...)
```

**关于 429 重试是否可能重复计费**：唯一残余理论风险是「上游已建任务、却在响应链路上回 429」。这个风险**无法在本地证伪**（需要真实 429 场景），已在「未覆盖范围」中如实标注。代码的注释显式声明了「此时上游没有建任务」这一前提，属需要真实端点验证的假设。

**特别澄清一个我自己的误报**：本次验证中 `v5-billing.mjs` 第 4 节最初出现「挂起 + exit code 1」。我做了最小复现并定位到**归因**：Node 的 `AbortSignal.timeout()` 定时器是 **unref** 的；我原先用的「永不 settle 的 Promise 桩」不提供任何 ref 句柄，于是定时器永不触发、进程以 unsettled top-level await 退出（exit 13）。**这是测试桩的人为产物，不是被测代码缺陷**：

```
mode A（纯 Promise 桩 + 无其它句柄）: 无输出，exit=13，unsettled top-level await
mode B（同样调用 + 一个 2s ref 定时器）: B: THREW TIMEOUT, exit=0
v8b（真实 fetch + 本机挂起 TCP 服务器）: [2] 真实 fetch + 挂起服务器 → THREW TIMEOUT, exit=0
```

改用真实 `fetch` + 本机 TCP 服务器后，第 4/5 节全部通过。**该项不计入缺陷。**

### 4.2 `parseTtsStream` 抗畸形流 —— 未能推翻（49/49 通过）

`_recon/verify/v4-tts-stream.mjs`，`pass=49 fail=0`：

- **基线**：正常 SSE 流字节完整、`chunks` 正确、`endMarkerSeen=true`、无错误
- **半行 JSON**：分片断在 JSON 中间 → 靠整体回退仍拿到完整音频；**不残留 `-1` 噪音**；真·无补全的半行 → 0 字节 + 明确本地解析错误
- **`data:` 后无内容**：`data: ` / `data:` / `: keep-alive` / 空行 / `event: 153` → 均不报错、不影响后续音频
- **`[DONE]` / 重复结束标记 / 结束后再来数据**：`[DONE]` 不被当错误也不被当结束标记（`endMarkerSeen=false`）；重复结束标记不重复计字节；结束标记后的数据被丢弃且不报错
- **base64 含换行 / URL-safe（`-_`）**：字节完整还原
- **逐块独立编码（每片自带 padding）**：按字节序拼接正确
- **超长行**：1MB 单行不截断；2MB 垃圾行不影响后续音频
- **4096 个 `data:` 小片折叠**：字节完整
- **`code=0` 但 `data` 缺失/null/数字/空串/空白/对象**：一律视为心跳，不报错
- **上游错误码**：`45000010` + `reqid` 完整保留；未知码不会被误判为结束标记
- **输入形态**：字符串 / `ReadableStream` / `Uint8Array` 分片均正确；非法类型抛 `INVALID_PARAMETER`
- **UTF-8 多字节被切断**（中文 JSON 按字节切在字符中间）：音频仍完整、无噪音 —— 这是最容易丢字节的场景，实测通过
- **整体回退**：跨多行单个 JSON 对象（含错误对象）解析正确，错误码报真实上游码而非 `-1`
- **幂等性**：同输入两次结果一致
- **`assertAudioDeliverable` 回归**：3 倍数长度 + 无 padding + 有结束标记 → 放行；同样字节但无结束标记 → 报错 ❌ 未误伤完整音频

### 4.3 `probeImage` 对真实图片的宽高解析 —— 未能推翻（22/22 一致）

`_recon/verify/v1-probe-and-size.mjs`，用 **Windows 自带 `System.Drawing` 作为独立参照物**（非本插件代码）：

```
checked=22 mismatch=0
```

覆盖（均为本机真实文件，非人工构造）：
- PNG：`MicrosoftLogo-100/125/150/175/200.png`（48×48 … 96×96）、`Shield-100..150.png`（96×96 … 144×144）
- JPEG：`img100.jpg` 3840×2160、`img101.jpg` 3840×2400、`img102.jpg` **6400×4000**、`img103.jpg` **3839×2400**（非整千宽，能抓错位）、`img105.jpg` 1920×1200、`img50.jpg` 280×175、MSI 壁纸 5 张 3840×2160、ThemeA/img20.jpg 3840×2400
- **JPEG 段结构覆盖**：带 **EXIF/APP1** 的 4 个（`MSI_MAG.jpg`、`MSI_MEG_GODLIKE.jpg`、`MSI_MPG.jpg`、`img50.jpg`）；**渐进式（SOF2）** 的 3 个（`MSI_MEG_ACE.jpg`、`MSI_MPG.jpg`、`MSI_PRO.jpg`）—— **全部与真实宽高一致**
- `complete` 判定：PNG 检查尾部 `IEND` 魔数、JPEG 检查 `FF D9`，逻辑正确

> WebP 的 VP8/VP8L/VP8X 三个分支我只做了**代码级核验**（bit 位置与各格式规范一致），**未做实测**：本机未找到真实 `.webp` 文件，且 Windows 自带解码器不覆盖 WebP。已列入「未覆盖范围」。

### 4.4 `resolveSize` 与契约 §1.1 的档位示例 —— 未能推翻（4/4 一致）

```
2K + 16:9      契约= 2731x1536    实现= 2731x1536    OK
1K + 1:1       契约= 1920x1920    实现= 1920x1920    OK
1K + 16:9      契约= 2560x1440    实现= 2560x1440    OK
4K + 16:9      契约= 4096x2304    实现= 4096x2304    OK
```

契约声明的「可行比例带下界 ≈0.2197」也复算一致（`3686400 / 4096²`）。

**关于题面点名的极端宽高比**：`1:16` / `16:1` 在三个档位下都返回 `256x4096` / `4096x256`，面积 `1,048,576` **低于方舟下限 `3,686,400`**。我一度以为这是缺陷，逐条核对契约 §1.1 后确认**属契约明示的裁决**：「三条约束在数学上不可能同时满足……**裁决：保单边上限**，极端比例下允许总面积低于下限，并在返回结果与注释里写明实际落到的尺寸」。代码注释（`ark-image.mjs:213-215`）与契约完全一致 ⇒ **不算不一致**，但建议在 `ark_generate_image` 的工具描述里提示「比例超出约 `[1:4.55, 4.55:1]` 时面积会被单边上限压到下限之下」（目前描述只说了下限，没说这个例外）。

`1:5` / `5:1` 落在 `[1:4.55, 4.55:1]` 之外，返回 `820x4096`（面积 3,358,720 < 下限）—— 同样属契约裁决范围。

### 4.5 预览路由：伪造 id 读取工作区外文件 —— 未能推翻

见 P2-7。13 种伪造 id（穿越、绝对路径、编码绕过、原型链键名）**全部 404**，`registry` 为 `Map` 且只存本插件 `save()` 产出的绝对路径，`id` 由 `randomUUID()` 生成 —— **不存在从 id 到任意路径的映射通道**。

### 4.6 Host / Origin 校验的基本面 —— 未能推翻

`缺 Host`、`evil.com`、`127.0.0.1.evil.com`、`localhost.evil.com`、`127.0.0.1@evil.com`、`127.0.0.1:99999`、`[::ffff:127.0.0.1]`、`sec-fetch-site: cross-site`、`Origin` 与 `Host` 不同源 —— **全部 403**（fail-closed 成立）。DSH 宿主 `connection.requestRejection` 返回数字码时被原样透传（401 保持 401），返回非数字 / 抛异常时归一成 403 —— 行为正确。

---

## 5. 文档与代码一致性核对（逐条）

核对脚本 `_recon/verify/v10-docs-vs-code.mjs`：`pass=35`、**不一致 13**。逐条结果：

### 5.1 `docs/MODULE-INTERFACES.md` 声明的导出 —— ✅ 全部存在

```
PASS  ark-image.mjs: 8 个声明导出
PASS  ark-video.mjs: 3 个声明导出
PASS  volc-tts.mjs: 3 个声明导出
PASS  volc-asr.mjs: 5 个声明导出
PASS  ark-understand.mjs: 1 个声明导出
PASS  artifacts.mjs: 4 个声明导出
PASS  config.mjs: 4 个声明导出
PASS  http.mjs: 4 个声明导出
PASS  errors.mjs: 7 个声明导出
```

### 5.2 不一致清单

| # | 文档声明 | 代码实际 | 级别 |
|---|---|---|---|
| 1 | `MODULE-INTERFACES.md:38-39`「取消要求（硬性）：收到取消时抛 `ArkError(ABORTED)`」 | 429 退避期间取消抛 `DOMException`（`code=20`） | P2-3 |
| 2 | `index.js:296` 工具描述「把音频文件转写成文字……按音频时长计费」 | `transcribe()` 无条件抛 `NOT_IMPLEMENTED`，0 网络请求 | P2-5 |
| 3 | 契约 §1.2「`output_url` 24h 失效 ⇒ 拿到即下载落盘，不要只回传 URL」 | `ark_generate_video action="status"` 命中 `succeeded` 时不下载（`videos: []`） | P2-4 |
| 4 | 契约 §1.2 定义 `frames` 语义（与 `duration` 互斥） | `ark_generate_video` 工具 schema 未暴露 `frames` ⇒ 能力不可达 | P2-6 |
| 5 | `MODULE-INTERFACES.md:92-93` 声明 `lastFrame` / `referenceImages` / `referenceVideo` / `referenceAudio` | 工具 schema 全部未暴露 | P2-6 |
| 6 | `MODULE-INTERFACES.md:95` 声明 `cameraFixed` | 工具 schema 未暴露 | P2-6 |
| 7 | `MODULE-INTERFACES.md:119-120` 声明 `allowLocalVideoAudio` 开关 | 工具 schema 未暴露（模型无法开启内联） | P2-6 |
| 8 | `artifacts.mjs:228` 的 `previewUrl` 形态（`/dsh-ark/asset/<id>`） | `index.js:34/419` 的 exact 路由只认 `/dsh-ark/asset?id=<id>` | P2-2 |
| 9 | 「工具回传的预览地址可用」这一隐含契约 | 无任何测试覆盖 end-to-end 可达性（两处各自为绿） | P2-2 |
| 10 | `ARK-API-CONTRACT.md` §3.5 / `MODULE-INTERFACES.md:76` 声明路径必须在 cwd 内 | 修复前 `understand` / `video` 未做 realpath（**已修**） | P1（已修） |
| 11 | `MODULE-INTERFACES.md:76` 对 `ark-image` 声明「realpath 后逐段校验」 | 修复前 `ark-image` 的 `isInside` 用 `!rel` 把 root 自身判成界外（**已修**） | P2-1 同类 |
| 12 | `ark_generate_video` 的 `prompt: required: true` | `action="status"` 查询不需要 prompt | P2-6 |
| 13 | 工具描述未提示 `count` 的成本线性增长 | `count=100000` 原样透传（契约允许无上限） | P2-9 |

### 5.3 契约中**已核实一致**的条款（✅）

```
PASS  契约 §1.1 四个档位示例（2K+16:9 / 1K+1:1 / 1K+16:9 / 4K+16:9）
PASS  契约 §1.1 可行比例带下界 ≈0.2197
PASS  契约 §2.1 TTS_END_CODE === 20000000、TTS_SUCCESS_CODE === 0
PASS  契约 §2.1 结束标记不丢最后一段音频
PASS  契约 §2.1 不支持 pcm（AUDIO_FORMATS 无 pcm，工具描述已声明）
PASS  契约 §1.2 status 对象形态取 phase / 字符串形态都兼容
PASS  契约 §1.2 duration 与 frames 互斥 → INVALID_PARAMETER
PASS  契约 §3.1 只有 429 重试（http.mjs 重试分支断言 RATE_LIMITED）
PASS  契约 §3.2 视频工具描述标注「按秒计费」
PASS  契约 §3.3 错误信息不含 Authorization 回显
PASS  契约 §3.4 图片/视频工具描述提到 24 小时失效
PASS  契约 §3.5 understand / video 已含 realpath 判定（修复后）
PASS  契约 §2.2 已如实标注 ASR 未实现
PASS  MODULE-INTERFACES 已如实标注 ASR 未实现
```

---

## 6. 未覆盖的范围（诚实声明）

以下内容**我没有验证**，任何人不应把本报告当作这些方面的结论：

1. **真实网络端到端**：全程**未向方舟/火山发送任何真实请求**（任务约束）。所有 HTTP 行为均通过注入 `fetchImpl` 桩或**本机 TCP 服务器**（`127.0.0.1`，只做连接与挂起，不含任何外网流量）验证。因此：
   - 端点路径、鉴权头、请求体字段是否与真实服务一致 —— **未验证**（契约 §2.1 声明的「已用真实端点探测确认」我无法复核）。
   - **429 重试是否会重复计费**：代码假设「429 时上游未建任务」。这一假设**无法在本地证伪**，需要真实 429 场景才能确认。这是本次验证中**唯一残留的计费风险敞口**。
   - `output_url` 的 24h 失效、`status` 的真实取值集合、TTS 流的真实分片行为 —— 均未验证。
2. **WebP 的 VP8 / VP8L / VP8X 三分支**：仅做代码级 bit 布局核验（与各格式规范一致），**未实测** —— 本机找不到真实 `.webp` 文件，`System.Drawing` 也不解码 WebP。人工构造的 WebP 无法作为「真实参照物」，故未纳入实测结论。
3. **Windows 8.3 短名指向界外**：E: 卷**未启用 8.3 短名生成**（`dir /x` 未显示 `~1` 名），因此「界内短名实际指向界外目录」这一向量**未能实测**。已实测的替代项：字面 `~1` 目录（界内）正常放行、`C:/PROGRA~1/...` 被拒。C: 卷上存在 `PROGRA~1`，但该路径字面即越界，不构成有效向量。
4. **文件符号链接（非目录联接）**：`fs.symlinkSync` 返回 `EPERM`（本机未授予 `SeCreateSymbolicLinkPrivilege`，且我无权提升），故**文件符号链接向量未实测**，只测了**目录联接（junction）**（不需要管理员，已覆盖）。两者在 `fs.realpath` 下语义相同，但这是推断。
5. **`lib/index.js` 的真实 `apply()` 执行**：`lib/index.js` 依赖 peer 包 `@deepseek-ai/dsh-tools`，在插件仓库外无法解析；仓库内的解法是 `tests/stub-dsh-loader.mjs`（ESM loader），但它对**原始 Windows 绝对路径入口**会抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（Node 24 + Windows 的 loader 交互问题），无法用于仓库外的临时脚本。因此预览路由部分的验证是**逐行复刻** `lib/index.js:34 / 37-75 / 109-124 / 406-450` 后在复刻体上做的（脚本头部已逐条标注行号来源），**不是**直接 import `lib/index.js` 执行。
   - 但 P2-2 的核心结论不依赖该复刻：`previewUrl` 模板与 `ASSET_ROUTE` 均为**直接引文**，且分别被 `tests/core.test.mjs:165`、`tests/ark-image.test.mjs:322` 与 `tests/plugin.test.mjs:108` 三处既有断言固化；DSH 侧 exact 路由按 pathname 查表也是从 `app.asar` 源码直接读到的。
6. **真实 DSH webServer 挂载后的行为**：未启动任何服务器，未在真实 GUI 里点击预览链接。P2-2 的「404/HTML 外壳」是按 DSH 路由表语义推导的，**未在真实浏览器里目视确认**。
7. **TOCTOU**：600 次竞态尝试未复现，但如 P2 节所述，这**不等于证明不存在**；我没有构造出确定性证明。
8. **TTS / ASR 的真实协议细节**：`volc-tts.mjs` 我只对抗了 `parseTtsStream`（纯函数）与 `assertAudioDeliverable`，**没有**验证 `synthesizeSpeech` 的分句/拼接/凭据双通道在真实服务下的表现（仓库内已有相关单测，但那是作者自测）。ASR **整体未实现**，无从验证。
9. **性能与资源**：未做并发压力测试、未量化 `registry` / `ArtifactStore.assets` 的内存增长（P2-8 仅为代码事实陈述）。
10. **`scripts/smoke.mjs`**：未运行（未确认它是否需要真实凭据）。
11. **`cordis.patch.yml` / `package.json` 与 DSH 宿主版本兼容性**：未验证（本机无可用 DSH profile 装配环境）。
12. **`docs/ark-cli-skills/**`**：作为第三方参考资料，未逐一核对（体量约 1.2MB）。

---

## 7. 复现指引

所有脚本位于 `<工作区>\_recon\verify\`（**未放进插件目录，不影响 `dsh-ark` 的包内容**）：

| 脚本 | 覆盖内容 |
|---|---|
| `v1-probe-and-size.mjs` | `probeImage` 真实文件交叉验证（22 个）+ `resolveSize` 全扫描 + 契约示例 |
| `v2-path-escape.mjs` | 路径逃逸（junction / `..` / 绝对路径 / 8.3 / 设备前缀），修复前后对比 |
| `v3a-dotdot-prefix.mjs` | `..foo.png` 误判复现与修复复验 |
| `v4-tts-stream.mjs` | `parseTtsStream` 畸形流对抗（49 项） |
| `v5-billing.mjs` | 计费安全：提交 POST 次数统计（34 项） |
| `v5b-timeout-isolate.mjs` / `v5c-locate-hang.mjs` | 定位 v5 第 4 节的挂起（排除被测代码嫌疑） |
| `v6-advanced-escape.mjs` | 第一轮进阶向量（因沙箱路径含中文/空格导致 `cmd mklink` 失败，结论以 v6b 为准） |
| `v6b-advanced.mjs` | 进阶逃逸向量（ASCII 沙箱）+ TOCTOU 竞态（600 次） |
| `v7-asset-route.mjs` | 预览路由：驱动真实 `lib/index.js` 的尝试（**未成功**，见「未覆盖范围」第 5 条） |
| `v7c-asset-route.mjs` | 预览路由：逐行复刻 `lib/index.js` 后的 URL 形态 / 伪造 id / Host-Origin 绕过 |
| `scan-asar.mjs` / `scan-asar2.mjs` | 从 `app.asar` 字节中提取 DSH `webServer` 的路由注册与 `match()` 语义 |
| `v8-timeout-ref.mjs` / `v8b-real-fetch-timeout.mjs` | 澄清 `AbortSignal.timeout` 的 unref 语义（挂起归因） |
| `v9-cancel-during-backoff.mjs` | 429 退避期间取消的抛出物类型 |
| `v10-docs-vs-code.mjs` | 文档与代码逐条一致性核对 |
| `v11-mutation-test.mjs` | 变异测试：验证安全回归用例不是假绿 |

> 已清理：验证过程中曾在 `_recon/node_modules/` 临时放置 `@deepseek-ai/dsh-tools` 桩包以尝试加载 `lib/index.js`，该方案无效（Node 的 ESM 包解析锚定在**导入方**文件路径上，与入口脚本位置无关），已删除以免影响 `_recon` 下其它工具。沙箱目录 `_recon/verify/sandbox*` 含自引用 junction，**不要对它做递归遍历**（会导致 `Get-ChildItem -Recurse` 栈溢出），验证完可整体删除。

运行示例：

```powershell
cd <工作区>\dsh-ark
node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"      # 基线 123/123
node <工作区>\_recon\verify\v5-billing.mjs                        # 计费安全
node <工作区>\_recon\verify\v4-tts-stream.mjs                     # TTS 解析
node <工作区>\_recon\verify\v10-docs-vs-code.mjs                  # 文档一致性
```

> 说明：这些脚本用 `file:///<工作区>` 形式的 URL 直接 import 被测模块（Windows 上 ESM 不接受裸盘符路径），因此**不需要** `stub-dsh-loader`（只有 `tests/*.test.mjs` 因为 import `lib/index.js` 才需要它）。临时沙箱目录为 `<工作区>\_recon\verify\sandbox*` 与 `<临时盘路径>`（含 junction，验证后可整体删除）。

---

## 8. 给 Lead 的修复建议优先级

| 优先级 | 项 | 建议动作 |
|---|---|---|
| 1 | P2-2 预览地址不可达 | 统一 `previewBase` 与路由形态；补一条「工具产出 URL → 路由命中」的测试 |
| 2 | P2-4 `action=status` 不下载产物 | 命中 `succeeded` 时落盘；`renderVideoStatus` 对空 `videos` 给出明确文案 |
| 3 | P2-3 退避期间取消的抛出物 | `sleep` 抛 `ArkError(ABORTED)`，或在重试分支外包 `toArkError` |
| 4 | P2-6 工具参数过窄 | 至少补 `lastFrame` / `frames` / `cameraFixed`；`prompt` 改为非必填（或按 `action` 条件必填） |
| 5 | P2-5 `ark_transcribe` 描述 | description 里写明「未实现、不发请求、不产生费用」 |
| 6 | P2-7 Host/Origin 归一化 | 对 hostname 做归一化；`Origin: null` fail-closed |
| 7 | P2-8 registry 无淘汰 | 加 LRU / 定期清理 |

**P1 已闭环**：修复经复验通过（junction 向量全部拒绝、`fetch` 调用数为 0），且变异测试确认新增回归用例确能捕获该漏洞。

---

# 第二轮复验（修复后）

> 验证者：teammate `verifier`
> 时间：2026-10-11 00:10 – 00:15 (Asia/Shanghai)
> **验证载体：工作区文件本体**（`<工作区>\dsh-ark`），**不是**任何重建副本。
> 唯一的技术处理：`lib/index.js` 依赖 peer 包 `@deepseek-ai/dsh-tools`，因此用**临时 loader 钩子**把该裸说明符指向桩包（桩包与 loader 都在 `<临时盘路径>\`），
> 从而让**工作区的 `lib/index.js` 原件**被直接加载执行。脚本会打印被加载模块的字节数与关键中文串作为指纹：
> ```
> 被测模块 = 工作区 <工作区>/dsh-ark/lib/index.js
>   字节数 = 29783 （与磁盘一致）
>   含「视频任务仍在渲染」 = true
> ```

## R0. 本轮最重要的发现：`lib/index.js` 曾经历一次编码事故（已修复）

第一轮报告交付后，`lib/index.js` 出现**中文 mojibake + 换行被吞**的损伤，一度使 `node --check` 失败、`tests/plugin.test.mjs` 整文件加载失败（实测 `112 pass / 1 fail`）。**这是本轮真正的阻断项，已在第二轮修复。** 完整证据链：

| 阶段 | 实测证据 | 判定 |
|---|---|---|
| 受损（乱码） | `_recon/verify/v12-encoding-check.mjs`：`视频任务仍在渲染` includes=**false**；mojibake 特征 `瑙`/`浠诲姟` includes=**true**；CJK 4128 字中 U+9000 以上占 1095 | 中文全废 |
| 受损（结构） | 第 65 行 = `"  // 绾暟瀛楀舰寮忥細...鎴栧崄鍏繘鍒躲€?  if (/^(0x[0-9a-f]+|\\d+)$/.test(h)) {"` ⇒ 原「中文标点+换行」处的**换行被吞**，下一行 `if` 被并进 `//` 注释 | 代码被注释吃掉 |
| 受损（语法） | `node --check lib/index.js` → `SyntaxError: Illegal return statement`（第 73 行）；全量 `112 pass / 1 fail` | **不可交付** |
| 反解可行性 | 用 .NET CP936 反解可读，但「中文标点 + 空格」处变成 `U+FFFD?` ⇒ **有损，不能自动还原** | 必须重写 |
| 修复后 | `node --check` → exit 0；全量 **133 pass / 0 fail / 0 skipped**；`lib/index.recovered.js` 已删除 | ✅ 闭环 |

**要点（供后续维护者）**：这类事故**不会被既有单测发现** —— 当时 125 个用例全绿，因为断言只匹配 ASCII 子串（错误码、`taskId`、`/计费/`）。Lead 随后新增的 `tests/encoding-guard.test.mjs`（4 用例，实测 `pass=4 fail=0 skipped=0`）正是补这个盲区：mojibake 特征扫描、关键中文文案存在性、**结构级**「代码不得被并进注释」、入口可解析性。

## R1. 逐条复验结论

| 编号 | 结论 | 关键证据（均为实测） |
|---|---|---|
| **P2-1** `..foo.png` 误判 | ✅ 已修 | 第一轮已复验；`..foo.png` / `..weird/x.png` / `..../x.png` 均可读 |
| **P2-2** 预览地址不可达 | ✅ 已修并**端到端打通** | 见 R2 |
| **P2-3** 退避期间取消抛 DOMException | ✅ 已修 | `v5-billing.mjs` 该项由 FAIL 转 **PASS「退避期间取消抛 ABORTED（不是 RATE_LIMITED）」**；计费安全 35/35 |
| **P2-4** `action=status` 不下载产物 | ✅ 已修（`once` 模式） | 见 R4 |
| **P2-5** `ark_transcribe` 描述 | ✅ 已修 | 描述含「**当前不可用**…直接返回 NOT_IMPLEMENTED，不会发起任何请求，也不会计费」；4 项断言全 PASS |
| **P2-6** 视频参数过窄 | ✅ 已修 | schema 现暴露 17 个参数（原 10 个），`lastFrame`/`referenceImages`/`referenceVideo`/`referenceAudio`/`cameraFixed`/`frames`/`allowLocalVideoAudio` 全部到位；`prompt` 不再是 schema required，改在 execute 里对 submit 路径显式校验 |
| **P2-7** Host/Origin 绕过 | ✅ 已修（我复核并**接受 Lead 的推翻**） | 见 R3 |
| **P2-8** registry 无淘汰 | ✅ 已修 | `lib/index.js` 引入 `REGISTRY_LIMIT` + `registrySet()` 插入序淘汰（源码核验） |
| **P2-9** `count` 缺成本告警 | ✅ 已修 | 描述含「按张计费：count > 1 会生成多张并**按张数翻倍计费**，不确定时保持 1」 |

### R1.1 全量基线与产物状态

```
node --check lib/index.js                       → exit 0
node --import ./tests/stub-dsh-loader.mjs --test "tests/*.test.mjs"
ℹ tests 133 / pass 133 / fail 0 / skipped 0 / todo 0
```

- `lib/` 内容：`ark-image.mjs` / `ark-understand.mjs` / `ark-video.mjs` / `artifacts.mjs` / `config.mjs` / `errors.mjs` / `http.mjs` / `index.js` / `volc-asr.mjs` / `volc-tts.mjs`。
  - ⚠️ 与 Lead 消息中「**9 个**正式源文件」不符：实际是 **10 个**文件（Lead 先说「只剩 9 个」后又在同段写「9 个正式源文件」）。不影响交付，仅记录以免后续对照困惑。
  - ✅ `lib/index.recovered.js` 已删除，`lib/` 下无临时/遗留文件。
- mojibake 扫描（`_recon/verify/v13-mojibake-scan.mjs`）：**扫描 29 个文件，判定受损 0 个**（较第一轮 28 个新增 2 个测试文件，同时少了一个 `index.recovered.js`）。`lib/` 9 个非入口文件 + `index.js` 的中文抽检全部「有中文且无 mojibake」。
- 结构完整性（`_recon/verify/v21-comment-balance.mjs`，逐字符扫描并剔除字符串/正则/行注释）：块注释 **开 16 / 闭 16，严格平衡**，结束时不在块注释或字符串内，且 `node --check` 通过。
  - 说明：我最初的启发式检查（`v20`）报「16 vs 10 不成对」是**我的判据错**（未排除单行型 `/** ... */`，本文件有 6 处），已用逐字符扫描纠正；**该项不是缺陷**。

## R2. P2-2 端到端复验（真实驱动工作区文件）

复刻 `lib/index.js` 的**不成立**——本轮改为真实驱动：用 loader 钩子加载工作区 `lib/index.js` 的 `apply()`，注入桩 `fetch`，真实调用 `ark_generate_image`，再从工具**返回文本**里取出预览地址去打**真实注册的路由**。

```
=== 2. P2-2 往返：工具产出 previewUrl → 真实注册路由 → 取回字节（验证载体=工作区文件） ===
  工具产出的预览地址 = "/dsh-ark/asset?id=<uuid>"
  PASS  previewUrl 为 ?id= 形态
  PASS  pathname === 注册路由 path
  PASS  路由返回 200
  PASS  字节 === 产物字节
  PASS  Content-Type = image/png
```

⇒ **模型拿到的地址现在真的能取回产物字节**（第一轮报告里的 P2-2 已闭环）。

**新用例是否有效（Lead 要求的变异验证）**：`tests/plugin.test.mjs` 的「往返一致性」用例**确实会因 URL 形态回归而变红** —— 其断言 `assert.equal(parsed.pathname, route.path)` 在旧形态 `/dsh-ark/asset/<id>` 下必然不成立（`_recon/verify/v18-p22-checks.mjs`：新形态 PASS、旧形态 **FAIL(预期)**）。

**但该用例仍有一个覆盖缺口（遗留 P3 级建议）**：用例在 `plugin.test.mjs:227` **硬编码** `previewBase: '/dsh-ark/asset'`（我实测其源码：`硬编码 previewBase = true`、`从路由/插件推导 previewBase = false`），因此它**测不出「插件 `storeFor()` 注入的 `previewBase` 与 `ASSET_ROUTE` 脱钩」**这一具体回归。建议把该用例改成从插件侧驱动（真实调用工具后取 `previewUrl`），即可完全闭合。
> 注：本轮 R2 的真实驱动测试（`_recon/verify/v22-live-drive.mjs`）已经覆盖了这一缺口，故仅作为测试加固建议，不列为未修缺陷。

## R3. P2-7 复验 + 对 Lead「推翻」的复核

**绕过向量全部 403**（真实驱动，工作区文件）：

```
PASS  Host=127.0.0.1#evil.com → 403        PASS  Host=127.0.0.1?x=1 → 403
PASS  Host=evil.com@127.0.0.1 → 403        PASS  Host=127.0.0.1/evil → 403
PASS  Host=127.0.0.1\evil → 403            PASS  Host=127.0.0.1 evil → 403
PASS  Host=127.0.0.1: → 403                PASS  Host=127.0.0.1:abc → 403
PASS  Host=[::1 → 403                      PASS  缺 Host → 403
PASS  Host=evil.com → 403                  PASS  Host=127.0.0.1.evil.com → 403
PASS  Host=localhost.evil.com → 403        PASS  Origin: null → 403
PASS  Origin: file:// → 403                PASS  Origin: data: → 403
PASS  Origin 端口不同源 → 403               PASS  Origin 主机不同源 → 403
PASS  Origin 多端口畸形 → 403               PASS  sec-fetch-site: cross-site → 403
```

**正常浏览器请求仍放行**（未修成「谁都进不来」）：

```
PASS  正常浏览器：Host=127.0.0.1:19387 → 放行到 404
PASS  正常浏览器：Host + 同源 Origin → 放行到 404
PASS  正常浏览器：Host + 同源 Origin + same-site → 放行到 404
PASS  Host=localhost:19387 → 放行到 404
PASS  Host=localhost:19387 + 同源 Origin → 放行到 404
PASS  Host=[::1]:19387（无 Origin）→ 404      ← 反向误伤检查：IPv6 回环未被误拒
PASS  Host=[::1]:19387 + 同源 Origin → 404    ← 反向误伤检查
```

### R3.1 关于 `2130706433` / `0x7f000001` / `0177.0.0.1`：**我接受 Lead 的推翻**

Lead 主张这三种写法语义上确实指向 `127.0.0.1`，因此走到「未登记 id → 404」而非 403 是正确行为。我用**带真实已登记 id** 的现场复核（`_recon/verify/v19-p27-recheck.mjs`），判据换成「**能否拿到产物内容**」而不是「403 还是 404」：

```
已登记产物 id = <uuid>

Host=2130706433        无 Origin → code=200 bytes=70 isPng=true
                       Origin=evil.com → code=403 bytes=0     ✅ 不泄漏
Host=0x7f000001        无 Origin → code=200 bytes=70 isPng=true
                       Origin=evil.com → code=403 bytes=0     ✅ 不泄漏
Host=0177.0.0.1        无 Origin → code=403 bytes=0
                       Origin=evil.com → code=403 bytes=0     ✅ 不泄漏

对照：Host=127.0.0.1:19387 → code=200 bytes=70 isPng=true（现场有效，非假阴性）
攻击者页面路径：Host=127.0.0.1:19387 + Origin=evil → 403
                Host=2130706433 + Origin=evil → 403
                Host=127.0.0.1:19387 + Origin: null → 403
```

**论证（为什么不必要求 403）**：
1. **攻击者页面无法利用**：浏览器发起的跨站请求必然携带攻击者页面的 `Origin`，与 `Host` 不同源 ⇒ 一律 403（实测 3/3）。
2. **无 Origin 的调用方只可能是非浏览器客户端**（curl / 本机进程）。这类调用方**本来就能直接读磁盘上的产物文件**，Host 白名单并不构成对它们的边界 ⇒ 放行不构成提权。
3. Lead 把用例改为断言「403 **或** 404」并写清注释，钉住的**安全性质**（绝不返回内容）是准确的。

⇒ 我**撤回**第一轮报告中「应归一化后直接 403」的建议中「必须 403」的部分；保留的仅是「hostname 归一化能减少歧义」这一非缺陷性意见。**该项判定为已修（无遗留）。**

## R4. P2-4 复验：真实驱动 `action='status'`

第一轮我预判的风险**成立且已修**：`waitForVideo` 的 `timeoutMs` 是 elapsed 预算语义，`timeoutMs: 0` 会在第一次迭代就返回 `timedOut`，那次 GET 根本不发、产物也不下载。Lead 改为显式 `once: true` 单次模式。

真实驱动工作区文件（`_recon/verify/v22-live-drive.mjs`）：

```
工具返回 = "视频已生成并下载到工作区（task_id=cgt-77）：\n  1. ark-output/20261010161215-cgt-77-b63ca818.mp4（252 B）"
统计：提交POST=0 查询GET=1 下载=1
  PASS  提交 POST 数 = 0
  PASS  查询 GET ≥ 1
  PASS  发出下载请求
  PASS  产物落盘为 .mp4
  PASS  落盘字节一致
  PASS  文案说"已下载到工作区"
  PASS  文案不谎称"仍在渲染"
```

`tests/video-once.test.mjs` 实测 **pass=4 / fail=0 / skipped=0**（4 个用例，覆盖 once+succeeded / once+running / `timeoutMs:0` 语义回归 / once+failed）。

> 计数说明：Lead 消息称该文件「5 用例」，实测是 **4 个 test**（断言数多于 4）。不影响结论，仅记录。

## R5. 计费安全（第二轮回归）

`_recon/verify/v5-billing.mjs`：**pass=35 / fail=0**（第一轮为 34 pass / 1 fail，那一 fail 即 P2-3，现已转 PASS）。核心不变式仍成立：400/401/403/404/500/502/503 全部只发 1 次；仅 429 退避重试；超时/取消/退避中取消提交次数均为 1；`waitForVideo` 内部零提交 POST；`once` 模式同样零提交 POST。

## R6. 仍未修 / 未覆盖（交付前请知悉）

### R6.1 未修项
本轮**无未修的功能性缺陷**。9 条 P2 全部处理完毕；P1 已在第一轮闭环。

### R6.2 遗留建议（非缺陷，可不阻塞交付）
1. **往返用例的覆盖缺口**（见 R2）：`plugin.test.mjs` 硬编码 `previewBase`，测不出「插件注入值与路由常量脱钩」。建议改为从插件侧驱动。
2. **`registry` / `ArtifactStore.assets` 的淘汰策略**：P2-8 已给 registry 加上限 512，但 `ArtifactStore.assets` 仍是只增不减（`artifacts.mjs`）。属轻微内存增长，无功能影响。
3. **`Origin` 缺省端口**：`Origin: http://localhost` 与 `Host: localhost:80` 会被判不同源（fail-closed 方向，安全无害，但理论上会误拒）。未实测，仅代码推断。
4. **计数口径**：Lead 消息中的「9 个源文件」「5 个用例」与实际（10 个 / 4 个）不符，建议交付前自查一次这类陈述。
5. **P3 文档同步缺口（本轮新发现，交前可顺手补）**：`lib/ark-video.mjs` 新增的 `waitForVideo({ once })` 已实现、已被 README 记录（`README.md` 含 `tests/video-once.test.mjs | 单次查询模式（查一次 + 落盘、零提交）`），但 **`docs/MODULE-INTERFACES.md` 的 `waitForVideo` 签名仍未声明 `once`**（实测 `声明了 once ? false`），也未声明 `ArtifactStore` 的 `previewBase` 新语义与 `?id=` 形态（实测均 false，而 README 已写明 `/dsh-ark/asset?id=…`）。
   → 属 P3（文档滞后于代码），**不影响功能与安全**；建议在 `MODULE-INTERFACES.md` 的 `waitForVideo` 入参加一行 `once?: boolean`（语义：只查一次 + 已完成则下载，不轮询、零提交），并在共享类型里补 `previewBase`。

### R6.4 关于我自己核对脚本的两处陈旧判据（避免误读）
`_recon/verify/v10-docs-vs-code.mjs` 本轮报出 3 处「不一致」，其中 **2 处是我脚本里的过期正则，不是被测代码的问题**，已逐一核实：
- 「prompt 对 action=status 也是 required」→ 已过期：`lib/index.js` 现在写的是 `prompt: { type: 'string', description: '视频内容描述（action=submit 时必填）' }`，**无 `required: true`**，改由 execute 校验（实测 `/prompt:\s*\{[^}]*required:\s*true/` = false）。
- 「previewUrl 形态与 ASSET_ROUTE 不匹配」→ 已过期：`artifacts.mjs` 现在产出 `${previewBase}?id=${encodeURIComponent(id)}`，v10 的正则仍按旧的 `${previewBase}/${id}` 匹配（且误抓到了 JSDoc 里的类型注解）。
- 第 3 处即 R6.2 第 5 条的 `MODULE-INTERFACES.md` 未同步 `once`，**这一条是真的**。

### R6.3 仍未覆盖的范围（与第一轮一致，未变）
1. **真实网络端到端**：全程**零外网请求**。所有 HTTP 行为由注入桩或**本机 TCP 服务器**（`127.0.0.1`）验证。因此端点/鉴权头/请求体字段与真实服务的一致性、以及**「429 时上游是否真的未建任务」这一唯一残留计费假设**，仍未证伪。
2. **WebP 的 VP8 / VP8L / VP8X**：仅代码级 bit 布局核验（本机无真实 `.webp`，`System.Drawing` 不解码 WebP）。
3. **Windows 8.3 短名指向界外**：E: 卷未启用 8.3 生成，该向量无法实测。
4. **文件符号链接（非目录联接）**：本机 `fs.symlinkSync` 返回 `EPERM`（无 `SeCreateSymbolicLinkPrivilege`），只测了目录联接（junction）。
5. **TOCTOU**：600 次竞态未复现；这是「未能构造出」，不等于「证明不存在」。
6. **真实 DSH webServer 挂载后的浏览器目视确认**：未启动服务器、未在 GUI 中打开预览链接；R2 的「路由命中」是按 DSH `match(pathname)` 语义 + 真实 handler 调用验证的。
7. **`scripts/smoke.mjs`**：未运行。
8. **`cordis.patch.yml` / `package.json` 与 DSH 宿主版本兼容性**：未验证。
9. **`docs/ark-cli-skills/**`**：未逐一核对（约 1.2MB 第三方参考）。

## R7. 第二轮结论

**可以交付。** 判定依据：
- `node --check lib/index.js` 通过；全量 **133 / 133 pass / 0 fail / 0 skipped**。
- `lib/` 无遗留文件；`lib/index.recovered.js` 已删除；mojibake 扫描 **29 文件全正常**；块注释严格平衡。
- 9 条 P2 全部复验通过，其中 P2-2 / P2-4 / P2-7 由**工作区文件的真实驱动**验证（非副本、非复刻）。
- 计费安全 35/35；P1 路径逃逸已在第一轮闭环并有变异测试背书。
- 唯一的阻断级事故（`lib/index.js` 编码 + 结构损伤）已修复，且新增 `encoding-guard.test.mjs` 从**文案级 + 结构级 + 语法级**三层防复发。

⚠️ 交付前最后一道人工确认建议：**在真实 DSH GUI 里点一次预览链接**，确认端到端观感与 R2 的自动化结论一致（这是我未能覆盖的唯一环节）。
