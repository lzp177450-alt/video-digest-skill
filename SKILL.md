---
name: video-digest
description: 把视频转成模型可读的时间轴文字稿和关键帧，从而真正理解视频内容。用户发来视频附件、视频链接，或要求总结/分析/回看某段视频时使用。
whenToUse: 对话里出现 mp4/mov/mkv/webm/avi/flv 附件或本地路径，出现 B 站/YouTube/抖音链接，或用户问「这个视频讲了什么」「第几分钟说了什么」「看看这段录屏」。
---

# video-digest

视频不能直接喂给模型。这个技能把视频拆成两样模型能读的东西：**带时间码的转写文字** + **关键帧图片**。

脚本路径（`$HOME` 在 bash 和 PowerShell 里都会展开）：

```
$HOME/.agents/skills/video-digest/scripts/video-digest.mjs
```

第一次用先自检，缺什么按提示补：

```powershell
node "$HOME/.agents/skills/video-digest/scripts/video-digest.mjs" doctor
```

## 标准流程

1. **生成 pack**（首次可能要几分钟，长视频交给后台任务）

```powershell
node "$HOME/.agents/skills/video-digest/scripts/video-digest.mjs" ingest "<视频路径或链接>" --json --quiet
```

2. 读返回的 `video.md`，先建立时间轴索引。**不要把转写全文贴回给用户。**

3. 用 `read_image` 看 3~6 张关键帧，核对画面（PPT、演示、图表、无音轨内容优先）。不要一次读超过 6 张。

4. 回答时带时间码，例如「[00:12:30] 讲到这里」；用户能据此回看原片。

## 追问某一段

```powershell
node "$HOME/.agents/skills/video-digest/scripts/video-digest.mjs" frame "<packDir>" --at 12:34 --count 3
```

按返回的路径用 `read_image` 逐张看。`--at` 支持 `hh:mm:ss` 或秒数。

## 预算与边界

- 首轮最多 6 张图；确有必要再补，不要为了「看全」把候选帧全读一遍
- 转写很长时按问题定位到 2~3 个时间窗再读，不要逐条复述
- 无音轨 / 转写失败：明确告诉用户「只有画面内容」，不要编造台词
- `--asr none` 只出帧，适合纯演示录屏
- 视频体积大时，直接给绝对路径比上传附件更省（读操作不受沙箱限制）

## 失败处理

| 现象 | 处理 |
| --- | --- |
| 找不到 ffmpeg | 装 ffmpeg，或在 `config.json` 的 `ffmpeg.path` 写绝对路径 |
| 云端转写报 401/403 | key 没配好；改用 `--asr local` 或 `--asr none` |
| 云端转写报 413 | 调小 `asr.cloud.chunkSeconds`（默认 600） |
| 本地模型缺失 | 跑 `... video-digest.mjs model` 下载（约 240MB） |
| 没有 yt-dlp | `uv tool install yt-dlp` 或 `pipx install yt-dlp`，只影响链接 |
| 链接下载失败 | 可能要代理，填 `config.json` 的 `url.proxy` |
| 长视频超时 | 用后台任务跑，或先 `--no-video` 只出字幕 |

## 输出位置

默认写到当前工作目录的 `.video/<hash>-<slug>/`：

- `video.md` —— 时间轴正文（先读这个）
- `transcript.srt` —— 标准字幕
- `frames/*.jpg` —— 关键帧，文件名即秒数
- `frames/index.json` —— 时间码与场景分
- `meta.json` —— 元信息
- `source.mp4` —— 链接模式下载的源视频（补帧要用，别删）

细节见 `reference/pack-spec.md`，转写后端见 `reference/asr.md`。

## 其他

- 想重跑同一视频：加 `--force`
- 只出文字稿、不抽帧：`--no-video`（仅链接模式）；`--frames 0` 也等价于不抽帧
- 进度日志走 stderr，加 `--quiet` 可关掉，只留 stdout 的 JSON
- 模型不支持看图时，只用转写回答，并说明「没有核对画面」
- 视频附件会在消息里给出保存路径，直接把这个路径传给 `ingest`
- 文件名带空格或中文没关系，路径整体用双引号包住即可
