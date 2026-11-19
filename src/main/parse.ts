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

/** Parses `ffmpeg -list_devices true -f dshow -i dummy` (both old and new output formats). */
export function parseDshowAudioDevices(stderr: string): string[] {
  const devices: string[] = []
  let section: 'audio' | 'video' | null = null
  for (const line of stderr.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) section = 'audio'
    else if (/DirectShow video devices/i.test(line)) section = 'video'
    if (/Alternative name/i.test(line)) continue

    const tagged = line.match(/"([^"]+)"\s+\((audio|video|none|audio, video)\)/)
    if (tagged) {
      if (tagged[2].includes('audio')) devices.push(tagged[1])
      continue
    }
    const plain = line.match(/\]\s+"([^"]+)"\s*$/)
    if (plain && section === 'audio') devices.push(plain[1])
  }
  return [...new Set(devices)]
}
