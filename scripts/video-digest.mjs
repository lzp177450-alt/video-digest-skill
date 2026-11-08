#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { findFfmpeg, findFfprobe, hasCommand, probe, extractAudio, sceneScores, grabFrame } from './lib/ffmpeg.mjs'
import { transcribe, LOCAL_FILES } from './lib/asr.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = path.join(SKILL_DIR, 'config.json')
const EXAMPLE_FILE = path.join(SKILL_DIR, 'config.example.json')
const MODEL_ASSETS = [
  { name: 'model.int8.onnx', bytes: 239233841, path: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx' },
  { name: 'tokens.txt', bytes: 315894, path: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt' },
  { name: 'silero_vad.onnx', bytes: 1807522, path: 'csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx' },
]

let quiet = false

function log(message) {
  if (!quiet) process.stderr.write(`${message}\n`)
}

function setQuiet(value) {
  quiet = Boolean(value)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function merge(base, override) {
  if (!isPlainObject(override)) return override ?? base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? merge(base[key], value) : value
  }
  return out
}

function loadConfig() {
  const base = existsSync(EXAMPLE_FILE) ? JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')) : {}
  const user = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
  return merge(base, user)
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { command, positional, flags }
}

function timecode(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function parseTime(value) {
  if (value === undefined) return 0
  if (!String(value).includes(':')) return Number(value)
  return String(value).split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function slugify(value) {
  return String(value)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'video'
}

function sha256File(file) {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let read = readSync(fd, buffer, 0, buffer.length, null)
    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = readSync(fd, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

let ytdlpCommand = null

function resolveYtdlp(config) {
  if (config.url?.command?.length) return config.url.command
  ytdlpCommand ??= hasCommand('uvx') ? ['uvx', 'yt-dlp'] : (hasCommand('yt-dlp') ? ['yt-dlp'] : null)
  if (!ytdlpCommand) {
    throw new Error('没有 yt-dlp。装一个：uv tool install yt-dlp / pipx install yt-dlp，或在 config.json 的 url.command 里写路径。')
  }
  return ytdlpCommand
}

function ytdlp(config, args) {
  const base = resolveYtdlp(config)
  const proxy = config.url?.proxy ? ['--proxy', config.url.proxy] : []
  const result = spawnSync(base[0], [...base.slice(1), ...proxy, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split(/\r?\n/).slice(-4).join('\n')
    throw new Error(`yt-dlp 失败 (${result.status})\n${detail}`)
  }
  return result.stdout
}

function urlInfo(url, config) {
  const raw = ytdlp(config, ['--dump-json', '--no-warnings', '--skip-download', '--no-playlist', url])
  const first = raw.split(/\r?\n/).find((line) => line.trim().startsWith('{'))
  if (!first) throw new Error('yt-dlp 没有返回视频信息')
  const info = JSON.parse(first)
  const tracks = { ...(info.subtitles || {}) }
  for (const [lang, list] of Object.entries(info.automatic_captions || {})) {
    if (!tracks[lang]) tracks[lang] = list
  }
  const preferred = ['zh-Hans', 'zh-CN', 'zh', 'en']
  const lang = preferred.find((code) => tracks[code]) || Object.keys(tracks)[0] || null
  return { title: info.title || info.id || 'video', duration: Number(info.duration || 0), lang, hasSubs: Boolean(lang) }
}

function downloadSubs(url, dir, info, config) {
  if (!info.hasSubs) return null
  const args = [
    '--write-subs', '--write-auto-subs', '--sub-langs', info.lang,
    '--sub-format', 'vtt', '--skip-download', '--no-playlist',
    '-P', dir, '-o', 'subtitle.%(ext)s', url,
  ]
  try {
    ytdlp(config, args)
  } catch (error) {
    log(`字幕下载失败：${error.message}`)
    return null
  }
  const file = readdirSync(dir).find((name) => name.startsWith('subtitle.') && name.endsWith('.vtt'))
  return file ? path.join(dir, file) : null
}

function downloadVideo(url, dir, config, ffmpegPath) {
  const maxHeight = config.url?.maxHeight || 720
  log(`下载视频（≤${maxHeight}p）…`)
  ytdlp(config, [
    '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
    '--ffmpeg-location', path.dirname(ffmpegPath),
    '-P', dir, '-o', 'source.%(ext)s', url,
  ])
  const file = readdirSync(dir).find((name) => name.startsWith('source.'))
  if (!file) throw new Error('视频下载完成但找不到输出文件')
  return path.join(dir, file)
}
function pickFrames(scores, duration, count, threshold) {
  const picks = []
  const push = (t, score) => {
    if (t < 0.2 || t > duration - 0.2) return false
    if (picks.some((pick) => Math.abs(pick.t - t) < 2)) return false
    picks.push({ t, score })
    return true
  }
  push(Math.min(1, duration / 2), 0)
  for (const cut of scores.filter((entry) => entry.score >= threshold).sort((a, b) => b.score - a.score)) {
    if (picks.length >= count) break
    push(cut.t + 0.3, cut.score)
  }
  const step = duration / count
  for (let i = 1; picks.length < count && i <= count * 3; i += 1) push(i * step, 0)
  return picks.sort((a, b) => a.t - b.t)
}

function renderMarkdown(meta) {
  const lines = [
    `# ${meta.title}`,
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 来源 | ${meta.source} |`,
    `| 时长 | ${timecode(meta.duration)} |`,
    `| 画面 | ${meta.width}x${meta.height} @ ${meta.fps}fps |`,
    `| 音轨 | ${meta.hasAudio ? '有' : '无'} |`,
    `| 转写 | ${meta.asr.label}（${meta.asr.cues} 段） |`,
    '',
    '## 关键帧',
    '',
    ...(meta.keyframes.length
      ? meta.keyframes.map((frame) => `- [${frame.timecode}] \`${frame.file}\`（场景分 ${frame.score.toFixed(1)}）`)
      : ['_没有抽取到画面。_']),
    '',
    '## 转写',
    '',
  ]
  if (!meta.transcript.length) {
    lines.push('_没有可用的语音内容（无音轨或未转写）。_')
  }
  for (const cue of meta.transcript) {
    lines.push(`- [${timecode(cue.start)}] ${cue.text}`)
  }
  return `${lines.join('\n')}\n`
}

function renderSrt(cues) {
  const stamp = (seconds) => {
    const ms = Math.round((seconds % 1) * 1000)
    return `${timecode(seconds)},${String(ms).padStart(3, '0')}`
  }
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n')
}

function readMeta(packDir) {
  const file = path.join(packDir, 'meta.json')
  if (!existsSync(file)) throw new Error(`不是有效的 pack 目录：${packDir}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Compact model-facing summary of one pack. */
function summarize(packDir, meta, cached) {
  return {
    cached,
    packDir,
    videoMd: path.join(packDir, 'video.md'),
    title: meta.title,
    duration: timecode(meta.duration),
    asr: meta.asr,
    keyframes: meta.keyframes.map(({ timecode: tc, file, score }) => ({ timecode: tc, file, score })),
  }
}

async function ingest(args, flags, config) {
  const source = args[0]
  if (!source) throw new Error('用法：ingest <文件或链接>')
  const ffmpegPath = findFfmpeg(config.ffmpeg?.path)
  if (!ffmpegPath) throw new Error('找不到 ffmpeg。安装后把路径写入 config.json 的 ffmpeg.path，或设置 FFMPEG_PATH。')

  const isUrl = /^https?:\/\//i.test(source)
  const outRoot = path.resolve(flags.out || config.outputDir || path.join(process.cwd(), '.video'))
  const title = flags.title || (isUrl ? null : path.basename(source))
  const hash = isUrl ? createHash('sha256').update(source).digest('hex') : sha256File(source)
  const packDir = path.join(outRoot, `${hash.slice(0, 8)}-${slugify(title || 'video')}`)
  const cacheDir = path.join(packDir, '.cache')
  const framesDir = path.join(packDir, 'frames')

  if (existsSync(path.join(packDir, 'meta.json')) && !flags.force) {
    const meta = readMeta(packDir)
    return summarize(packDir, meta, true)
  }

  ensureDir(cacheDir)
  ensureDir(framesDir)

  let info = { title: title || 'video', lang: null, hasSubs: false }
  let videoPath = source
  if (isUrl) {
    info = urlInfo(source, config)
    if (flags.title) info.title = flags.title
    log(`来源：${info.title}`)
    videoPath = flags['no-video'] ? null : downloadVideo(source, packDir, config, ffmpegPath)
  } else {
    videoPath = path.resolve(source)
    if (!existsSync(videoPath)) throw new Error(`文件不存在：${videoPath}`)
  }

  const subtitlePath = isUrl && !flags['no-subs'] ? downloadSubs(source, cacheDir, info, config) : null
  const media = videoPath ? probe(videoPath, ffmpegPath) : { duration: info.duration, width: 0, height: 0, fps: 0, hasAudio: true }
  const duration = media.duration || info.duration || 0
  const asrMode = String(flags.asr || config.asr?.backend || 'auto')

  let wavPath = null
  if (videoPath && media.hasAudio !== false && asrMode !== 'none' && !subtitlePath) {
    log('提取音轨…')
    wavPath = extractAudio(ffmpegPath, videoPath, path.join(cacheDir, 'audio.wav'))
  }
  if (!subtitlePath && !wavPath && asrMode !== 'none') {
    log('没有音轨或没有视频文件，跳过转写')
  }

  const asr = await transcribe({
    backend: subtitlePath ? 'subs' : (wavPath ? asrMode : 'none'),
    subtitlePath,
    wavPath,
    ffmpegPath,
    workDir: cacheDir,
    duration,
    lang: String(flags.lang || info.lang || config.asr?.lang || 'auto'),
    config,
    log,
  })

  let keyframes = []
  const frameCount = Number(flags.frames ?? config.frames?.count ?? 12)
  if (videoPath && frameCount > 0) {
    log('分析画面切换…')
    const scores = sceneScores(ffmpegPath, videoPath, cacheDir)
    const threshold = Number(flags['scene-threshold'] || config.frames?.sceneThreshold || 10)
    const picks = pickFrames(scores, duration, frameCount, threshold)
    log(`抽取 ${picks.length} 张关键帧…`)
    keyframes = picks.map((pick) => {
      const seconds = Math.max(0, pick.t)
      const name = `frames/${String(Math.round(seconds)).padStart(6, '0')}.jpg`
      grabFrame(ffmpegPath, videoPath, seconds, path.join(packDir, name), Number(config.frames?.maxWidth || 1280))
      const size = statSync(path.join(packDir, name))
      return {
        t: Number(seconds.toFixed(2)),
        timecode: timecode(seconds),
        file: name,
        score: pick.score,
        bytes: size.size,
      }
    })
  }

  const meta = {
    version: 1,
    source: isUrl ? source : path.resolve(source),
    sourceKind: isUrl ? 'url' : 'file',
    title: info.title || title,
    hash,
    sourcePath: videoPath,
    duration: Number(duration.toFixed(2)),
    width: media.width,
    height: media.height,
    fps: media.fps,
    hasAudio: Boolean(videoPath && media.hasAudio),
    asr: { backend: asr.backend, label: asr.label, cues: asr.cues.length },
    frames: keyframes.length,
    keyframes,
    transcript: asr.cues.map((cue) => ({
      start: Number(cue.start.toFixed(2)),
      end: Number(cue.end.toFixed(2)),
      text: cue.text,
    })),
    createdAt: new Date().toISOString(),
  }

  writeFileSync(path.join(packDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  writeFileSync(path.join(packDir, 'video.md'), renderMarkdown(meta), 'utf8')
  if (meta.transcript.length) writeFileSync(path.join(packDir, 'transcript.srt'), renderSrt(meta.transcript), 'utf8')
  writeFileSync(path.join(packDir, 'frames', 'index.json'), JSON.stringify(meta.keyframes, null, 2), 'utf8')
  if (!flags['keep-cache']) rmSync(cacheDir, { recursive: true, force: true })

  return summarize(packDir, meta, false)
}

function frame(args, flags, config) {
  const packDir = path.resolve(args[0] || '.')
  const meta = readMeta(packDir)
  if (!meta.sourcePath || !existsSync(meta.sourcePath)) {
    throw new Error('这个 pack 没有保留源视频，无法补帧。重新 ingest（不带 --no-video）后再试。')
  }
  const ffmpegPath = findFfmpeg(config.ffmpeg?.path)
  const start = parseTime(flags.at)
  if (flags.at === undefined) throw new Error('用法：frame <packDir> --at 12:34 [--count 3]')
  const count = Number(flags.count || 1)
  const result = []
  for (let i = 0; i < count; i += 1) {
    const wanted = start + i * Number(flags.step || 1)
    const seconds = Math.min(Math.max(0, wanted), Math.max(0, meta.duration - 0.1))
    const name = `frames/${String(Math.round(seconds)).padStart(6, '0')}.jpg`
    grabFrame(ffmpegPath, meta.sourcePath, seconds, path.join(packDir, name), Number(config.frames?.maxWidth || 1280))
    result.push({ t: Number(seconds.toFixed(2)), timecode: timecode(seconds), file: name })
  }
  return { packDir, frames: result }
}

function list(flags, config) {
  const root = path.resolve(flags.out || config.outputDir || path.join(process.cwd(), '.video'))
  if (!existsSync(root)) return { root, packs: [] }
  const packs = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => existsSync(path.join(dir, 'meta.json')))
    .map((dir) => {
      const meta = readMeta(dir)
      return {
        packDir: dir,
        title: meta.title,
        duration: timecode(meta.duration),
        asr: meta.asr.backend,
        cues: meta.asr.cues,
        frames: meta.frames,
        createdAt: meta.createdAt,
      }
    })
  return { root, packs }
}

function doctor(config) {
  const ffmpegPath = findFfmpeg(config.ffmpeg?.path)
  const ffprobePath = findFfprobe(ffmpegPath)
  let ytdlp = 'missing'
  try {
    const command = resolveYtdlp(config)
    ytdlp = spawnSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8', windowsHide: true }).status === 0
      ? 'ok'
      : 'missing'
  } catch {
    ytdlp = 'missing'
  }
  const modelDir = path.resolve(config.asr?.local?.modelDir || path.join(SKILL_DIR, 'models'))
  const model = LOCAL_FILES.every((name) => existsSync(path.join(modelDir, name)))
  return {
    node: process.version,
    platform: process.platform,
    ffmpeg: ffmpegPath || null,
    ffprobe: ffprobePath,
    ytdlp,
    cloudKey: Boolean(config.asr?.cloud?.apiKey || process.env.VIDEO_DIGEST_ASR_KEY || process.env.GROQ_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.OPENAI_API_KEY),
    localModel: model ? modelDir : null,
    configFile: existsSync(CONFIG_FILE) ? CONFIG_FILE : null,
  }
}

async function fetchWithConnectTimeout(url, ms = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function hasCurl() {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
  return spawnSync(cmd, ['curl'], { encoding: 'utf8', windowsHide: true }).status === 0
}

function downloadWithCurl(url, target) {
  const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '-sS', '-L', '--fail', '--retry', '2', '--connect-timeout', '20', '--max-time', '1800',
    '-o', target, url,
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error((result.stderr || '').trim().split(/\r?\n/).pop() || `curl ${result.status}`)
}

async function downloadModel(config) {
  const dir = ensureDir(path.resolve(config.asr?.local?.modelDir || path.join(SKILL_DIR, 'models')))
  for (const asset of MODEL_ASSETS) {
    const target = path.join(dir, asset.name)
    if (existsSync(target) && statSync(target).size === asset.bytes) {
      log(`已存在 ${asset.name}`)
      continue
    }
    const forced = process.env.VIDEO_DIGEST_MODEL_ORIGIN
    const origins = forced ? [forced] : ['https://huggingface.co', 'https://hf-mirror.com']
    let done = false
    for (const origin of origins) {
      try {
        log(`下载 ${asset.name}（${(asset.bytes / 1048576).toFixed(0)}MB，源 ${origin}）`)
        if (hasCurl()) {
          downloadWithCurl(`${origin}/${asset.path}`, `${target}.part`)
          renameSync(`${target}.part`, target)
          done = true
          break
        }
        const response = await fetchWithConnectTimeout(`${origin}/${asset.path}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.part`))
        renameSync(`${target}.part`, target)
        done = true
        break
      } catch (error) {
        log(`  ${origin} 失败：${error.message}`)
      }
    }
    if (!done) throw new Error(`${asset.name} 下载失败，可手动放到 ${dir}`)
  }
  return { modelDir: dir }
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  setQuiet(flags.quiet)
  const config = loadConfig()
  const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

  if (command === 'ingest') return json(await ingest(positional, flags, config))
  if (command === 'frame') return json(frame(positional, flags, config))
  if (command === 'list') return json(list(flags, config))
  if (command === 'doctor') return json(doctor(config))
  if (command === 'model') return json(await downloadModel(config))
  process.stdout.write(`video-digest
  ingest <file|url> [--lang zh] [--frames 12] [--asr auto|cloud|local|subs|none] [--title 名称] [--quiet] [--out DIR] [--json] [--force]
  frame <packDir> --at 12:34 [--count 3]
  list
  doctor
  model
`)
  return null
}

main().catch((error) => {
  log(`错误：${error.message}`)
  process.exit(1)
})
