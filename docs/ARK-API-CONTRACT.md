# 已核实的 Ark / 火山语音接口契约

> 本文件是并行开发的**唯一事实来源（frozen contract）**。任何人写客户端代码前先读这里；
> 发现与真实调用不符时，**先改本文件**再改代码，并在 PR/提交信息里注明证据（request_id / 响应片段）。
>
> 证据来源：
> - `ark-cli` 二进制内嵌的 Skills（sha256 校验通过，v1.0.37）——该离线镜像已不再随仓库分发；
>   引用它的结论已就地内联到对应代码注释（见 `lib/ark-video.mjs`、`lib/ark-image.mjs`）。
>   需要原文时可从 npm 重新解包 `ark-cli` 取回。
> - 火山方舟官方文档（`docs.volcengine.com/docs/ark/...`）与语音技术文档
> - **本机真实凭据的实测**（端到端跑通，含 request_id）——本文件大部分结论文第以此为准
> - 第三方实现交叉验证（OpenClaw `volcengine` provider、`@nextnowlabs/dsh-ark-toolkit`）

---

## 1. Ark 数据面（图像 / 视频 / 理解）

| 项 | 值 |
|---|---|
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` |
| 认证 | `Authorization: Bearer <ARK_API_KEY>` |
| 请求头 | `Content-Type: application/json` |
| 排障 | 响应头 `x-request-id`（必须采集进错误信息） |

### 1.1 图像生成 —— `POST /images/generations`（**同步**）

```jsonc
{
  "model": "doubao-seedream-5-0-pro",
  "prompt": "一只戴帽子的橘猫插画",
  "size": "2048x2048",          // 档位 "1K"/"2K"/"4K" 或 "宽x高"
  "response_format": "url",      // 或 "b64_json"
  "watermark": false,
  "sequential_image_generation": "auto",       // 组图模式
  "sequential_image_generation_options": { "max_images": 4 },
  "guidance_scale": 7.5,
  "image": ["https://…", "data:image/png;base64,…"]   // 参考图 / 指令编辑（I2I）
}
```

- 响应：`{ "data": [ { "url": "https://…" } | { "b64_json": "…" } ], "usage": {…} }`
- 同步返回，**没有任务轮询**。

#### 尺寸语义（三条约束互相制约，实现必须显式裁决）

方舟对 `size` 同时施加三个约束，它们**在数学上不可能同时满足**，因此必须明确优先顺序：

| 约束 | 值 |
|---|---|
| 总像素下限 | ≈ 3,686,400（= 2560x1440） |
| 单边上限 | 4096 |
| 宽高比域 | `[1/16, 16]` |

反例：比例 `16:1` 时，受单边上限约束的最大面积只有 `4096x256 = 1,048,576 < 下限`。
同时满足三者的比例带实际是 `[3,686,400/4096², 4096²/3,686,400] ≈ [0.2197, 4.5511]`，即约 `[1:4.55, 4.55:1]`。

**裁决（本插件采用）**：**保单边上限**（否则请求必被 400），极端比例下允许总面积低于下限，
并在返回结果与注释里写明实际落到的尺寸。`aspectRatio` 参数的**建议**取值域因此是
`[1:4.55, 4.55:1]`；超出该域仍会尽力生成，但比例会被单边上限压掉。

**档位口径**：`1K/2K/4K` 按"总像素 ≈ 边长²"解释（1K=1024²、2K=2048²、4K=4096²），
换算后再按上表钳制。因此 `2K + 16:9` 落到 `2731x1536`（整数像素，不做 8/16 对齐魔法），
`1K + 1:1` 触底放大为 `1920x1920`，`1K + 16:9` 为 `2560x1440`（正好等于实测下限）。
`4K + 16:9` 的总像素虽在上限内，但长边会到 5461，**必须主动缩到 `4096x2304`**。

**显式 `宽x高`**：低于下限时**报错**（`INVALID_PARAMETER`，提示改用 `1920x1920` 起），
不静默改用户点名的像素——静默改写会让"我明明要 1024 你却给我 2048"变成无迹可寻的扣费。
`size: 'auto'` 是哨兵值：请求体**不带** `size` 字段，交由网关按内容自决（硬填 `1:1` 会覆盖
prompt 里说清的画幅）。

**其他已知边界**：`sequential_image_generation_options.max_images` 上限官方未公布，
实现只校验"≥1 的整数"，并如实返回上游**实际**给到的张数（可能少于 `max_images`）。

### 1.2 视频生成 —— 异步任务

- 提交：`POST /contents/generations/tasks`
- 查询：`GET /contents/generations/tasks/{id}`

```jsonc
// 请求体（content 数组是核心：文本 + 首帧/尾帧/参考图/参考视频/参考音频）
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    { "type": "text", "text": "一只柴犬在樱花树下奔跑，慢镜头" },
    { "type": "image_url", "image_url": { "url": "https://… 或 data:image/…;base64,…" }, "role": "first_frame" }
  ],
  "ratio": "16:9",              // 或 "adaptive"
  "resolution": "720p",         // 480p / 720p / 1080p
  "duration": 5,                // 秒
  "frames": 121,                // 支持时覆盖 duration
  "watermark": false,
  "generate_audio": false,
  "camera_fixed": false
}
```

- 响应（提交与查询同构）：
  - `{ "id": "cgt-…", "status": "queued|running|succeeded|failed", "output_url": "…", "output_urls": ["…"], … }`
  - **`status` 有两种形态，实现必须都兼容**：既有字符串（`"succeeded"`），也有对象
    `{ "status": { "phase": "succeeded", "message": "…" } }`。ark-cli 的 Skill 明确警告
    「直接读 `.status` 会导致终态永远匹配不上」⇒ **取 `status.phase` 优先，回退字符串**。
  - 同样地，产物字段**两种都在用**：`output_url`（单数）与 `output_urls`（数组），都要读。
- **`output_url` 是 TOS 预签名 URL，24 小时后失效** ⇒ 拿到即下载落盘，不要只回传 URL。
- **`status` 非 `succeeded` 就不是失败**：`queued`/`running` 要继续轮询，**绝不重新提交**
  （会另建计费任务）。超时要能与失败区分开：返回「仍在跑 + taskId」，不是报错。
- **`duration` 与 `frames` 互斥**：`frames` 在支持的模型上覆盖 `duration`；两者同时传应报
  `INVALID_PARAMETER`（时长直接决定费用，不能替用户猜，也不能静默丢弃）。
- **素材内联的真实边界（实测结论，很反直觉）**：
  - **图片**的 data URL 内联**可用**；
  - **视频 / 音频**的 data URL 被数据面**直接 400 拒绝**（`reference_video must be provided as a web url`），
    本地文件必须先上传 TOS 换成可公网访问的 URL。所以本地视频/音频**默认拒绝**并提示改用 URL，
    只有显式开启内联开关才尝试。
- 提交与查询是两个不同动作，工具层要能把任务 id 落下来供后续查询。

### 1.3 多模态理解 / OCR / 文档抽取 —— **本插件不实现**

`POST /chat/completions`（OpenAI 兼容）本可做看图问答 / OCR / 字段抽取，但**本插件不做**：

**宿主模型自身已具备视觉能力**，再包一层视觉模型只会多花一次 token，
并且容易让调用方分不清"该用宿主能力还是该用插件工具"。所以原 `ark_understand` 工具
与 `lib/ark-understand.mjs` 已删除，`config.ark.visionModel` 一并移除。

> 需要看图/OCR 时直接用宿主模型的多模态能力即可，不必绕道插件。
> 这里保留本节仅为记录——**如果将来要恢复该能力，端点与字段口径如上所述**。

---

## 2. 火山「语音技术」通道（TTS / ASR / 音频生成）

| 项 | 值 |
|---|---|
| Base URL | `https://openspeech.bytedance.com/api/v3` |
| 认证 | **只用 `X-Api-Key`**（唯一方案；旧版 App ID + Access Token 已移除） |
| 资源 | `X-Api-Resource-Id`：`seed-tts-2.0`（2.0 代音色）/ `seed-icl-2.0`（声音克隆）/ `volc.service_type.10029`（1.0 代音色）/ `volc.seedasr.sauc.duration`（ASR） |
| 排障 | 响应头 `X-Tt-Logid`；响应体的数据帧里还有 `reqid` |

