import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chunkAudio, findFfmpeg } from './ffmpeg.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const CLOUD_PRESETS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
}

const LOCAL_FILES = ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']

function parseTimestamp(value) {
  const [hms, ms = '0'] = value.trim().replace('.', ',').split(',')
  const parts = hms.split(':').map(Number)
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds + Number(ms.padEnd(3, '0')) / 1000
}

function cleanText(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function dedupe(cues) {
  const out = []
  for (const cue of cues) {
    if (!cue.text) continue
    const prev = out.at(-1)
    if (!prev) {
      out.push(cue)
      continue
    }
    if (cue.text === prev.text) continue
    if (cue.text.startsWith(prev.text)) {
      prev.text = cue.text
      prev.end = cue.end
      continue
    }
    if (prev.text.endsWith(cue.text)) continue
    out.push(cue)
  }
  return out
}

/** Parse SRT or VTT into ordered cues. */
export function parseCues(text) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim())
    if (!lines.length) continue
    const arrow = lines.findIndex((line) => line.includes('-->'))
    if (arrow === -1) continue
    const [from, to] = lines[arrow].split('-->')
    const rest = lines.slice(arrow + 1).join(' ')
    if (!rest) continue
    cues.push({
      start: parseTimestamp(from.replace(/\s+\S+$/, '')),
      end: parseTimestamp(to.trim().split(/\s+/)[0]),
      text: cleanText(rest),
    })
  }
  return dedupe(cues)
}

function resolveCloud(config) {
  const cloud = config.asr?.cloud || {}
  const preset = CLOUD_PRESETS[cloud.provider] || CLOUD_PRESETS.groq
  const apiKey = cloud.apiKey
    || process.env[cloud.apiKeyEnv || preset.apiKeyEnv]
    || process.env.VIDEO_DIGEST_ASR_KEY
  return {
    baseURL: (cloud.baseURL || process.env.VIDEO_DIGEST_ASR_BASE_URL || preset.baseURL).replace(/\/$/, ''),
    model: cloud.model || process.env.VIDEO_DIGEST_ASR_MODEL || preset.model,
    apiKey,
    chunkSeconds: Number(process.env.VIDEO_DIGEST_ASR_CHUNK_SECONDS || cloud.chunkSeconds || 600),
  }
}

