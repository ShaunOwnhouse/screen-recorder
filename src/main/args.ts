import type { ImageFormat, Quality, Rect } from '../shared/types.ts'

export interface DdaTarget {
  adapter: number
  output: number
}

export interface AvfTarget {
  /** avfoundation device index (or name) of the "Capture screen N" device. */
  device: number | string
  /** Request full-colour BGRA frames; null leaves the device default. */
  pixelFormat: string | null
}

/** A pipe/socket URL carrying 48 kHz stereo f32le PCM, and the gain to apply to it. */
export interface AudioInput {
  url: string
  volume: number
  /** Computer sound ('pc') or the microphone ('mic'): kept as a track of its own in the recording. */
  kind: 'pc' | 'mic'
}

/** Names of the audio tracks in a recording (the editor reads them back to know which is which). */
export const TRACK_NAMES = { mix: 'Mix', pc: 'Computer sound', mic: 'Microphone' } as const

export interface RecordArgsInput {
  backend: 'ddagrab' | 'gdigrab' | 'avfoundation' | 'x11grab'
  /** Required for ddagrab: which GPU adapter and output (monitor) to duplicate. */
  dda?: DdaTarget
  /** Required for avfoundation (macOS). */
  avf?: AvfTarget
  /** X display for x11grab (Linux), e.g. ":0". */
  x11Display?: string
  /**
   * Physical pixels. gdigrab: virtual-desktop coords. ddagrab: relative to the output's top-left.
   * avfoundation: crop relative to the captured screen.
   */
  rect: Rect
  fps: number
  outputHeight: number | null
  quality: Quality
  encoder: string
  audio: AudioInput[]
  showCursor: boolean
  outputPath: string
  /** The GPU rejected the top-tier tuning options; use the plain set at the same quality target. */
  basicTuning?: boolean
}

export const HARDWARE_ENCODERS = [
  'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf', 'h264_videotoolbox', 'hevc_videotoolbox'
] as const

export const ENCODER_LABELS: Record<string, string> = {
  libx264: 'CPU (x264)',
  h264_nvenc: 'NVIDIA H.264',
  hevc_nvenc: 'NVIDIA HEVC',
  h264_qsv: 'Intel H.264',
  hevc_qsv: 'Intel HEVC',
  h264_amf: 'AMD H.264',
  hevc_amf: 'AMD HEVC',
  h264_videotoolbox: 'Apple H.264',
  hevc_videotoolbox: 'Apple HEVC'
}

/** Encoders that can be asked for full 4:4:4 chroma (hardware ones are also probed at runtime). */
export const YUV444_CAPABLE = ['libx264', 'h264_nvenc', 'hevc_nvenc']

export const AUDIO_RATE = 48000

// yuv420p needs even dimensions.
export function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

export function is444(quality: Quality): boolean {
  return quality === 'studio' || quality === 'lossless'
}

/** Top tiers get the slowest, highest-quality encoder settings. */
export function isTuned(quality: Quality): boolean {
  return quality === 'maximum' || quality === 'studio'
}

export function effectiveEncoder(encoder: string, quality: Quality): string {
  if (quality === 'lossless') return 'libx264'
  if (quality === 'studio' && !YUV444_CAPABLE.includes(encoder)) return 'libx264'
  return encoder
}

export function pixelFormatFor(encoder: string, quality: Quality): string {
  if (is444(quality)) return 'yuv444p'
  if (encoder.endsWith('_qsv')) return 'nv12'
  return 'yuv420p'
}

const CQ: Record<Exclude<Quality, 'lossless'>, number> = { high: 20, veryhigh: 16, maximum: 12, studio: 12 }
const VT_QUALITY: Record<Exclude<Quality, 'lossless'>, number> = { high: 65, veryhigh: 75, maximum: 88, studio: 88 }

/**
 * Encoder settings for a quality tier. `basic` drops the extra tuning (multipass, temporal AQ) for
 * GPUs/drivers that reject it, keeping the same quality target.
 */