### 2.0 鉴权：只用 API Key（实测确认后收敛到一条路）

官方文档（[API Key 使用](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage)）明确：
**`X-Api-Key` 是鉴权因子，`X-Api-App-Id` 只是"请求/应用配置"**。

实测（同一端点、同一音色、同一文本）：

| 组合 | 结果 |
|---|---|
| `X-Api-Key` = 语音 API Key | ✅ 成功（TTS / ASR / 音频生成三项全部可用） |
| `X-Api-Key` = 旧版 Access Token | ❌ `45000010 Invalid X-Api-Key` |
| `X-Api-Key` = App ID | ❌ 同上 |
| 旧版双头（App-Id + Access-Key） | TTS 可用，但 ASR / 音频生成直接 `45000000 resourceId is not allowed` |

**结论：旧版 App ID + Access Token 是另一套凭据，已被整体移除。**
理由有三条，任一条都足以删掉它：
1. 官方定位上 App ID 根本不是鉴权因子；
2. 实测 API Key 已覆盖本插件所需的**全部**语音能力（TTS 2.0 / ASR 极速版 / SeedAudio 1.0）；
3. 留着两套会让配置面变复杂，并制造"填了 App ID 却不通"的困惑（错误文案还容易被误读成没开通）。

因此实现里**只发 `X-Api-Key`** —— 连可选的 `X-Api-App-Id` 都不带，少一个头就少一处填错空间。