async function postChunk(cloud, bytes, lang, responseFormat, signal) {
  const form = new FormData()
  form.append('model', cloud.model)
  form.append('response_format', responseFormat)
  if (lang && lang !== 'auto') form.append('language', lang)
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
  const response = await fetch(`${cloud.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.apiKey}` },
    body: form,
    signal,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 300)}`)
  return body
}

function cuesFromResponse(body, offset, fallbackEnd) {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed)
    if (Array.isArray(json.segments) && json.segments.length) {
      return json.segments.map((s) => ({
        start: offset + Number(s.start || 0),
        end: offset + Number(s.end || s.start || 0),
        text: cleanText(String(s.text || '')),
      }))
    }
    return json.text ? [{ start: offset, end: fallbackEnd, text: cleanText(String(json.text)) }] : []
  }
  return parseCues(trimmed).map((cue) => ({ ...cue, start: cue.start + offset, end: cue.end + offset }))
}

async function transcribeCloud(options) {
  const { wavPath, ffmpegPath, workDir, lang, config, log } = options
  const cloud = resolveCloud(config)
  if (!cloud.apiKey) {
    throw new Error(
      '未配置云端转写 key。设置环境变量 GROQ_API_KEY / SILICONFLOW_API_KEY / VIDEO_DIGEST_ASR_KEY，'
      + '或改用 --asr local / --asr none。',
    )
  }
  const chunks = chunkAudio(findFfmpeg(ffmpegPath), wavPath, workDir, cloud.chunkSeconds)
  const cues = []
  for (const [index, chunk] of chunks.entries()) {
    log(`转写 ${index + 1}/${chunks.length} (${Math.round(chunk.offset)}s 起)`)
    const bytes = readFileSync(chunk.path)
    const signal = AbortSignal.timeout(180_000)
    let body = null
    let lastError = null
    for (const format of ['verbose_json', 'srt', 'json']) {
      try {
        body = await postChunk(cloud, bytes, lang, format, signal)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (body === null) throw new Error(`云端转写失败: ${lastError?.message || '未知错误'}`)
    cues.push(...cuesFromResponse(body, chunk.offset, chunk.offset + cloud.chunkSeconds))
  }
  return {
    backend: 'cloud',
    label: `${cloud.model} @ ${cloud.baseURL}`,
    cues: dedupe(cues).filter((cue) => cue.text),
  }
}

function wavSamples(file) {
  const buffer = readFileSync(file)
  const marker = buffer.indexOf('data', 12, 'ascii')
  const start = marker === -1 ? 44 : marker + 8
  const pcm = new DataView(buffer.buffer, buffer.byteOffset + start, buffer.byteLength - start)
  return Float32Array.from({ length: Math.floor(pcm.byteLength / 2) }, (_, i) => pcm.getInt16(i * 2, true) / 32768)
}

async function loadSherpa() {
  const bundled = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/sherpa-onnx-node',
  )
  for (const spec of ['sherpa-onnx-node', bundled]) {
    try {
      const mod = await import(spec.startsWith('C:') ? pathToFileURL(spec).href : spec)
      return mod.default || mod
    } catch {
      // try the next source
    }
  }
  return null
}

async function transcribeLocal(options) {
  const { wavPath, lang, config, log } = options
  const modelDir = path.resolve(config.asr?.local?.modelDir || path.join(SKILL_DIR, 'models'))
  const missing = LOCAL_FILES.filter((name) => !existsSync(path.join(modelDir, name)))
  if (missing.length) {
    throw new Error(`本地模型不完整：${modelDir} 缺少 ${missing.join(', ')}。先运行 model 子命令下载。`)
  }
  const sherpa = await loadSherpa()
  if (!sherpa) {
    throw new Error('未安装 sherpa-onnx-node。在 scripts 目录执行 npm i sherpa-onnx-node，或改用云端转写。')
  }
  const threads = config.asr?.local?.threads || 4
  const senseVoice = {
    model: path.join(modelDir, 'model.int8.onnx'),
    language: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(lang) ? lang : 'auto',
    useInverseTextNormalization: 1,
  }
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice, tokens: path.join(modelDir, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0 },
  })
  const detector = new sherpa.Vad({
    sileroVad: {
      model: path.join(modelDir, 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 30,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, 32)
  const samples = wavSamples(wavPath)
  const cues = []
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front(false)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples })
      recognizer.decode(stream)
      const text = String(recognizer.getResult(stream).text || '').trim()
      if (text) {
        const start = segment.start / 16000
        cues.push({ start, end: start + segment.samples.length / 16000, text })
      }
      detector.pop()
    }
  }
  const total = Math.ceil(samples.length / 512)
  for (let offset = 0, step = 0; offset < samples.length; offset += 512, step += 1) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512))
    drain()
    if (step % 2000 === 0) log(`本地转写 ${Math.round((step / total) * 100)}%`)
  }
  detector.flush()
  drain()
  return { backend: 'local', label: 'SenseVoiceSmall (cpu)', cues }
}

/**
 * Transcribe a wav into timestamped cues.
 * `auto` prefers platform subtitles, then cloud, then the local model.
 */
export async function transcribe(options) {
  const { backend, subtitlePath, log } = options
  if (backend === 'none') return { backend: 'none', label: '未转写', cues: [] }
  if (backend === 'subs') {
    if (!subtitlePath) throw new Error('没有可用字幕文件')
    return { backend: 'subs', label: path.basename(subtitlePath), cues: parseCues(readFileSync(subtitlePath, 'utf8')) }
  }
  if (backend === 'cloud') return transcribeCloud(options)
  if (backend === 'local') return transcribeLocal(options)
  if (subtitlePath) {
    log('使用平台字幕')
    return { backend: 'subs', label: path.basename(subtitlePath), cues: parseCues(readFileSync(subtitlePath, 'utf8')) }
  }
  if (resolveCloud(options.config).apiKey) return transcribeCloud(options)
  log('无云端 key，尝试本地模型')
  return transcribeLocal(options)
}

export { LOCAL_FILES, CLOUD_PRESETS }
