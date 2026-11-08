# video-digest

让 agent 真正「看懂」视频：把视频拆成**带时间码的文字稿**和**关键帧图片**，再交给模型读。

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）、opencode，以及任何支持 `SKILL.md` + 读图工具的 agent。

## 为什么需要它

模型不能直接吃 mp4。多数 agent 收到视频时，只会拿到一行「文件已保存到某路径」，既听不到声音也看不到画面。

而模型其实已经具备两个能力：读文字、看图片。所以中间缺的只是一层转换：

```
视频 ──► 音轨 ──► 转写（字幕 / 云端 / 本地）──► 带时间码的文字稿
     └─► 画面 ──► 场景切点 + 均匀采样 ──► 关键帧 JPG
                                      │
                                 模型读 video.md + read_image
```

## 快速开始

```bash
# 1. 装到 agent 的技能目录（目录名保持 video-digest）
git clone https://github.com/<you>/video-digest-skill.git ~/.agents/skills/video-digest

# 2. 装本地转写依赖（可选，只用云端可以跳过）
cd ~/.agents/skills/video-digest/scripts && npm install

# 3. 自检
node ~/.agents/skills/video-digest/scripts/video-digest.mjs doctor

# 4. 跑一个视频
node ~/.agents/skills/video-digest/scripts/video-digest.mjs ingest ./demo.mp4 --json
```

然后在对话里问「这个视频讲了什么」，agent 会读 `video.md` 并挑关键帧看。

## 依赖

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js ≥ 20 | 必需 | 只用内置模块，无框架 |
| ffmpeg / ffprobe | 必需 | 抽音轨、场景检测、抽帧；自动探测 PATH 与常见安装位置 |
| yt-dlp | 链接模式必需 | 优先用 `uvx yt-dlp`，没有则找 PATH 里的 `yt-dlp` |
| sherpa-onnx-node + SenseVoice | 可选 | 本地转写，`npm install` + `model` 子命令下载 240MB 模型 |
| 云端 ASR key | 可选 | 更快更准，OpenAI 兼容接口 |

macOS：`brew install ffmpeg yt-dlp`
Windows：`winget install Gyan.FFmpeg`（或直接用 Shotcut / Kdenlive 自带的 ffmpeg）

## 命令

```bash
node video-digest.mjs ingest <文件或链接> [--lang zh] [--frames 12] [--asr auto|cloud|local|subs|none]
                                     [--title 名称] [--out DIR] [--force] [--quiet] [--json]
node video-digest.mjs frame <packDir> --at 12:34 [--count 3]
node video-digest.mjs list [--out DIR]
node video-digest.mjs doctor
node video-digest.mjs model
```

## 转写后端

`auto` 按以下顺序降级：

1. **平台字幕**：B 站 / YouTube 有字幕就直接用，几秒完成
2. **云端**：OpenAI 兼容的 `/audio/transcriptions`，按 10 分钟切片
3. **本地**：SenseVoiceSmall + Silero VAD，纯 CPU，1 小时音频约几分钟

云端预设：`groq`（whisper-large-v3-turbo）、`siliconflow`（SenseVoiceSmall）、`openai`。
key 放环境变量 `GROQ_API_KEY` / `SILICONFLOW_API_KEY` / `OPENAI_API_KEY`，或写进 `config.json`：

```json
{
  "asr": {
    "backend": "auto",
    "cloud": { "provider": "siliconflow", "apiKey": "sk-..." }
  }
}
```

## 产物

```
.video/<hash>-<slug>/
├── video.md           # 主入口：元信息 + 关键帧清单 + 转写时间轴
├── transcript.srt     # 标准字幕
├── frames/000083.jpg  # 文件名 = 秒数
├── frames/index.json  # 时间码、场景分、尺寸
├── meta.json
└── source.mp4         # 链接模式下载的源视频（补帧依赖）
```

`video.md` 长这样：

```markdown
# 周会回放

| 项 | 值 |
| --- | --- |
| 时长 | 00:42:13 |
| 画面 | 1920x1080 @ 30fps |
| 转写 | whisper-large-v3-turbo（812 段） |

## 关键帧

- [00:00:12] `frames/000012.jpg`（场景分 27.5）
- [00:03:41] `frames/000221.jpg`（场景分 18.9）

## 转写

- [00:00:04] 大家好，今天讲三个部分……
- [00:00:18] 第一部分是先看背景。
```

## 设计取舍

- **为什么是技能而不是插件**：不依赖宿主版本，装好即用；同一份 `SKILL.md` 在 dsh 和 opencode 里都能读。
- **为什么先缩到 320px 再算场景分**：场景检测要解码全片，降分辨率能快一个量级。
- **为什么只送 8~12 帧**：模型看图有预算（单请求图像数量与字节上限），时间轴负责定位，帧负责核对画面。
- **为什么保留源视频**：追问某一秒时用 `frame --at` 精确补帧，不必重下。

## 已知限制

- 转写时间码取决于 VAD 分段，密集对话下误差约 1~2 秒
- 长视频（>1 小时）的 `ingest` 是同步的，建议交给后台任务跑
- 链接模式会保留源视频，1 小时 720p 约 0.5~1GB
- 无音轨、纯画面的内容只出帧，不做 OCR

## License

MIT