### 2.1 流式语音合成（默认通道）

> **本节的端点、请求头与请求体已用真实端点探测确认**（2026-10-10，本机直连）：
> 端点 `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse` 携带
> `X-Api-Resource-Id: seed-tts-2.0` 与下述请求体，
> 返回 `HTTP 200` + `Content-Type: text/event-stream`，帧形如：
>
> ```
> event: 153
> data: {"reqid":"306558fd-…","code":45000010,"message":"load grant: requested grant not found in SaaS storage"}
> ```
>
> 即：**鉴权头与请求体形态正确**；凭据无效时以 `code:45000010` 在数据帧里报错（不是 HTTP 4xx）。
> 注意 `code` 是**响应体字段**，且**响应体自带 `reqid`**（排障关联 id，不能只指望 `X-Tt-Logid` 响应头）。

#### `seed-audio-1.0` 不是资源 id，而是**另一个模型**（重要澄清）

`seed-audio-1.0` 常被误当成 `X-Api-Resource-Id` 去试（本插件此前也走过这个弯路），
它实际是**「音频生成」**（Audio Generation）API 的 `model` 名，走**不同端点**：

```
POST https://openspeech.bytedance.com/api/v3/tts/create
{ "model": "seed-audio-1.0", "text_prompt": "…", "references": [...], "audio_config": {...} }
```

- 鉴权同样用 `X-Api-Key`
- 能力：从自然语言提示 / 参考音频（≤3 条，每条 ≤30s、≤10MB）/ 参考图生成音频，上限 120 秒
- 用途：有声书、配音、音效、氛围音 —— 它**不是**"用某个音色念一句话"（**没有音色参数**）
- 因此把 `SeedAudio1.0` 当语音资源去找注定失败（实测该账号对 `SeedAudio1.0` /
  `seed-audio-1.0` / `volc.service_type.<编号>` 全部返回 `45000030 not granted`）

**状态：已实现并实测通过**（`lib/volc-audio.mjs`，工具 `ark_generate_audio`）。
下面是实测确认的口径。

#### 请求

```
POST https://openspeech.bytedance.com/api/v3/tts/create
X-Api-Key: <api-key>          ← 只支持新版鉴权；旧版 App ID+Token 不适用
X-Api-Request-Id: <trace-id>  ← 可选，便于对账
Content-Type: application/json
```

```jsonc
{
  "model": "seed-audio-1.0",
  "text_prompt": "用温柔清澈的少女嗓音，轻快而愉快地说出这句话：你好呀！……",
  "audio_config": { "format": "mp3", "sample_rate": 24000 },   // 见下方"格式"注意点
  "references": [ { "audio_url": "https://…" } ]               // 可选
}
```

- `text_prompt` 语义随 `references` 变化：无参考=描述要生成什么声音；有音频参考=可用
  `@音频1`/`@音频2`/`@音频3` 指代（按顺序编号）；有图片参考=只能是"要念出来的文本"
- 参考音频：最多 3 条、每条 ≤30 秒 / ≤10MB，格式 wav/mp3/pcm/ogg_opus
- 音频素材与图片素材**不能混用**（官方限制）

#### ⚠️ 这个模型**没有音色参数**（实测结论，容易误用）

