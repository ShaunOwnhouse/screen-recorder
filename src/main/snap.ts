import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, desktopCapturer, nativeImage, screen, type Display } from 'electron'
import type { RecordArgsInput } from './args.ts'
import { buildShotArgs } from './barprobe.ts'
import { cropBox, pngSize } from './crop.ts'
import { runFfmpegBinary } from './ffmpeg.ts'
import type { CaptureMode, Rect, Settings } from '../shared/types.ts'

type Attempt = Omit<RecordArgsInput, 'outputPath'>

/** Temporary pictures (frozen screens, screenshots waiting for review). Wiped at start-up and after every snap. */
export function shotTmpDir(): string {
  const dir = join(app.getPath('userData'), 'shots-tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function clearShotTmp(): void {
  for (const n of readdirSync(shotTmpDir())) rmSync(join(shotTmpDir(), n), { force: true })
}

/** The sharpest crop of a captured screen: the selection (DIP, screen coordinates) mapped onto the picture's real pixels. */
export function cropCapture(png: Buffer, display: Pick<Display, 'bounds'>, rect: Rect): Buffer {
  const size = pngSize(png)
  if (!size) throw new Error('The screen capture was not a valid picture.')
  const box = cropBox(size, display.bounds, rect)
  return box ? nativeImage.createFromBuffer(png, { scaleFactor: 1 }).crop(box).toPNG() : png
}

export interface SnapDeps {
  settings: () => Settings
  /** Capture methods to try for a whole display, best first. */
  attempts: (display: Display) => Promise<Attempt[]>
  /** Shows the overlay on every screen (with the frozen pictures behind it) and resolves with the choice. */
  choose: (mode: CaptureMode, frozen: Map<number, string>) => Promise<{ display: Display; rect: Rect } | null>
  /** The 3-2-1 before the capture; false if cancelled. */
  countdown: (display: Display, seconds: number) => Promise<boolean>
  /** Hides this app's own windows so they can't be in the picture; returns a function that shows them again. */
  hideApp: () => () => void
  setBusy: (busy: boolean) => void
  open: (png: Buffer) => void
  fail: (message: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Takes a screenshot: freeze every screen at its real pixel size, let the user pick, hand the result to review. */
export class Snapper {
  private running = false

  constructor(private readonly deps: SnapDeps) {}

  get busy(): boolean {
    return this.running
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.deps.setBusy(true)
    const restore = this.deps.hideApp()
    try {
      const s = this.deps.settings()
      const displays = screen.getAllDisplays()
      if (s.shotDelay > 0) {
        const where = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        if (!(await this.deps.countdown(where, s.shotDelay))) return
      }
      await sleep(350) // let our own windows finish disappearing before the screen is read

      const frames = new Map<number, Buffer>()
      await Promise.all(displays.map(async (d) => frames.set(d.id, await this.capture(d, s.shotCursor))))

      const frozen = new Map<number, string>()
      for (const [id, png] of frames) {
        const name = `frozen-${id}.png`
        writeFileSync(join(shotTmpDir(), name), png)
        frozen.set(id, name)
      }

      const picked = await this.deps.choose(s.shotMode, frozen)
      if (!picked) return
      const png = cropCapture(frames.get(picked.display.id)!, picked.display, picked.rect)

      if (s.shotClipboard) clipboard.writeImage(nativeImage.createFromBuffer(png, { scaleFactor: 1 }))
      this.deps.open(png)
    } catch (err) {
      this.deps.fail(`The screenshot failed: ${(err as Error).message}`)
    } finally {
      for (const n of readdirSync(shotTmpDir())) if (n.startsWith('frozen-')) rmSync(join(shotTmpDir(), n), { force: true })
      restore()
      this.running = false
      this.deps.setBusy(false)
    }
  }

  /** One lossless picture of a whole screen, the same way recording would capture it; Electron's own capture is the fallback. */
  private async capture(display: Display, cursor: boolean): Promise<Buffer> {
    for (const attempt of await this.deps.attempts(display)) {
      const res = await runFfmpegBinary(buildShotArgs(attempt, cursor), 20000)
      if (res.ok && pngSize(res.stdout)) return res.stdout
    }
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find((x) => x.display_id === String(display.id)) ?? sources[0]
    if (source && !source.thumbnail.isEmpty()) return source.thumbnail.toPNG()
    throw new Error('Could not capture the screen.')
  }
}
