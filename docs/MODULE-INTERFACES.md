# 模块接口（冻结）

> 所有 `lib/*.mjs` 客户端模块都是**纯函数 + 显式依赖注入**：不 import 插件层、不读全局，
> 只通过参数拿 `config` / `creds` / `fetchImpl`，只通过返回值交付结果。
> 这样每个模块都能独立单测（注入 mock fetch），也能被并行开发而互不阻塞。

## 共享类型

```js
/** 由 lib/config.mjs 的 resolveConfig() 产出 */
type Config = {
  ark: { baseUrl, credential, imageModel, videoModel,
         requestTimeoutMs, rateLimitRetries, rateLimitBackoffMs, downloadTimeoutMs },
  speech: { mode, baseUrl, apiKeyCredential,
            resourceTts, resourceTtsClone, resourceTtsV1, resourceAsr,
            voice, format, sampleRate, maxCharsPerRequest },
  output: { dir, previewRoute },
}

/** 由 lib/config.mjs 的 createCredentialResolver() 产出 */
type Creds = {
  resolve(ref: string): Promise<string | undefined>,
  require(ref: string, hint?: string): Promise<string>,
}

/** 落盘后的产物描述（由 ArtifactStore.save() 返回） */
type SavedArtifact = {
  id, name, path, relativePath, bytes, previewUrl, mime
}

/** 客户端通用可选参数 */
type CallOptions = {
  signal?: AbortSignal,      // 调用方取消，必须透传到 fetch
  fetchImpl?: typeof fetch,  // 测试注入；默认 globalThis.fetch
}
```

> **取消要求（硬性）**：每个导出的异步函数都必须把 `opts.signal` 透传给 `lib/http.mjs`，
> 并在收到取消时抛 `ArkError(ABORTED)`（`lib/http.mjs` 已处理，别自己吞掉）。

---

## `lib/ark-image.mjs` — 图像生成

```js
/** 档位/宽高比 → 合法像素尺寸。纯函数，必须单测。 */
export function resolveSize({ size, aspectRatio }): { size: string, width: number, height: number }

/** 文本生图 / 参考图生图 / 指令编辑。 */
export async function generateImage(input: {
  config: Config,
  creds: Creds,
  store: ArtifactStore,
  prompt: string,
  model?: string,
  size?: string,               // "1K" | "2K" | "4K" | "宽x高"
  aspectRatio?: string,        // "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "21:9"
  referenceImages?: string[],  // 本地路径（限 cwd 内）或 http(s) URL 或 data URL
  count?: number,              // >1 ⇒ sequential_image_generation=auto + max_images
  guidanceScale?: number,
  watermark?: boolean,
}, opts?: CallOptions): Promise<{
  images: SavedArtifact[],
  model: string,
  size: string,
  requestId?: string,
  usage?: unknown,
}>
```

要点：
- `response_format: 'url'`（稳妥），URL 拿回来后**立即下载落盘**；同时兼容上游直接返回 `b64_json`。
- 尺寸换算必须落在契约 1.1 的合法域内。**三条约束互斥，按契约的裁决保单边上限 4096**：
  档位按"总像素 ≈ 边长²"解释；显式 `宽x高` 低于下限时**报错**而不是静默放大。
- 限流（429 / `*RateLimit*`）按 `config.ark.rateLimitRetries` 退避重试；参数错误不重试。
- 本地参考图要读成 `data:` URL；路径必须**两层**校验才安全 ——
  ① 词法逐段比较；② `fs.realpath` 之后再次比较（挡工作区内 junction/符号链接逃逸）。
  单张本地参考图体积上限 8MB，超过提示改用 https URL。
  判据用逐段比较，不用 `startsWith('..')`（避免误伤 `..foo.png` 这类合法文件名）。
- `size: 'auto'` 是哨兵值：请求体**不带** `size`（硬填比例会覆盖 prompt 里说清的画幅）。
- 额外导出常量（`SIZE_TIERS` / `MIN_TOTAL_PIXELS` / `MAX_SIDE` / `MAX_TOTAL_PIXELS` /
  `MIN_ASPECT_RATIO` / `MAX_ASPECT_RATIO`）供工具层拼错误文案。