`seed-audio-1.0` 是**音频生成**模型，**没有"音色"这个概念** —— 不能"选一个音色来念台词"，
那是 TTS（`ark_speak`）的事。影响生成结果只有两条路：

1. 在 `text_prompt` 里**用文字描述**声音（如"温柔清澈的少女嗓音"）；
2. 给 `references` 传参考素材（音频 / 图片 / 视频），让模型照着参考生成。

`references` 每个条目的合法字段（来自上游报错原文，**必须且只能给一个**）：

```
speaker / audio_data / audio_url / image_data / image_url / video_url
```

这里的 `speaker` 指"已注册进 `speaker_map` 的音色（TTS 音色或克隆音色）"，
**不是任意音色字符串**。把 TTS 音色 ID 当参数传进来，上游会**明确拒绝而不是忽略**：

```
HTTP 400  code=45001115
speaker xxx not found in speaker_map, speaker_audio, or mega_info
```

**为什么这条必须写进文档**：本插件最初就给 `ark_generate_audio` 加了 `speaker` 参数
（想当然地以为"与 TTS 共用音色"），实测才发现是误用。现在该参数已从工具、模块、脚本中
全部移除 —— 静默带一个必然报错的字段，比不传更糟（用户会以为音色设置生效了）。

#### 字段校验行为（实测，决定排障思路）

| 行为 | 实测结果 |
|---|---|
| 未知字段（`foo`、`audio_config.nope`） | **静默忽略**，HTTP 200 |
| 已知字段取值非法（`format: "bogus"`） | `HTTP 500 code=55001309` |
| `model` 不存在 / 用 TTS 的模型名 | `HTTP 403 code=45000030` |
| `references[0]` 为空对象或给了多个字段 | `HTTP 400 code=45001001` |
| `references[]` 里的 `speaker` 未注册 | `HTTP 400 code=45001115` |
| 同一 prompt 多次生成 | **结果内容不同**（有随机性；字节数可能相同，但 sha256 不同） |

最后一条很重要：**"两次输出一样"从来不是"参数没生效"的证据**，反过来也一样。
判断参数是否被接受，要看**报错**，不要看输出是否变化。

#### 响应（实测）

```jsonc
{
  "audio": "<base64>",        // 音频本体（直接可用，不必再下载）
  "duration": 5.08,           // 计费时长（秒）
  "original_duration": 5.08,
  "url": "https://lf26-speech-sign.bytednsdoc.com/…"   // 临时直链，上游只保 2 小时
}
```

同时给了 base64 与临时 URL ⇒ 照插件惯例**解码落盘**，不回传临时直链。

#### `audio_config.format` 的实测注意点

| 请求 | 实际容器 | 3 秒音频的体积 |
|---|---|---|
| 不传 `audio_config` | **WAV** | ~544 KB |
| `format: "mp3"` | MP3（ID3） | ~26 KB |
| `format: "wav"` | WAV（RIFF） | ~296 KB |
| `format: "ogg_opus"` | OGG（OggS） | ~27 KB |

**不传时默认是 WAV，不是 mp3** —— 与"默认 mp3"的直觉相反，体积约 20 倍。
因此本插件默认显式传 `mp3`，并且**落盘时按真实文件头判定容器**，不信任请求里写的 format。

- 端点（二选一，配置项 `speech.mode` 决定）：
  - `sse`（默认）：`POST /tts/unidirectional/sse`，`Accept: text/event-stream`，帧为
    `event: <n>` + `data: {json}` 两行一组（解析器按行取 `data:` 之后的 JSON 即可）
  - `ndjson`：`POST /tts/unidirectional`，每行一个 JSON
- 两种模式的**载荷与数据块结构一致**，解析器应当共用一套「逐行 JSON → 取 `code===0` 的 `data`(base64) → 拼接」逻辑。

```jsonc
{
  "user": { "uid": "dsh-ark" },
  "req_params": {
    "text": "要合成的文本",
    "speaker": "zh_female_shuangkuaisisi_uranus_bigtts",
    "speed_ratio": 1.0,          // 语速
    "volume_ratio": 1.0,         // 音量
    "pitch_ratio": 1.0,          // 音调（部分音色支持）
    "emotion": "happy",          // 情感（部分音色支持）
    "audio_params": { "format": "mp3", "sample_rate": 24000 },
    "additions": "{\"explicit_language\":\"zh\"}"   // 克隆音色**必需**，否则 400「语言不支持」
  }
}
```

