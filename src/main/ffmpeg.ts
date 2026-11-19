import { execFile } from 'node:child_process'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { buildEncoderProbeArgs, ENCODER_LABELS, HARDWARE_ENCODERS } from './args.ts'
import { parseDshowAudioDevices } from './parse.ts'
import type { EncoderInfo } from '../shared/types.ts'

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

export interface FfmpegFeatures {
  version: string
  ddagrab: boolean
  encoders: EncoderInfo[]
  audioDevices: string[]
}

let cached: Promise<FfmpegFeatures> | null = null

export function detectFeatures(refresh = false): Promise<FfmpegFeatures> {
  if (!cached || refresh) cached = detect()
  return cached
}

async function detect(): Promise<FfmpegFeatures> {
  const [version, filters, encoderList, devices] = await Promise.all([
    runFfmpeg(['-hide_banner', '-version']),
    runFfmpeg(['-hide_banner', '-filters']),
    runFfmpeg(['-hide_banner', '-encoders']),
    process.platform === 'win32'
      ? runFfmpeg(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
      : Promise.resolve({ ok: false, stdout: '', stderr: '' })
  ])

  // Listing an encoder doesn't mean the GPU/driver supports it, so each one is test-encoded.
  const candidates = HARDWARE_ENCODERS.filter((e) => new RegExp(`\\b${e}\\b`).test(encoderList.stdout))
  const probes = await Promise.all(candidates.map(async (e) => ((await runFfmpeg(buildEncoderProbeArgs(e))).ok ? e : null)))
  const working = probes.filter((e): e is (typeof HARDWARE_ENCODERS)[number] => e !== null)

  return {
    version: version.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '').split(' ')[0] ?? 'unknown',
    ddagrab: /\bddagrab\b/.test(filters.stdout),
    encoders: [...working, 'libx264'].map((id) => ({ id, label: ENCODER_LABELS[id] ?? id })),
    audioDevices: parseDshowAudioDevices(devices.stderr)
  }
}

export function pickAutoEncoder(available: EncoderInfo[]): string {
  const ids = available.map((e) => e.id)
  return ['h264_nvenc', 'h264_qsv', 'h264_amf'].find((e) => ids.includes(e)) ?? 'libx264'
}
