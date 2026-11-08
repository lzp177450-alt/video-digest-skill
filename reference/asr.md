# 转写后端

`--asr` 取值：`auto`（默认）/ `subs` / `cloud` / `local` / `none`。

`auto` 的降级顺序：

1. 有平台字幕 → 直接用（URL 模式）
2. 配置了云端 key → 云端
3. 本地模型完整 → SenseVoice
4. 都没有 → 报错并提示下一步

## 平台字幕

URL 模式默认尝试 `yt-dlp --write-subs --write-auto-subs`，优先 `zh-Hans` → `zh-CN` → `zh` → `en`。
字幕只下载文字，不下载视频，几秒完成。

关掉：`--no-subs`。

## 云端

OpenAI 兼容的 `/audio/transcriptions` 接口，按 `asr.cloud.chunkSeconds`（默认 600 秒）切片，
逐片请求后按偏移量拼接成全局时间码。

| 预设 | baseURL | 默认模型 | key 环境变量 |
| --- | --- | --- | --- |
| `groq` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `GROQ_API_KEY` |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | `SILICONFLOW_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `whisper-1` | `OPENAI_API_KEY` |

通用 key：`VIDEO_DIGEST_ASR_KEY`（优先级低于上面三个具体变量）。
临时覆盖接口：`VIDEO_DIGEST_ASR_BASE_URL`、`VIDEO_DIGEST_ASR_MODEL`、`VIDEO_DIGEST_ASR_CHUNK_SECONDS`。

响应格式依次尝试 `verbose_json`（带 segments）→ `srt` → `json`，任何一种能返回时间码都能用。
遇到 413 就调小 `chunkSeconds`；16k 单声道 10 分钟约 19MB。

## 本地 SenseVoice

依赖：`scripts/node_modules/sherpa-onnx-node`（已安装），模型放在 `models/`：

```powershell
node scripts/video-digest.mjs model
```

下载三个文件（约 240MB）：`model.int8.onnx`、`tokens.txt`、`silero_vad.onnx`。
先试 huggingface.co，失败回退 hf-mirror.com；国内可设 `VIDEO_DIGEST_MODEL_ORIGIN=https://hf-mirror.com` 直接走镜像。

推理流程：Silero VAD 切句 → 每句单独识别 → 用 VAD 段的起止时间做时间码。
纯 CPU，1 小时音频通常几分钟；`asr.local.threads` 控制线程数。

支持语言：`auto` / `zh` / `en` / `yue` / `ja` / `ko`。

## 关闭转写

`--asr none`：只抽帧。适合纯演示、无解说录屏，或只想知道画面内容时。