#### 2.4 `X-Api-Resource-Id` 必须跟着**音色**走（实测踩坑点）

语音服务把"音色"和"资源"绑在一起校验。**配错的症状极具误导性**：

```
HTTP 200
{"code": 55000000, "message": "resource ID is mismatched with speaker related resource"}
且没有任何音频数据
```

注意它是 **HTTP 200**，错误藏在数据帧里，而且文案容易被读成"这个音色不存在"或
"账号没开通这个音色"（实测：给 `zh_female_roumeinvyou_emo_v2_mars_bigtts` 配
`seed-tts-2.0` 就会这样）。所以**不能把资源 id 写死**，要按音色名推断：

| 音色名特征 | 资源 id | 说明 |
|---|---|---|
| `S_` / `clone_` 开头 | `seed-icl-2.0` | 声音克隆 |
| 含 `uranus` | `seed-tts-2.0` | **2.0 代**音色（绝大多数 `*_uranus_bigtts` 与 `ICL_uranus_*_tob`） |
| 含 `_bigtts`（且不含 uranus） | `volc.service_type.10029` | **1.0 代**音色（如 `*_emo_v2_mars_bigtts`） |
| 认不出 | 回落到配置默认 | 宁可让上游报错，也不要瞎猜资源 |

实现见 `lib/volc-tts.mjs` 的 `resourceForVoice()`，回归用例见
`tests/volc-tts.test.mjs`。可用 `config.speech.resourceTts / resourceTtsClone /
resourceTtsV1` 覆盖。

