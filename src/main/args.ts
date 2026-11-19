import type { Quality, Rect, Segment } from '../shared/types.ts'

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
}

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

const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
/**
 * Playable tiers use AAC-LC at 320 kb/s (transparent; plays everywhere). Studio/Lossless are already
 * VLC/editor-only, so their audio is truly lossless ALAC.
 */
export function audioEncodeArgs(quality: Quality): string[] {
  return is444(quality) ? ['-c:a', 'alac'] : ['-c:a', 'aac', '-b:a', '320k']
}
// Accurate rounding and full-resolution chroma interpolation keep coloured text edges clean when
// converting the screen's RGB to video YUV (the default fast path smears them).
const SWS_FLAGS = 'flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp'

function audioInputArgs(source: string): string[] {
  return ['-f', 'f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-thread_queue_size', '4096', '-i', source]
}

/** Audio graph: one untouched source maps straight through; otherwise apply gains and mix. */
function audioGraph(inputs: AudioInput[], firstIndex: number): { graph: string | null; map: string | null } {
  if (!inputs.length) return { graph: null, map: null }
  if (inputs.length === 1 && inputs[0].volume === 1) return { graph: null, map: `${firstIndex}:a` }
  const legs = inputs.map((a, i) => `[${firstIndex + i}:a]volume=${a.volume.toFixed(2)}[a${i}]`)
  const mix =
    inputs.length === 1
      ? '[a0]alimiter=limit=0.95[aout]'
      : `${inputs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${inputs.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`
  return { graph: [...legs, mix].join(';'), map: '[aout]' }
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
  if (audio.map) args.push('-map', audio.map)
  args.push('-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, out.width * out.height * o.fps, o.basicTuning), '-g', String(o.fps * 2))
  args.push(...COLOR_TAGS)
  if (audio.map) args.push(...audioEncodeArgs(o.quality))
  // Fragmented MP4 stays playable up to the last keyframe if the app or PC crashes mid-recording.
  // A deep muxing queue lets audio wait for a slow-starting video encoder instead of aborting.
  args.push('-max_muxing_queue_size', '8192', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof')
  args.push('-stats_period', '1', '-progress', 'pipe:1', o.outputPath)
  return args
}

export function buildRemuxArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output]
}

export interface ExportArgsInput {
  input: string
  output: string
  segments: Segment[]
  /** Source pixels, already even-aligned, or null for the full frame. */
  crop: Rect | null
  hasAudio: boolean
  fps: number
  quality: Quality
  encoder: string
  pixelRate: number
  basicTuning?: boolean
}

export function buildExportArgs(o: ExportArgsInput): string[] {
  const encoder = effectiveEncoder(o.encoder, o.quality)
  const keep = o.segments.map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`).join('+')

  const v = [`select=${keep}`, 'setpts=N/FRAME_RATE/TB']
  if (o.crop) v.push(`crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}`)
  v.push(`scale=${SWS_FLAGS}`, `format=${pixelFormatFor(encoder, o.quality)}`)

  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', o.input, '-vf', v.join(',')]
  if (o.hasAudio) args.push('-af', `aselect=${keep},asetpts=N/SR/TB`)
  else args.push('-an')
  args.push('-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, o.pixelRate, o.basicTuning), '-g', String(o.fps * 2))
  args.push(...COLOR_TAGS)
  if (o.hasAudio) args.push(...audioEncodeArgs(o.quality))
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', o.output)
  return args
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

/** Converts a normalised crop into even, in-bounds source pixels (null if it covers the whole frame). */
export function cropToPixels(crop: Rect | null, width: number, height: number): Rect | null {
  if (!crop) return null
  const evenOffset = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)
  const x = evenOffset(Math.round(crop.x * width))
  const y = evenOffset(Math.round(crop.y * height))
  const w = Math.min(even(Math.round(crop.width * width)), even(width - x))
  const h = Math.min(even(Math.round(crop.height * height)), even(height - y))
  if (w >= even(width) && h >= even(height)) return null
  return { x, y, width: w, height: h }
}
