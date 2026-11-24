import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { runFfmpeg, runFfmpegBinary } from './ffmpeg.ts'
import { probeMedia } from './verify.ts'
import { bestLag, envelope } from '../shared/sync.ts'

export interface CameraResult {
  /** The finished camera video (a normal H.264 MP4). */
  file: string
  /** Camera time = recording time + offset, in seconds. */
  offset: number
  width: number
  height: number
  duration: number
  /** The camera file carries the person's voice too. */
  hasAudio: boolean
  /** How the offset was found: by matching the voice in both, or only from when each started. */
  method: 'voice' | 'clock'
}

/** A few seconds of the sound of a file as mono samples, for comparing recordings. */
async function listen(file: string, seconds: number): Promise<Float32Array | null> {
  const res = await runFfmpegBinary(['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-t', String(seconds), '-f', 'f32le', '-'], 60000)
  if (!res.ok || res.stdout.length < 8000) return null
  const b = res.stdout
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)))
}

/** Turns the camera's raw recording into a normal, seekable H.264 video (done while the screen recording is being finished). */
export async function convertCamera(raw: string, out: string, fps: number, note?: (t: string) => void): Promise<boolean> {
  if (!existsSync(raw)) return false
  const rate = Math.max(10, Math.min(30, Math.round(fps)))
  const withVoice = !!(await probeMedia(raw))?.hasAudio
  // The voice stays with the picture in the same file, so the two can never drift apart.
  const audio = withVoice ? ['-map', '0:v:0', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0'] : ['-an']
  const res = await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, ...audio, '-vf', `fps=${rate},scale=-2:'min(720,ih)',format=yuv420p`, '-c:v', 'libx264', '-preset', 'superfast', '-crf', '21', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', out],
    20 * 60 * 1000
  )
  if (!res.ok || !existsSync(out)) {
    note?.(`camera: could not make the camera video: ${res.stderr.trim().split(/\r?\n/).pop() ?? ''}`)
    rmSync(out, { force: true })
    return false
  }
  return true
}

/**
 * Works out how the camera lines up with the screen recording. Both heard the same microphone, so when each has sound the
 * voice is matched exactly; otherwise it goes by when each one began. `raw` is the camera's own recording (it has the sound).
 */
export async function alignCamera(opts: {
  raw: string
  video: string
  screen: string
  /** When the camera and the screen recording began (wall clock, ms). */
  cameraStart: number
  screenStart: number
  note?: (text: string) => void
}): Promise<CameraResult | null> {
  const clock = (opts.screenStart - opts.cameraStart) / 1000
  let offset = clock
  let method: CameraResult['method'] = 'clock'
  try {
    const [a, b] = await Promise.all([listen(opts.screen, 120), listen(opts.raw, 120)])
    if (a && b) {
      const step = 0.01
      const m = bestLag(envelope(a, 80), envelope(b, 80), 250, Math.round(clock / step))
      opts.note?.(`camera: clock says ${clock.toFixed(2)}s; voice match ${m ? `${(m.lag * step).toFixed(2)}s (score ${m.score.toFixed(2)}, strength ${m.strength.toFixed(2)})` : 'none'}`)
      if (m && m.score > 0.55 && m.strength > 0.08) {
        offset = m.lag * step
        method = 'voice'
      }
    }
  } catch (err) {
    opts.note?.(`camera: voice match failed: ${(err as Error).message}`)
  }
  const meta = await probeMedia(opts.video)
  if (!meta) return null
  return { file: opts.video, offset, width: meta.width, height: meta.height, duration: meta.duration, hasAudio: meta.hasAudio, method }
}

export function writeCameraInfo(path: string, r: CameraResult): void {
  writeFileSync(path, JSON.stringify({ offset: r.offset, width: r.width, height: r.height, duration: r.duration, hasAudio: r.hasAudio, method: r.method }))
}