**音色从哪查**：官方「在线音色列表」是 JS 渲染页面，抓取不到表格；可用的镜像整理版见
[ark-tts/references/voices.md](https://github.com/franklu0819-lang/agent-skills/blob/main/ark-skills/ark-tts/references/voices.md)
（200+ 音色，含"可爱女生 / 甜美娇俏 / 元气甜妹 / 软萌糖糖"这类角色音色）。
注意 `*_uranus_bigtts` 是 2.0 代、`*_mars_bigtts` 是 1.0 代，两者资源不同。

**响应解析的硬性要求（有两个真实踩坑点）：**

1. **结束标记是 `code === 20000000`，不是 0。** 只收集 `code === 0 && data` 的块；
   把 `code !== 0` 一律当结束会**丢掉最后一段音频**。
2. **完整性判据要选对（否则会误伤完整音频）。**
   - **不可靠判据**：合并后的 base64 是否以 `=`/`==` 结尾。padding 只取决于总字节数 `% 3`，
     音频字节数正好是 3 的倍数时**本来就没有 padding**（约 1/3 概率）⇒ 按此判决会误杀。
   - **可靠判据**：流里是否出现结束标记 `code === 20000000`。服务端正常收尾才会发它。
   - 裁决：**见到结束标记即认定流完整**（跳过 padding 判据）；**未见结束标记**才把
     padding 缺失 + 文件头不可识别当作截断证据。容器头认不出但流已完整时，只降级为
     `warnings`，不阻断交付（不编造假格式，按二进制兜底并如实回报）。
   - 必须校验的音频文件头：`49 44 33`（ID3）/ `ff f3` / `ff fb`（MP3 帧同步）/
     `52 49 46 46`（RIFF/WAV）/ `4f 67 67 53`（OggS）。`pcm` 没有容器头，因此
     **不提供 `pcm` 格式**（无法参与完整性校验，交付不可验证的裸流风险更高）。
3. 长文本：单次请求有长度上限（官方建议 ≤200 字符）⇒ **按标点分句**（`。？！；，.?!;,\n`），
   超长句再按字数切，逐句串行合成后**按字节序拼接**（同格式同采样率下可直接 concat）。

### 2.2 语音识别（ASR）—— 录音文件识别极速版（**已实测实现**）

**端点**（实测确认存在；`/api/v3/asr/*` 下的一切路径都是 404）：

```
POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
X-Api-Key: <api-key>                                  ← 只支持新版鉴权
X-Api-Resource-Id: volc.seedasr.sauc.duration
X-Api-Request-Id: <trace-id>
Content-Type: application/json
```

```jsonc
{
  "user": { "uid": "dsh-ark" },
  "audio": { "format": "mp3", "data": "<base64>" },   // 也支持 { "url": "https://…" }
  "request": { "model_name": "bigmodel", "enable_itn": true, "enable_punc": true }
}
```

**实测响应**（对 3.24 秒的真实语音，转写结果完全正确）：

```jsonc
{
  "audio_info": { "duration": 3240 },                 // 毫秒
  "result": {
    "text": "你好呀！喜欢我送给你的礼物吗？",
    "utterances": [
      { "text": "你好呀！", "start_time": 330, "end_time": 930,
        "words": [ { "text": "你", "start_time": 330, "end_time": 490 } ] },
      { "text": "喜欢我送给你的礼物吗？", "start_time": 1410, "end_time": 3010 }
    ]
  }
}
```

**四个实测踩坑点**（全部写进 `lib/volc-asr.mjs` 注释与用例）：

1. **资源 id 必须是 `volc.seedasr.sauc.duration`。** 换成 `volc.bigasr.auc` /
   `volc.bigasr.sauc.duration` 会得到 `45000030 requested resource not granted` ——
   看起来像"没开通语音识别"，其实只是资源名不对。
2. **只支持新版 `X-Api-Key`。** 用旧版双头（App ID + Access Token）会得到
   `45000000 resourceId … is not allowed`。
3. **鉴权/资源类错误可能是 `HTTP 403` + 响应体 `{"header":{"code":…,"message":…}}`。**
   只判断 HTTP 状态会漏；必须解析响应体的 `header.code`。
4. **时间戳单位是毫秒**（`duration: 3240` 对 3.24 秒音频）。

**端点是怎么找到的**（记录方法，便于以后同类排障）：该服务的 404 会明确回
`Endpoint "x" does not exist`，因此可以枚举候选路径快速排除；`/api/v3/asr/*` 的
12 个候选全部 404，而 `/auc/bigmodel/recognize/flash` 返回 403（存在但缺参数），
由此定位。**先排除、再确认**比读 JS 渲染的文档更快也更可靠。

### 2.3 语音凭据的验证状态

| 能力 | 凭据 | 状态 |
|---|---|---|
| 语音合成 TTS 2.0 | `X-Api-Key` | ✅ **已实测**（真实 Key，`seed-tts-2.0` 有音频返回） |
| 语音识别 ASR 极速版 | `X-Api-Key` + `volc.seedasr.sauc.duration` | ✅ **已实测**（3.24 秒语音转写完全正确） |
| 音频生成 SeedAudio 1.0 | `X-Api-Key` + `model: seed-audio-1.0` | ✅ **已实测**（mp3/wav/ogg 三种格式均验证） |
| ~~App ID + Access Token~~ | `X-Api-App-Id` + `X-Api-Access-Key` | ❌ **已移除**：App ID 不是鉴权因子；且该套凭据在 ASR / 音频生成上被直接拒绝 |
| ~~Ark 侧语音凭据~~ | ~~`arkSpeechCredential` / `arkSpeechAppId`~~ | ❌ **设计废弃**：从未验证过，已删除，避免让用户以为有第二条通路 |

---

## 3. 计费与安全约束（写进工具描述）

1. **每次调用都可能计费**：图片按张、视频按秒、TTS 按字符。工具描述里要写明，
   失败重试**只允许限流（429）退避**，参数错误不得自动重试。
2. **视频最贵**：提交前要求明确的时长/分辨率，工具 description 里标注成本量级。
3. **凭据不落盘、不进日志**：错误信息只带 `request_id`，永不回显 Authorization。
4. **产物直链 24h 失效**：图片/视频/音频一律下载到工作区再交付。
5. **上传素材路径必须限定在 cwd 内，且判定要分两层**：
   ① 词法判定（`path.resolve` + 逐段比较，拒 `..`、绝对路径、盘符逃逸），
   ② **`fs.realpath` 之后**的真实路径判定。
   只做词法判定会被**工作区内的 junction / 符号链接**绕过：链接自身字面上在 cwd 内，
   目标在工作区外，于是界外文件被 base64 后塞进请求体。该向量**已实测复现**，
   回归用例见 `tests/path-escape.test.mjs`（断言：拒绝 + **零请求发出**）。
   另注：判据用逐段比较（首段是否恰为 `..`），不要用 `rel.startsWith('..')` ——
   后者会把工作区内名为 `..foo.png` 的合法文件误判为逃逸。
