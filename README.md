# dsh-ark

**把火山方舟（Volcengine Ark）的生成能力接进 DeepSeek Harness：图像生成、视频生成，以及豆包语音（合成 / 识别 / 音频生成），模型可直接调用。**

零运行时依赖（只用 Node 内置能力 + DSH 宿主已有的 peer 包），密钥走 DSH 凭据服务不落明文，
所有产物落盘到工作区而不是只回传 24 小时失效的临时直链。

[![test](https://img.shields.io/badge/tests-169%20passing-brightgreen)](#开发)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-blue)](#环境要求)

> **快速安装**：应用内 **插件 → 安装 → 安装源** 填 `github:BlankTasftu/DSH-ark`，
> 重启应用，然后在插件详情页填两个密钥即可。详见[安装](#安装)。

---

## 提供的工具

| 工具 | 能力 | 计费口径 |
|---|---|---|
| `ark_generate_image` | Seedream 文生图 / 参考图生图 / 指令编辑 / 多张候选 | 按张 |
| `ark_generate_video` | Seedance 文/图生视频，异步任务（提交返回 `taskId`，可查进度） | **按秒，单价最高** |
| `ark_speak` | 豆包语音合成 2.0，长文本自动按标点分句拼接，支持音色/语速/音量/情感/克隆音色 | 按字符 |
| `ark_generate_audio` | **SeedAudio 1.0 音频生成**：按自然语言描述直接生成音频，可参考音频/参考图；用于音效、配音、氛围音 | 按音频时长 |
| `ark_transcribe` | 语音转写（ASR）：返回全文 + 毫秒级分句时间戳 | 按音频时长 |
| `ark_credential_status` | 只读自检：查看凭据来自哪一层 | 免费 |

> **不做多模态理解（看图问答 / OCR）** —— 宿主模型本身已具备视觉能力，
> 再包一层视觉模型只会多花一次 token，还容易与宿主能力混淆。

> **三个语音工具的区别**（容易混）：
> - `ark_speak` = **语音合成（TTS）**：给一个**音色** + 文本 → 念出来（`/tts/unidirectional`）
> - `ark_generate_audio` = **音频生成**：给一段**自然语言描述** → 生成声音
>   （SeedAudio 1.0，`/tts/create`）。**注意：这个模型没有音色参数** ——
>   想指定音色请用 `ark_speak`；影响生成结果只能靠文字描述或用参考素材
> - `ark_transcribe` = **语音识别（ASR）**：音频 → 文字
>   （录音文件识别极速版，`/auc/bigmodel/recognize/flash`）

> **鉴权只有一种：语音 API Key（只发 `X-Api-Key`）。**
> 旧版 App ID + Access Token 已整体移除 —— 官方文档明确 App ID 是"请求/应用配置"、
> **不是鉴权因子**，而且实测新版 API Key 已覆盖全部语音能力
> （TTS 2.0 / ASR 极速版 / SeedAudio 音频生成）。

---

## 填密钥：插件设置页

插件带一个设置页，在侧栏 **插件 → 已安装 → dsh-ark** 的详情页里，
**两个**输入框分别对应两把密钥，填完点 **保存** 即刻生效（**不用重启**）：

| 输入框 | 凭据名 | 用途 |
|---|---|---|
| Ark API Key | `ARK_API_KEY` | 图像、视频 |
| 语音 API Key | `VOLCENGINE_SPEECH_API_KEY` | 语音合成、语音识别、音频生成 |

> 两把是**不同产品**的凭据，互不通用：`ark-` 开头的方舟 Key 不能用于语音，
> 语音的 Key 也不能用于图像/视频。

页面行为里有几条是刻意的：

- **密钥只写入不读回**：保存后输入框清空，状态改用「已配置 / 未配置」标记表示。
  写入走 DSH 凭据域（`remote.credentials.set`），明文不出现在任何响应里。
- **留空 = 保持原值，不是清空**。密钥是密文控件、不回显；若把空串当清空，
  每次保存都会误删没动过的另外两把。要清空请直接编辑凭据文件。
- **由环境变量提供的密钥会禁用输入框**并说明原因 —— 那种情况下写文件是无效的
  （环境变量层优先级更高，会遮蔽写入）。
- **不引第三方状态库**：客户端 bundle 每多一个 `require` 就多一个必须声明的
  external，所以页面只用 React + DSH 自带的表单控件
  （`@deepseek-ai/dsh-client-ui-primitives`）。

> **首次装好后要重启一次桌面应用**：客户端半侧（浏览器 bundle）由宿主在启动时扫描并
> 注册到 `/plugins` 路由，之后页面上才会出现那个设置页。密钥本身改完即时生效、无需重启。
> 另：页面注册在 bundle 自己的详情页（`plugins.bundle.config`），不是「官方」分组 ——
> 第三方插件占用官方座位会显示成官方插件。

---

## 安装

本插件是一个 **DSH bundle**（`package.json` 里有 `dsh.bundle.patch`，指向
[`cordis.patch.yml`](cordis.patch.yml)）。安装后它会把自己插进 profile 配置树，
在下次加载该 profile 时挂载。

### 方式一：应用内安装（推荐）

1. 打开 DSH → 侧栏 **插件**
2. 点 **安装**，在「**安装源**」里填入下面任意一个：

```
github:BlankTasftu/DSH-ark
```

```
https://github.com/BlankTasftu/DSH-ark
```

```
git+https://github.com/BlankTasftu/DSH-ark.git
```

3. 安装完成后**重启应用**，工具才会注册到会话里

> 为什么必须重启：工具注册与客户端 bundle 是在启动时组合的。
> 设置页里的密钥保存**不需要**重启（走凭据服务热更新），但工具本身需要。

### 方式二：命令行（装了 DSH CLI 的环境）

```sh
dsh plugin --profile <profile名> add github:BlankTasftu/DSH-ark
# 也接受 install 写法：
dsh plugin --profile <profile名> install https://github.com/BlankTasftu/DSH-ark
```

桌面端（`desktop` profile）由应用独占管理，命令行改完同样需要重启应用。

### 方式三：从源码

```sh
git clone https://github.com/BlankTasftu/DSH-ark.git
cd DSH-ark
npm test          # 169 个用例，不需要网络也不需要密钥
```

本地开发时也可以用绝对路径安装：`dsh plugin --profile <name> add <绝对路径>`。

### 卸载

应用内插件页面移除 `dsh-ark`，或：

```sh
dsh plugin --profile <profile名> remove dsh-ark
```

### 环境要求

- **DSH ≥ 0.2.0-rc.2**（`package.json` 的 `peerDependencies` 绑定了该版本线）
- **Node ≥ 22.19.0**
- 无需任何运行时依赖：插件只用 Node 内置能力 + DSH 宿主已有的 peer 包
---

## 配置

非敏感配置写在 profile 补丁里 `id: dsh-ark` 那一行的 `config` 块（**唯一存储位置**，
DSH 会在运行时按它重建插件实例）。完整默认值见 [`cordis.patch.yml`](cordis.patch.yml)。

### 密钥：用凭据服务，不写进配置文件

配置里只出现**凭据名**，实际值由 DSH 凭据服务（`ctx.credentials`）或同名环境变量提供：

| 凭据名 | 用途 | 从哪来 |
|---|---|---|
| `ARK_API_KEY` | 图像 / 视频（方舟数据面） | 火山方舟控制台 → API Key 管理 |
| `VOLCENGINE_SPEECH_API_KEY` | 语音合成 / 识别 / 音频生成 | 火山引擎控制台 → **语音技术** → API Key 管理 |

> 两把是**不同产品**的凭据，互不通用：`ark-` 开头的方舟 Key 不能用于语音，
> 语音的 Key 也不能用于图像 / 视频。

**怎么把密钥交给 DSH**（三选一，按优先级）：

1. **插件设置页**（推荐）：插件 → 已安装 → dsh-ark 详情页，填完保存即刻生效。
2. **环境变量**：启动 DSH 的进程环境里设置同名变量（`ARK_API_KEY` 等）。
3. **profile 配置里改凭据名**：如果你的密钥已经存在别的名字下，把 `config.ark.credential`
   / `config.speech.apiKeyCredential` 改成那个名字即可。

> **最容易踩的坑**：语音合成**不能**用 `ARK_API_KEY`。方舟的 OpenAI 兼容网关（`/api/v3`）
> 没有公开的 TTS 接口，语音走的是另一套服务（`openspeech.bytedance.com`）与另一套凭据。
> 插件在缺少语音凭据时会直接说明这一点，而不是笼统报"401"。
> 凭据不匹配时，语音服务**仍返回 HTTP 200**，错误藏在 SSE 数据帧的 `code:45000010` 里 ——
> 插件会把这种情况归类为鉴权失败并给出 App ID / Access Token 的核对指引。

### 关键配置项

```yaml
- id: dsh-ark
  config:
    ark:
      baseUrl: https://ark.cn-beijing.volces.com/api/v3
      credential: ARK_API_KEY
      imageModel: doubao-seedream-5-0-pro-260628
      videoModel: doubao-seedance-2-0-260128
      requestTimeoutMs: 300000     # 生成类请求超时
      rateLimitRetries: 2          # 仅限流退避重试，参数错误绝不重试
    speech:
      mode: sse                    # sse（默认）| ndjson
      apiKeyCredential: VOLCENGINE_SPEECH_API_KEY   # 语音唯一凭据（X-Api-Key）
      resourceTts: seed-tts-2.0    # 2.0 代音色
      resourceTtsClone: seed-icl-2.0  # 克隆音色
      resourceTtsV1: volc.service_type.10029  # 1.0 代音色（资源随音色名自动推断）
      resourceAsr: volc.seedasr.sauc.duration
      voice: zh_female_shuangkuaisisi_uranus_bigtts
      format: mp3                  # mp3 | wav | ogg_opus
      sampleRate: 24000
      maxCharsPerRequest: 200      # 超长文本按标点分句后串行合成
    output:
      dir: ark-output              # 产物落盘目录（相对当前工作目录）
      previewRoute: true           # 注册只读本机预览路由 /dsh-ark/asset?id=…
```

---

## 产物怎么拿到

生成类接口返回的直链**24 小时后失效**，所以插件一律把产物下载到工作区：

```
<当前工作目录>/ark-output/20261011003012-一只戴帽子的橘猫-a1b2c3d4.png
```

工具返回值里给的是**工作区相对路径**（可被后续工具读取、可提交、可打包），
外加一个**仅本机可访问**的预览地址 `/dsh-ark/asset?id=<id>`。

预览路由是 fail-closed 的：跨站标记（`Sec-Fetch-Site: cross-site`）、非回环 Host、
Origin 与 Host 不同源、缺 Host —— 一律 403。它只按登记表里的 id 查路径，
不接受外部传入的路径，因此无法被用来读工作区以外的文件。

---

## 设计上刻意做的取舍

| 取舍 | 原因 |
|---|---|
| 计费接口**只有限流才重试** | 参数错误重试 = 重复扣费。生成接口没有幂等键（`--name` 之类都不是服务端幂等键）。 |
| 视频**绝不重复提交** | 提交即计费。超时返回"仍在渲染 + `taskId`"，与失败严格区分；查询走单独的 `action: "status"`。 |
| 本地**视频/音频**默认拒绝内联 | 方舟数据面**直接 400 拒绝**视频/音频的 data URL（实测：`reference_video must be provided as a web url`）。图片则可以内联。 |
| 不提供 `pcm` 音频格式 | PCM 没有容器头，无法参与完整性校验；交付一个无法验证的裸流风险更高。 |
| 工具失败返回**文本**而不是抛异常 | DSH 会把抛异常的工具折叠成通用错误，模型看不到 `request_id` 与修复指引，只能盲目重试。 |
| 尺寸换算**保单边上限** | 方舟的三条尺寸约束（总像素下限 / 单边上限 / 宽高比域）在数学上互斥，必须显式裁决。见契约 §1.1。 |

---

## 开发

```sh
cd "<工作区>\dsh-ark"

# 全量单测（133 个用例，零网络请求）
npm test

# 只读探测真实端点（不计费）
node scripts/smoke.mjs --probe

# 真实端到端（会计费，必须显式 --yes）
$env:ARK_API_KEY="..."
$env:VOLCENGINE_SPEECH_API_KEY="..."
node scripts/smoke.mjs --image --tts --yes

# 也可以直接用命令行脚本（读 DSH 凭据文件，不经宿主）
node scripts/generate.mjs --prompt "一只猫"
node scripts/speak.mjs --text "你好" --voice zh_female_shuangkuaisisi_uranus_bigtts
node scripts/audio.mjs --prompt "用温柔少女嗓音念：你好"
node scripts/transcribe.mjs --audio ark-output/xxx.mp3
```

### 代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：工具注册、凭据接线、产物登记、预览路由与信任校验 |
| `lib/client.js` | **浏览器半侧**：插件设置页（两把密钥的录入/状态/保存） |
| `lib/config.mjs` | 配置规范化 + 凭据解析（DSH 凭据优先，环境变量兜底） |
| `lib/http.mjs` | JSON 请求、限流退避、取消传播、`request_id` 采集 |
| `lib/errors.mjs` | 统一错误模型与状态码/上游码归一 |
| `lib/artifacts.mjs` | 产物落盘、纯手写容器头解析（PNG/JPEG/GIF/WebP） |
| `lib/ark-image.mjs` | Seedream 图像生成 + 尺寸换算 |
| `lib/ark-video.mjs` | Seedance 异步视频任务（轮询 / 单次查询两种模式） |
| `lib/volc-tts.mjs` | 语音合成（流式解析、分句、交付校验、资源 id 随音色推断） |
| `lib/volc-audio.mjs` | SeedAudio 1.0 音频生成（按描述生成音频 / 参考素材） |
| `lib/volc-asr.mjs` | 录音文件识别极速版（转写 + 毫秒级分句时间戳） |

### 测试布局

| 文件 | 覆盖 |
|---|---|
| `tests/core.test.mjs` | 错误归一、容器头解析、配置与凭据解析 |
| `tests/ark-image.test.mjs` | 尺寸换算、参考图、两条产物路径、退避重试 |
| `tests/ark-video.test.mjs` | 提交体映射、轮询、超时语义、素材校验 |
| `tests/video-once.test.mjs` | 单次查询模式（查一次 + 落盘、零提交） |
| `tests/volc-tts.test.mjs` | 分句、结束标记 `20000000`、交付校验、错误码映射、资源 id 随音色推断 |
| `tests/volc-audio.test.mjs` | 音频生成：请求体组装、参考素材规则、真实容器判定、200+code 报错 |
| `tests/volc-asr.test.mjs` | 路径/凭据构件与 `NOT_IMPLEMENTED` 语义 |
| `tests/plugin.test.mjs` | 工具注册契约、失败语义、预览路由信任校验与 URL 往返 |
| `tests/path-escape.test.mjs` | **安全回归**：junction/符号链接逃逸必须被拒且零请求 |
| `tests/encoding-guard.test.mjs` | **编码/结构守卫**：防 mojibake 与"注释吞换行"重演 |
| `tests/client.test.mjs` | **浏览器半侧契约**：bundle 形状、external 白名单、设置页注册、`dsh.client` 声明 |

> 单测通过 `--import ./tests/stub-dsh-loader.mjs` 把 `@deepseek-ai/dsh-tools` 换成最小桩，
> 这样插件入口能在仓库内被真实加载并驱动，而不必把宿主包复制一份进来（避免版本漂移）。
> 桩只替换**这一个**模块，其余解析失败照常暴露。

### 文档

- [`docs/ARK-API-CONTRACT.md`](docs/ARK-API-CONTRACT.md) —— 已核实的接口契约（含实测证据与踩坑点）
- [`docs/MODULE-INTERFACES.md`](docs/MODULE-INTERFACES.md) —— 模块接口（冻结）
- [`docs/VERIFICATION-REPORT.md`](docs/VERIFICATION-REPORT.md) —— 独立验证报告（对抗式审查，含未覆盖范围）
- [`docs/AUDIT-SUMMARY.md`](docs/AUDIT-SUMMARY.md) —— 安全审计结论文摘要（密钥泄露 / 隐私 / 安全 / 无用代码）
- [`docs/AUDIT-INDEPENDENT.md`](docs/AUDIT-INDEPENDENT.md) —— 独立对抗式安全审计

---

## 已知限制

1. **模型 ID 会过期，且报错与"没开通"分不清** —— 已下线（Retiring/Shutdown）的模型 ID
   调用返回 `HTTP 404 InvalidEndpointOrModel.NotFound`，与"没有权限"是**同一个错误码**。
   换模型前请先查 `GET /api/v3/models` 的 `status`。本机账号实测**可用**的生图模型：

   | 模型 ID | 说明 |
   |---|---|
   | `doubao-seedream-5-0-pro-260628` | 默认值，质量最好 |
   | `doubao-seedream-5-0-flash-260915` | 更快更便宜 |
   | `doubao-seedream-4-0-20260415` | 上一代 |

   注意 `doubao-seedream-5-0-260128`（无 `-pro`/`-flash` 后缀）当前是 **Retiring**，不要用。
2. **ASR 未实现**（`NOT_IMPLEMENTED`）—— 需真实凭据跑通握手后补完。
3. **Ark 侧语音凭据通道未验证** —— 是否真能走通尚未确认，主通道是火山「语音技术」。
4. **`40000000` / `40000001` 等语音错误码未逐一映射** —— 只映射了实测过的 `45000010`（凭据不匹配）；
   其它码原样带上上游 message，不猜测语义。
5. **视频任务进度需人工轮询** —— 没有后台任务跟踪；`action: "status"` 是单次查询。
6. **`ark-output` 不做清理** —— 产物会持续累积，需要自行清理。

## License

MIT
