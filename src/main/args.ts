import type { Quality, Rect, Segment } from '../shared/types.ts'

export interface DdaTarget {
  adapter: number
  output: number
}

export interface RecordArgsInput {
  backend: 'ddagrab' | 'gdigrab'
  /** Required for ddagrab: which GPU adapter and output (monitor) to duplicate. */
  dda?: DdaTarget
  /** Physical pixels. gdigrab: virtual-desktop coords. ddagrab: relative to the output's top-left. */
  rect: Rect
  fps: number
  outputHeight: number | null
  quality: Quality
  encoder: string
  /** Named pipe / socket carrying 48 kHz stereo f32le PCM, or null for no audio. */
  audioInput: string | null
  showCursor: boolean
  outputPath: string
}

export const HARDWARE_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'] as const

export const ENCODER_LABELS: Record<string, string> = {
  libx264: 'CPU (x264)',
  h264_nvenc: 'NVIDIA H.264',
  hevc_nvenc: 'NVIDIA HEVC',
  h264_qsv: 'Intel H.264',
  hevc_qsv: 'Intel HEVC',
  h264_amf: 'AMD H.264',
  hevc_amf: 'AMD HEVC'
}

/** Encoders that can be asked for full 4:4:4 chroma (hardware ones are also probed at runtime). */
export const YUV444_CAPABLE = ['libx264', 'h264_nvenc', 'hevc_nvenc']

export const AUDIO_RATE = 48000

// yuv420p needs even dimensions.
export function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

export function is444(quality: Quality): boolean {
  return quality === 'maximum' || quality === 'lossless'
}

export function effectiveEncoder(encoder: string, quality: Quality): string {
  if (quality === 'lossless') return 'libx264'
  if (quality === 'maximum' && !YUV444_CAPABLE.includes(encoder)) return 'libx264'
  return encoder
}

export function pixelFormatFor(encoder: string, quality: Quality): string {
  if (is444(quality)) return 'yuv444p'
  if (encoder.endsWith('_qsv')) return 'nv12'
  return 'yuv420p'
}

const CQ: Record<Exclude<Quality, 'lossless'>, number> = { high: 20, veryhigh: 16, maximum: 13 }

export function encoderArgs(encoder: string, quality: Quality, pixelRate: number): string[] {
  if (quality === 'lossless') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0']

  const q = CQ[quality]
  const full = is444(quality)
  const hevcQ = String(q + 2)
  switch (encoder) {
    case 'h264_nvenc':
    case 'hevc_nvenc': {
      const hevc = encoder === 'hevc_nvenc'
      return [
        '-c:v', encoder, '-preset', full ? 'p6' : 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', hevc ? hevcQ : String(q), '-b:v', '0',
        // Adaptive quantisation spends bits on detail (text, edges) instead of flat areas.
        '-spatial_aq', '1', '-rc-lookahead', '20',
        '-profile:v', hevc ? (full ? 'rext' : 'main') : full ? 'high444p' : 'high',
        ...(hevc ? ['-tag:v', 'hvc1'] : [])
      ]
    }
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'medium', '-global_quality', String(q)]
    case 'hevc_qsv':
      return ['-c:v', encoder, '-preset', 'medium', '-global_quality', hevcQ, '-tag:v', 'hvc1']
    case 'h264_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-qp_b', String(q)]
    case 'hevc_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', hevcQ, '-qp_p', hevcQ, '-tag:v', 'hvc1']
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
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '256k']

function audioInputArgs(source: string): string[] {
  return ['-f', 'f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-thread_queue_size', '4096', '-i', source]
}

export function buildRecordArgs(o: RecordArgsInput): string[] {
  const w = even(o.rect.width)
  const h = even(o.rect.height)
  const encoder = effectiveEncoder(o.encoder, o.quality)
  const out = outputSize(o.rect, o.outputHeight)
  const cursor = o.showCursor ? '1' : '0'

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y']
  const filters: string[] = []
  let audioIndex = 0

  if (o.backend === 'ddagrab') {
    if (!o.dda) throw new Error('ddagrab needs an adapter/output target')
    // ddagrab can only duplicate outputs of the D3D11 device it runs on, so bind it to the monitor's own GPU.
    args.push('-init_hw_device', `d3d11va=dda:${o.dda.adapter}`, '-filter_hw_device', 'dda')
    filters.push(
      `ddagrab=output_idx=${o.dda.output}:framerate=${o.fps}:draw_mouse=${cursor}:offset_x=${o.rect.x}:offset_y=${o.rect.y}:video_size=${w}x${h}`,
      'hwdownload',
      'format=bgra'
    )
  } else {
    args.push(
      '-f', 'gdigrab', '-thread_queue_size', '1024', '-framerate', String(o.fps), '-draw_mouse', cursor,
      '-offset_x', String(o.rect.x), '-offset_y', String(o.rect.y), '-video_size', `${w}x${h}`, '-i', 'desktop'
    )
    audioIndex = 1
  }

  if (o.audioInput) args.push(...audioInputArgs(o.audioInput))

  const size = out.height !== h ? `w=${out.width}:h=${out.height}:flags=lanczos:` : ''
  // Tag and convert as BT.709 so colours don't shift in players that assume HD colourimetry.
  filters.push(`scale=${size}out_color_matrix=bt709:out_range=tv`, `format=${pixelFormatFor(encoder, o.quality)}`)
  const graph = o.backend === 'ddagrab' ? `${filters.join(',')}[v]` : `[0:v]${filters.join(',')}[v]`

  args.push('-filter_complex', graph, '-map', '[v]')
  if (o.audioInput) args.push('-map', `${audioIndex}:a`)
  args.push('-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, out.width * out.height * o.fps), '-g', String(o.fps * 2))
  args.push(...COLOR_TAGS)
  if (o.audioInput) args.push(...AUDIO_ENCODE)
  // Fragmented MP4 stays playable up to the last keyframe if the app or PC crashes mid-recording.
  args.push('-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof')
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
}

export function buildExportArgs(o: ExportArgsInput): string[] {
  const encoder = effectiveEncoder(o.encoder, o.quality)
  const keep = o.segments.map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`).join('+')

  const v = [`select=${keep}`, 'setpts=N/FRAME_RATE/TB']
  if (o.crop) v.push(`crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}`)
  v.push(`format=${pixelFormatFor(encoder, o.quality)}`)

  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', o.input, '-vf', v.join(',')]
  if (o.hasAudio) args.push('-af', `aselect=${keep},asetpts=N/SR/TB`)
  else args.push('-an')
  args.push('-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, o.pixelRate), '-g', String(o.fps * 2))
  args.push(...COLOR_TAGS)
  if (o.hasAudio) args.push(...AUDIO_ENCODE)
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

export function buildEncoderProbeArgs(encoder: string, quality: Quality = 'veryhigh'): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=30',
    '-frames:v', '5', '-vf', `format=${pixelFormatFor(encoder, quality)}`,
    ...encoderArgs(encoder, quality, 0),
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
