import type { Quality, Rect } from '../shared/types.ts'

export interface RecordArgsInput {
  backend: 'ddagrab' | 'gdigrab'
  /** Physical pixels. gdigrab: virtual-desktop coords. ddagrab: relative to the primary monitor. */
  rect: Rect
  fps: number
  outputHeight: number | null
  quality: Quality
  encoder: string
  audioDevice: string | null
  showCursor: boolean
  outputPath: string
}

export const HARDWARE_ENCODERS = [
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf'
] as const

export const ENCODER_LABELS: Record<string, string> = {
  libx264: 'CPU (x264)',
  h264_nvenc: 'NVIDIA H.264',
  hevc_nvenc: 'NVIDIA HEVC',
  h264_qsv: 'Intel H.264',
  hevc_qsv: 'Intel HEVC',
  h264_amf: 'AMD H.264',
  hevc_amf: 'AMD HEVC'
}

// yuv420p needs even dimensions.
export function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

export function pixelFormatFor(encoder: string, quality: Quality): string {
  if (quality === 'lossless') return 'yuv444p'
  if (encoder.endsWith('_qsv')) return 'nv12'
  return 'yuv420p'
}

export function encoderArgs(encoder: string, quality: Quality, pixelRate: number): string[] {
  if (quality === 'lossless') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0']

  const q = quality === 'veryhigh' ? 16 : 20
  const hevcQ = String(q + 2)
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', encoder, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-profile:v', 'high']
    case 'hevc_nvenc':
      return ['-c:v', encoder, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', hevcQ, '-b:v', '0', '-tag:v', 'hvc1']
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
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(q - 2), '-profile:v', 'high']
    }
  }
}

export function outputSize(rect: Rect, outputHeight: number | null): { width: number; height: number } {
  const width = even(rect.width)
  const height = even(rect.height)
  if (!outputHeight || outputHeight === height) return { width, height }
  return { width: even((width * outputHeight) / height), height: outputHeight }
}

export function buildRecordArgs(o: RecordArgsInput): string[] {
  const w = even(o.rect.width)
  const h = even(o.rect.height)
  const encoder = o.quality === 'lossless' ? 'libx264' : o.encoder
  const out = outputSize(o.rect, o.outputHeight)
  const cursor = o.showCursor ? '1' : '0'

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y']

  if (o.backend === 'gdigrab') {
    args.push(
      '-f', 'gdigrab', '-thread_queue_size', '1024', '-framerate', String(o.fps), '-draw_mouse', cursor,
      '-offset_x', String(o.rect.x), '-offset_y', String(o.rect.y), '-video_size', `${w}x${h}`, '-i', 'desktop'
    )
  } else {
    args.push(
      '-f', 'lavfi', '-i',
      `ddagrab=output_idx=0:framerate=${o.fps}:draw_mouse=${cursor}:offset_x=${o.rect.x}:offset_y=${o.rect.y}:video_size=${w}x${h}`
    )
  }

  if (o.audioDevice) {
    args.push('-f', 'dshow', '-thread_queue_size', '1024', '-rtbufsize', '256M', '-i', `audio=${o.audioDevice}`)
  }

  const filters: string[] = []
  if (o.backend === 'ddagrab') filters.push('hwdownload', 'format=bgra')
  const size = out.height !== h ? `w=${out.width}:h=${out.height}:flags=lanczos:` : ''
  // Tag and convert as BT.709 so colours don't shift in players that assume HD colourimetry.
  filters.push(`scale=${size}out_color_matrix=bt709:out_range=tv`, `format=${pixelFormatFor(encoder, o.quality)}`)

  args.push('-map', '0:v')
  if (o.audioDevice) args.push('-map', '1:a')
  args.push('-vf', filters.join(','), '-fps_mode', 'cfr', '-r', String(o.fps))
  args.push(...encoderArgs(encoder, o.quality, out.width * out.height * o.fps), '-g', String(o.fps * 2))
  args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv')
  if (o.audioDevice) args.push('-c:a', 'aac', '-b:a', '192k')
  // Fragmented MP4 stays playable up to the last keyframe if the app or PC crashes mid-recording.
  args.push('-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof')
  args.push('-stats_period', '1', '-progress', 'pipe:1', o.outputPath)
  return args
}

export function buildRemuxArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output]
}

export function buildEncoderProbeArgs(encoder: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=30',
    '-frames:v', '5', '-vf', `format=${pixelFormatFor(encoder, 'high')}`,
    ...encoderArgs(encoder, 'high', 0),
    '-f', 'null', '-'
  ]
}