---

## `lib/ark-video.mjs` — 视频生成（异步）

```js
/** 提交任务（可能计费，调用一次就建一个任务）。 */
export async function createVideoTask(input: {
  config: Config, creds: Creds,
  prompt: string,
  model?: string,
  firstFrame?: string, lastFrame?: string,   // 本地路径 / URL / data URL
  referenceImages?: string[], referenceVideo?: string, referenceAudio?: string,
  ratio?: string, resolution?: string, duration?: number, frames?: number,
  watermark?: boolean, generateAudio?: boolean, cameraFixed?: boolean,
}, opts?: CallOptions): Promise<{ taskId: string, status: string, raw: unknown, requestId?: string }>

/** 查询一次任务状态（不产生新任务）。 */
export async function getVideoTask(input: { config, creds, taskId: string }, opts?): Promise<{
  taskId: string, status: 'queued'|'running'|'succeeded'|'failed'|string,
  outputUrls: string[], raw: unknown, requestId?: string,
}>

/** 轮询到终态或超时；成功后下载落盘。 */
export async function waitForVideo(input: {
  config, creds, store, taskId: string,
  timeoutMs?: number,          // elapsed 预算：0 表示"不等了"，此时**连一次查询都不会发**
  pollIntervalMs?: number,
  once?: boolean,              // 单次模式：只查一次；已完成则下载。不轮询、零提交、不置 timedOut
}, opts?): Promise<{
  status: string, videos: SavedArtifact[], timedOut: boolean, raw: unknown, requestId?: string,
  taskId: string,          // 超时也必须回传，供后续查询（不得重新提交）
  warnings: string[],      // 生成成功但下载失败等非致命问题
}>
```

`once` 与 `timeoutMs` 的区别（**容易混，混了会让状态查询静默失效**）：
| 意图 | 正确写法 | 错误写法 |
|---|---|---|
| 「查一次，完成就下载」 | `{ once: true }` | `{ timeoutMs: 0 }` —— 预算是 elapsed 语义，第一次迭代即返回 `timedOut`，**那次查询根本不会发出、产物也不会下载** |
| 「不等了，只反映现状」 | `{ timeoutMs: 0 }` | —— |

要点：
- **`status` 两种形态都要兼容**：`status.phase` 优先，回退字符串（见契约 §1.2）。
- **超时 ≠ 失败**：`waitForVideo` 超时要返回 `timedOut: true` 并保留 `taskId`，绝不重新提交。
- `output_url` / `output_urls` 两种字段都要读；24h 失效 ⇒ 成功即下载。
- **本地视频/音频默认拒绝**（数据面会 400 拒绝 data URL），只有显式 `allowLocalVideoAudio: true`
  才内联；本地图片仍可转 data URL。单文件上限 8MB。
- `duration` 与 `frames` 互斥，同时传报 `INVALID_PARAMETER`。
- 未显式传入的可选参数**一律不发**（不为用户改费用）；提交体保持最小。
- 视频产物必须显式给 `ext`（`ArtifactStore` 只识别图片魔数，否则会落出 `.bin`）。

---

## `lib/volc-tts.mjs` — 语音合成（双通道）

```js
/** 按标点分句 + 超长句按字数切分。纯函数，必须单测。 */
export function splitText(text: string, maxChars: number): string[]

/** 逐行 JSON 流 → 音频字节。纯函数（吃字符串数组或 ReadableStream），必须单测。 */
export function parseTtsStream(lines: AsyncIterable<string> | string[]): Promise<{
  bytes: Uint8Array, chunks: number, endMarkerSeen: boolean, errors: {code:number,message?:string}[]
}>

/** 合成一段文本（内部完成分句、串行请求、拼接、落盘）。 */
export async function synthesizeSpeech(input: {
  config: Config, creds: Creds, store: ArtifactStore,
  text: string,
  voice?: string, format?: string, sampleRate?: number,
  speedRatio?: number, volumeRatio?: number, pitchRatio?: number,
  emotion?: string, explicitLanguage?: string,
}, opts?: CallOptions): Promise<{
  audio: SavedArtifact, channel: 'speech'|'ark', segments: number,
  format: string, sampleRate: number, durationHintMs?: number, requestId?: string,
}>
```