export function encoderArgs(encoder: string, quality: Quality, pixelRate: number, basic = false): string[] {
  if (quality === 'lossless') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0']

  const q = CQ[quality]
  const full = is444(quality)
  const tuned = isTuned(quality) && !basic
  const hevcQ = String(q + 2)
  switch (encoder) {
    case 'h264_nvenc':
    case 'hevc_nvenc': {
      const hevc = encoder === 'hevc_nvenc'
      return [
        '-c:v', encoder, '-preset', tuned ? 'p7' : 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', hevc ? hevcQ : String(q), '-b:v', '0',
        // Adaptive quantisation spends bits on detail (text, edges) instead of flat areas.
        '-spatial_aq', '1', '-rc-lookahead', tuned ? '32' : '20',
        // Top tiers: a quarter-resolution first pass and temporal AQ for steadier detail in motion.
        ...(tuned ? ['-multipass', 'qres', '-temporal_aq', '1'] : []),
        '-profile:v', hevc ? (full ? 'rext' : 'main') : full ? 'high444p' : 'high',
        ...(hevc ? ['-tag:v', 'hvc1'] : [])
      ]
    }
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', tuned ? 'slower' : 'medium', '-global_quality', String(q)]
    case 'hevc_qsv':
      return ['-c:v', encoder, '-preset', tuned ? 'slower' : 'medium', '-global_quality', hevcQ, '-tag:v', 'hvc1']
    case 'h264_amf':
      return [
        '-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-qp_b', String(q),
        ...(tuned ? ['-preanalysis', '1'] : [])
      ]
    case 'hevc_amf':
      return [
        '-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', hevcQ, '-qp_p', hevcQ, '-tag:v', 'hvc1',
        ...(tuned ? ['-preanalysis', '1'] : [])
      ]
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      // VideoToolbox constant quality is 1–100 (higher = better).
      return [
        '-c:v', encoder, '-q:v', String(VT_QUALITY[quality]), '-realtime', '1', '-allow_sw', '0',
        ...(encoder === 'hevc_videotoolbox' ? ['-tag:v', 'hvc1'] : ['-profile:v', 'high'])
      ]
    default: {
      // CRF fixes the quality; a faster preset only costs file size, which keeps 4K60 real-time on a CPU.
      const preset = pixelRate > 1920 * 1080 * 60 ? 'superfast' : 'veryfast'
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(q - 2), '-profile:v', full ? 'high444' : 'high']
    }
  }
}

export function outputSize(rect: Rect, outputHeight: number | null): { width: number; height: number } {
  const width = even(rect.width)
  const height = even(rect.height)
  if (!outputHeight || outputHeight === height) return { width, height }
  return { width: even((width * outputHeight) / height), height: outputHeight }
}

export const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
/**
 * Playable tiers use AAC-LC at 320 kb/s (transparent; plays everywhere). Studio/Lossless are already
 * VLC/editor-only, so their audio is truly lossless ALAC.
 */
export function audioEncodeArgs(quality: Quality): string[] {
  return is444(quality) ? ['-c:a', 'alac'] : ['-c:a', 'aac', '-b:a', '320k']
}
// Accurate rounding and full-resolution chroma interpolation keep coloured text edges clean when
// converting the screen's RGB to video YUV (the default fast path smears them).
export const SWS_FLAGS = 'flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp'

function audioInputArgs(source: string): string[] {
  return ['-f', 'f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-thread_queue_size', '4096', '-i', source]
}

/**
 * Audio tracks of a recording. One source: just that track. Both: the mix first (so every player plays everything),
 * then the computer sound and the microphone as tracks of their own, which the editor can use separately.
 */
function audioGraph(inputs: AudioInput[], firstIndex: number): { graph: string | null; maps: string[]; names: string[] } {
  if (!inputs.length) return { graph: null, maps: [], names: [] }
  if (inputs.length === 1) {
    const only = inputs[0]
    const name = TRACK_NAMES[only.kind]
    if (only.volume === 1) return { graph: null, maps: [`${firstIndex}:a`], names: [name] }
    return { graph: `[${firstIndex}:a]volume=${only.volume.toFixed(2)},alimiter=limit=0.95[aout]`, maps: ['[aout]'], names: [name] }
  }
  const legs = inputs.map((a, i) => `[${firstIndex + i}:a]volume=${a.volume.toFixed(2)},asplit=2[m${i}][t${i}]`)
  const mix = `${inputs.map((_, i) => `[m${i}]`).join('')}amix=inputs=${inputs.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`
  return {
    graph: [...legs, mix].join(';'),
    maps: ['[aout]', ...inputs.map((_, i) => `[t${i}]`)],
    names: [TRACK_NAMES.mix, ...inputs.map((a) => TRACK_NAMES[a.kind])]
  }
}

