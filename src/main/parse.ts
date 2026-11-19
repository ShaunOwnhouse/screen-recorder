export interface Progress {
  frame: number
  totalSize: number
  outTimeUs: number
  dropFrames: number
  speed: number | null
  ended: boolean
}

/** Accumulates `-progress pipe:1` key=value output and emits one Progress per block. */
export class ProgressParser {
  private buffer = ''
  private fields: Record<string, string> = {}

  push(chunk: string): Progress[] {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    const out: Progress[] = []
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      this.fields[key] = value
      if (key === 'progress') {
        out.push(toProgress(this.fields))
        this.fields = {}
      }
    }
    return out
  }
}

export interface MediaInfo {
  width: number
  height: number
  fps: number
  duration: number
  yuv444: boolean
  hasAudio: boolean
}

/** Reads the stream summary FFmpeg prints for `ffmpeg -i file`. */
export function parseMediaInfo(stderr: string): MediaInfo | null {
  const video = stderr.split(/\r?\n/).find((l) => /Stream #.*: Video:/.test(l))
  if (!video) return null
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(video.slice(video.indexOf('Video:')))
  if (!size) return null
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const fps = /([\d.]+) fps/.exec(video)
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    fps: fps ? Math.round(Number(fps[1])) : 30,
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    yuv444: /yuv444p/.test(video),
    hasAudio: /Stream #.*: Audio:/.test(stderr)
  }
}

function num(v: string | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function toProgress(f: Record<string, string>): Progress {
  const speed = f.speed && f.speed !== 'N/A' ? parseFloat(f.speed) : NaN
  return {
    frame: num(f.frame),
    totalSize: num(f.total_size),
    outTimeUs: num(f.out_time_us ?? f.out_time_ms),
    dropFrames: num(f.drop_frames),
    speed: Number.isFinite(speed) ? speed : null,
    ended: f.progress === 'end'
  }
}

export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  let end = m[1] && m[2] ? Number(m[2]) : size - 1
  end = Math.min(end, size - 1)
  start = Math.min(start, end)
  return { start, end }
}