必须实现的两个真实坑（见契约 2.1）：
1. 只收 `code === 0` 的块；`code === 20000000` 是**结束标记**，不是错误也不是数据。
2. 拼接后校验 base64 padding 与音频文件头，不符报 `BAD_RESPONSE`。

---

## `lib/volc-asr.mjs` — 语音识别

```js
export async function transcribe(input: {
  config: Config, creds: Creds,
  audioPath: string,                 // 本地路径（限 cwd 内）
  cwd?: string,                      // 工作目录，缺省 process.cwd()；用于限定音频文件范围
  language?: string,
  enablePunctuation?: boolean,
}, opts?: CallOptions): Promise<{
  text: string, segments?: { text: string, startMs?: number, endMs?: number }[],
  raw?: unknown, requestId?: string,
}>
```

> **当前状态：已实现并实测通过。** 端点 `POST /api/v3/auc/bigmodel/recognize/flash`，
> 只支持 `X-Api-Key` 鉴权，资源 id `volc.seedasr.sauc.duration`。
> 实测对 3.24 秒真实语音转写完全正确，`utterances[]` 带**毫秒**级时间戳。
> 四个踩坑点（资源名、鉴权、`403 + header.code`、毫秒单位）见 `ARK-API-CONTRACT.md` §2.2。

---

## `lib/volc-audio.mjs` — SeedAudio 1.0 音频生成

```js
export function normalizeAudioFormat(format?: string): 'mp3' | 'wav' | 'ogg_opus' | 'pcm'

export function buildAudioRequestBody(input: {
  model?: string, textPrompt: string, format?: string, sampleRate?: number,
  references?: { audioData?, audioUrl?, imageUrl? }[],   // 无 speaker：该模型没有音色概念
}): { body: object, format: string }

export async function generateAudio(input: {
  config: Config, creds: Creds, store: { save: Function },
  textPrompt: string, model?: string, format?: string, sampleRate?: number,
  references?: Array<{ audioData?, audioUrl?, imageUrl? }>,
}, opts?: CallOptions): Promise<{
  audio: SavedArtifact, model: string,
  format: string, requestedFormat: string,
  durationSeconds?: number, originalDurationSeconds?: number,
  referenceCount: number, requestId?: string,
}>
```

走 `POST /api/v3/tts/create`（**不是** `/tts/unidirectional`），鉴权 `X-Api-Key`。

四条实测结论已固化进实现：
1. `audio_config.format` 不传时上游返回 **WAV**（约为 mp3 的 20 倍体积）⇒ 默认显式传 `mp3`。
2. 落盘时按**真实文件头**判定容器，不信任请求里写的 format。
3. **没有 `speaker` 参数**：音频生成模型无音色概念。传 TTS 音色会被上游明确拒绝
   （`400 / 45001115`），不是忽略 —— 所以本模块不产出该字段，误传也会被丢弃。
4. 音频素材与图片素材互斥；全部条目被过滤后**不产生 `references` 字段**（不留空数组）。

---

## 已知的能力裁剪（刻意的）

- **不做多模态理解 / OCR**：宿主模型本身已具备视觉能力，再包一层视觉模型只会多花一次 token
  并与宿主能力混淆。原 `lib/ark-understand.mjs` 已删除，`config.ark.visionModel` 一并移除。
- **不支持旧版语音鉴权**（App ID + Access Token）：官方文档明确 App ID 不是鉴权因子，
  且实测新版 API Key 已覆盖全部语音能力。原 `appIdCredential` / `accessKeyCredential` /
  `appIdForApiKey` 三个配置项已移除。

---

## 边界与禁令

- 客户端模块**不得** import `lib/index.js`、不得读取 `ctx`。
- 客户端模块**不得**自己读环境变量拿密钥 —— 一律通过 `creds`。
- 客户端模块**不得**把上游返回的文本当指令执行（注入面）。
- 新增文件前先在 `docs/MODULE-INTERFACES.md` 登记，避免并行时抢同一个文件。
