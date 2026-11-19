import { execFile } from 'node:child_process'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { buildEncoderProbeArgs, ENCODER_LABELS, HARDWARE_ENCODERS, YUV444_CAPABLE } from './args.ts'
import { parseAvfoundationScreens } from './parse.ts'
import type { EncoderInfo, Quality } from '../shared/types.ts'

export function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string | null
  if (!p) throw new Error('FFmpeg binary not found for this platform.')
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

export function runFfmpeg(args: string[], timeoutMs = 20000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Like runFfmpeg, but returns stdout as raw bytes (for grabbing a frame of pixels). */
export function runFfmpegBinary(args: string[], timeoutMs = 15000): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath(), args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout as Buffer, stderr: String(stderr) })
    )
  })
}

export interface FfmpegFeatures {
  version: string
  ddagrab: boolean
  encoders: EncoderInfo[]
}

let cached: Promise<FfmpegFeatures> | null = null

export function detectFeatures(refresh = false): Promise<FfmpegFeatures> {
  if (!cached || refresh) cached = detect()
  return cached
}

async function probe(encoder: string, quality: Quality, basic = false): Promise<boolean> {
  return (await runFfmpeg(buildEncoderProbeArgs(encoder, quality, basic))).ok
}

async function detect(): Promise<FfmpegFeatures> {
  const [version, filters, encoderList] = await Promise.all([
    runFfmpeg(['-hide_banner', '-version']),
    runFfmpeg(['-hide_banner', '-filters']),
    runFfmpeg(['-hide_banner', '-encoders'])
  ])

  // Listing an encoder doesn't mean the GPU/driver supports it, so each one is test-encoded.
  const candidates = HARDWARE_ENCODERS.filter((e) => new RegExp(`\\b${e}\\b`).test(encoderList.stdout))
  const results = await Promise.all(
    candidates.map(async (id): Promise<EncoderInfo | null> => {
      if (!(await probe(id, 'veryhigh'))) return null
      const tuned = await probe(id, 'maximum')
      const yuv444 = YUV444_CAPABLE.includes(id) && (await probe(id, 'studio', !tuned))
      return { id, label: ENCODER_LABELS[id] ?? id, yuv444, tuned }
    })
  )

  return {
    version: version.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '').split(' ')[0] ?? 'unknown',
    ddagrab: /\bddagrab\b/.test(filters.stdout),
    encoders: [...results.filter((e): e is EncoderInfo => e !== null), { id: 'libx264', label: ENCODER_LABELS.libx264, yuv444: true, tuned: true }]
  }
}

/** Picks the encoder for a recording, falling back to x264 when 4:4:4 is needed but unsupported. */
export function chooseEncoder(available: EncoderInfo[], requested: string, quality: Quality): string {
  const needs444 = quality === 'studio'
  const usable = available.filter((e) => !needs444 || e.yuv444)
  if (requested !== 'auto' && usable.some((e) => e.id === requested)) return requested
  const ids = usable.map((e) => e.id)
  return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'hevc_nvenc'].find((e) => ids.includes(e)) ?? 'libx264'
}

/** True when the chosen encoder can't take the top-tier tuning options. */
export function needsBasicTuning(available: EncoderInfo[], encoder: string): boolean {
  return available.find((e) => e.id === encoder)?.tuned === false
}

/** macOS: "Capture screen N" → avfoundation device index (cameras are numbered first). */
export async function avfoundationScreens(): Promise<Map<number, number>> {
  if (process.platform !== 'darwin') return new Map()
  const { stderr } = await runFfmpeg(['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], 15000)
  return parseAvfoundationScreens(stderr)
}
