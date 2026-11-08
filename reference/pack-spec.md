# pack 结构

```
.video/<sha256前8位>-<slug>/
├── video.md           # 主入口：元信息 + 关键帧清单 + 转写时间轴
├── transcript.srt     # 标准 SRT，便于外部工具复用（无转写时不生成）
├── frames/
│   ├── 000083.jpg     # 文件名 = 秒数，左侧补零，排序即时间序
│   └── index.json
├── source.mp4         # 仅链接模式：下载的源视频，补帧依赖它
├── meta.json
└── .cache/            # 中间产物（音轨、音频切片、场景分），默认跑完即删
```

## meta.json

| 字段 | 含义 |
| --- | --- |
| `version` | 结构版本，当前 1 |
| `source` | 原始输入（绝对路径或 URL） |
| `sourceKind` | `file` / `url` |
| `title` | 标题（文件名或视频标题） |
| `hash` | 源文件 sha256；URL 为链接字符串的 sha256 |
| `sourcePath` | 实际可 seek 的视频文件；URL 模式为下载后的副本 |
| `duration` | 秒 |
| `width` / `height` / `fps` | 画面参数 |
| `hasAudio` | 是否存在音轨 |
| `asr.backend` | `subs` / `cloud` / `local` / `none` |
| `asr.label` | 具体后端标识，例如模型名 |
| `asr.cues` | 转写段数 |
| `keyframes[]` | `{ t, timecode, file, score, bytes }` |
| `transcript[]` | `{ start, end, text }`，秒 |
| `createdAt` | ISO 时间 |

## video.md

```markdown
# 标题

| 项 | 值 |
...

## 关键帧

- [00:00:12] `frames/000012.jpg`（场景分 27.5）

## 转写

- [00:00:04] 大家好，今天讲三个部分……
```

场景分来自 ffmpeg `scdet`，范围 0~100，硬切通常在 10 以上，普通运动低于 2。

## 缓存

同一源文件（含 URL）重复 `ingest` 会直接命中 pack，除非带 `--force`。
换 `--frames` / `--asr` 等参数但源未变时，也会命中缓存；需要重跑请加 `--force`。