export function buildRecordArgs(o: RecordArgsInput): string[] {
  const w = even(o.rect.width)
  const h = even(o.rect.height)
  const encoder = effectiveEncoder(o.encoder, o.quality)
  const out = outputSize(o.rect, o.outputHeight)
  const cursor = o.showCursor ? '1' : '0'

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y']
  const filters: string[] = []
  let videoLabel = '[0:v]'
  let audioIndex = 1

  if (o.backend === 'ddagrab') {
    if (!o.dda) throw new Error('ddagrab needs an adapter/output target')
    // ddagrab can only duplicate outputs of the D3D11 device it runs on, so bind it to the monitor's own GPU.
    args.push('-init_hw_device', `d3d11va=dda:${o.dda.adapter}`, '-filter_hw_device', 'dda')
    filters.push(
      `ddagrab=output_idx=${o.dda.output}:framerate=${o.fps}:draw_mouse=${cursor}:offset_x=${o.rect.x}:offset_y=${o.rect.y}:video_size=${w}x${h}`,
      'hwdownload',
      'format=bgra'
    )
    videoLabel = ''
    audioIndex = 0
  } else if (o.backend === 'avfoundation') {
    if (!o.avf) throw new Error('avfoundation needs a screen device')
    args.push(
      '-f', 'avfoundation', '-capture_cursor', cursor, '-capture_mouse_clicks', '0', '-framerate', String(o.fps),
      ...(o.avf.pixelFormat ? ['-pixel_format', o.avf.pixelFormat] : []),
      '-thread_queue_size', '1024', '-i', `${o.avf.device}:none`
    )
    // avfoundation always captures the whole screen; regions are cropped out of it.
    filters.push(`crop=${w}:${h}:${o.rect.x}:${o.rect.y}`)
  } else if (o.backend === 'x11grab') {
    args.push(
      '-f', 'x11grab', '-thread_queue_size', '1024', '-framerate', String(o.fps), '-draw_mouse', cursor,
      '-video_size', `${w}x${h}`, '-i', `${o.x11Display ?? ':0'}+${o.rect.x},${o.rect.y}`
    )
  } else {
    args.push(
      '-f', 'gdigrab', '-thread_queue_size', '1024', '-framerate', String(o.fps), '-draw_mouse', cursor,
      '-offset_x', String(o.rect.x), '-offset_y', String(o.rect.y), '-video_size', `${w}x${h}`, '-i', 'desktop'
    )
  }

  for (const a of o.audio) args.push(...audioInputArgs(a.url))

  const size = out.height !== h ? `w=${out.width}:h=${out.height}:` : ''
  // Tag and convert as BT.709 so colours don't shift in players that assume HD colourimetry.
  filters.push(`scale=${size}${SWS_FLAGS}:out_color_matrix=bt709:out_range=tv`, `format=${pixelFormatFor(encoder, o.quality)}`)
  const audio = audioGraph(o.audio, audioIndex)
  const graph = [`${videoLabel}${filters.join(',')}[v]`, audio.graph].filter(Boolean).join(';')

  args.push('-filter_complex', graph, '-map', '[v]')
  for (const m of audio.maps) args.push('-map', m)
  audio.names.forEach((n, i) => args.push(`-metadata:s:a:${i}`, `handler_name=${n}`))
  args.push('-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, out.width * out.height * o.fps, o.basicTuning), '-g', String(o.fps * 2))
  args.push(...COLOR_TAGS)
  if (audio.maps.length) args.push(...audioEncodeArgs(o.quality))
  // Fragmented MP4 stays playable up to the last keyframe if the app or PC crashes mid-recording.
  // A deep muxing queue lets audio wait for a slow-starting video encoder instead of aborting.
  args.push('-max_muxing_queue_size', '8192', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof')
  args.push('-stats_period', '1', '-progress', 'pipe:1', o.outputPath)
  return args
}

export function buildRemuxArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output]
}

/**
 * Joins the pieces of a paused-and-resumed recording into one MP4 without re-encoding anything. Every piece is made
 * with identical settings, so the streams line up exactly. `list` is an FFmpeg concat list (see `concatList`).
 */
export function buildConcatArgs(list: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output]
}

/** Last resort if the straight join can't be played: decode every piece and encode the whole thing again, very high quality. */
export function buildJoinReencodeArgs(inputs: string[], output: string, hasAudio: boolean, quality: Quality): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const i of inputs) args.push('-i', i)
  const legs = inputs.map((_, n) => `[${n}:v]${hasAudio ? `[${n}:a]` : ''}`).join('')
  args.push('-filter_complex', `${legs}concat=n=${inputs.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`, '-map', '[v]')
  if (hasAudio) args.push('-map', '[a]')
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', is444(quality) ? 'yuv444p' : 'yuv420p', ...COLOR_TAGS,
    ...(hasAudio ? audioEncodeArgs(quality) : []), '-movflags', '+faststart', output
  )
  return args
}

/** The text of an FFmpeg concat list: one `file` line per piece, with quotes escaped. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** Small H.264 4:2:0 copy for previewing recordings the built-in player can't decode (e.g. 4:4:4). */
export function buildProxyArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', "scale=-2:'min(720,ih)',format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output
  ]
}

export function buildEncoderProbeArgs(encoder: string, quality: Quality = 'veryhigh', basic = false): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=30',
    '-frames:v', '5', '-vf', `format=${pixelFormatFor(encoder, quality)}`,
    ...encoderArgs(encoder, quality, 0, basic),
    '-f', 'null', '-'
  ]
}

// ---------- other save formats ----------

/** Lossless re-wrap: the same video and audio streams copied into another container (no re-encode). */
export function buildCopyArgs(input: string, output: string, container: 'mp4' | 'mov' | 'mkv'): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    ...(container === 'mkv' ? [] : ['-movflags', '+faststart']), '-progress', 'pipe:1', output
  ]
}

export const GIF_MAX_FPS = 15
export const GIF_MAX_WIDTH = 1280

/** Turns the lossless PNG capture into a WebP (lossless) or a maximum-quality JPEG. */
export function buildImageConvertArgs(input: string, output: string, format: Exclude<ImageFormat, 'png'>): string[] {
  const head = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input]
  if (format === 'webp') return [...head, '-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', '-quality', '100', output]
  // Quality 1 is the best the JPEG encoder offers; 4:4:4 keeps colour edges (text) from smearing.
  return [...head, '-c:v', 'mjpeg', '-q:v', '1', '-pix_fmt', 'yuvj444p', output]
}
