import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const KNOWN_FFMPEG = [
  'C:\\Program Files\\Shotcut\\ffmpeg.exe',
  'C:\\Program Files\\Kdenlive\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]

function isFile(p) {
  try {
    return Boolean(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function fromPath() {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
  const found = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' })
  const first = (found.stdout || '').split(/\r?\n/).find(Boolean)
  return first && isFile(first.trim()) ? first.trim() : null
}

/** Locate an ffmpeg binary: env override, known installs, then PATH. */
export function findFfmpeg(configured) {
  return [configured, process.env.FFMPEG_PATH, ...KNOWN_FFMPEG].find(isFile) || fromPath()
}

/** True when a command is resolvable on PATH. */
export function hasCommand(name) {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
  return spawnSync(cmd, [name], { encoding: 'utf8' }).status === 0
}

export function findFfprobe(ffmpegPath) {
  if (ffmpegPath) {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    if (isFile(sibling)) return sibling
  }
  return process.env.FFPROBE_PATH && isFile(process.env.FFPROBE_PATH) ? process.env.FFPROBE_PATH : 'ffprobe'
}

/** Run a binary without a shell and return its captured output. */
export function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: options.cwd,
    windowsHide: true,
  })
  const ok = result.status === 0
  if (!ok && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-6).join('\n')
    throw new Error(`${path.basename(bin)} 失败 (${result.status})\n${detail}`)
  }
  return { ok, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/** Read media metadata with ffprobe. */
export function probe(file, ffmpegPath) {
  const ffprobe = findFfprobe(ffmpegPath)
  const { stdout } = run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])
  const info = JSON.parse(stdout)
  const video = info.streams.find((s) => s.codec_type === 'video')
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  const [num, den] = String(video?.r_frame_rate || '0/1').split('/').map(Number)
  return {
    duration: Number(info.format?.duration || video?.duration || 0),
    width: video?.width || 0,
    height: video?.height || 0,
    fps: den ? Number((num / den).toFixed(3)) : 0,
    hasAudio: Boolean(audio),
    sizeBytes: Number(info.format?.size || 0),
  }
}

/** Extract a mono 16 kHz PCM wav for speech recognition. */
export function extractAudio(ffmpegPath, source, outPath) {
  run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath,
  ])
  return outPath
}

/** Cut a wav into fixed-size chunks, returning offsets in seconds. */
export function chunkAudio(ffmpegPath, wavPath, outDir, chunkSeconds) {
  const chunks = []
  const total = probe(wavPath, ffmpegPath).duration
  for (let start = 0, index = 0; start < total; start += chunkSeconds, index += 1) {
    const out = path.join(outDir, `chunk-${String(index).padStart(3, '0')}.wav`)
    run(ffmpegPath, [
      '-hide_banner', '-nostdin', '-y', '-ss', String(start), '-t', String(chunkSeconds),
      '-i', wavPath, '-c:a', 'pcm_s16le', out,
    ])
    chunks.push({ path: out, offset: start })
  }
  return chunks
}

/**
 * Score scene cuts at 2 fps on a tiny raster, then return timestamped scores.
 * The score file is written relative to the working directory to avoid
 * Windows drive-letter escaping inside a filtergraph.
 */
export function sceneScores(ffmpegPath, source, workDir) {
  const file = 'scdet.txt'
  const target = path.join(workDir, file)
  run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', source,
    '-vf', `fps=2,scale=160:-2,scdet=threshold=4,metadata=print:file=${file}`,
    '-an', '-f', 'null', '-',
  ], { cwd: workDir })
  if (!existsSync(target)) return []
  const scores = []
  let time = 0
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    const t = line.match(/pts_time:([\d.]+)/)
    if (t) time = Number(t[1])
    const score = line.match(/lavfi\.scd\.score=([\d.]+)/)
    if (score) scores.push({ t: time, score: Number(score[1]) })
  }
  return scores
}

/** Grab one frame at a timestamp, downscaling only when wider than maxWidth. */
export function grabFrame(ffmpegPath, source, seconds, outPath, maxWidth) {
  const filters = []
  if (maxWidth) filters.push(`scale='min(${maxWidth},iw)':-2`)
  run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y',
    '-ss', String(Math.max(0, seconds)), '-i', source,
    '-frames:v', '1', '-q:v', '3',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    outPath,
  ])
  return outPath
}

/** Write a text file, creating parents. */
export function writeText(file, text) {
  writeFileSync(file, text, 'utf8')
}
