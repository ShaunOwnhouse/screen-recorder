import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { buildExportArgs, buildProxyArgs, cropToPixels } from './args.ts'
import { chooseEncoder, ffmpegPath, needsBasicTuning, runFfmpeg } from './ffmpeg.ts'
import { mediaUrl } from './media-protocol.ts'
import { parseMediaInfo, ProgressParser } from './parse.ts'
import { moveFile, proxyPathFor, removePending, sanitizeFileName, uniquePath } from './pending.ts'
import { isFullRange, totalDuration } from '../shared/segments.ts'
import type { EditorLoad } from '../shared/api.ts'
import type { EncoderInfo, Rect, RecordingMeta, SaveRequest, Settings } from '../shared/types.ts'

interface Deps {
  preload: string
  icon: string
  load: (win: BrowserWindow) => void
  settings: () => Settings
  encoders: () => Promise<EncoderInfo[]>
  onSaved: (path: string) => void
  onDiscarded: () => void
  onClosed: () => void
}

export async function probeMedia(file: string): Promise<RecordingMeta | null> {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file])
  return parseMediaInfo(stderr)
}

export class EditorController {
  private win: BrowserWindow | null = null
  private file: string | null = null
  private exportProc: ChildProcess | null = null
  private cancelled = false

  constructor(private readonly deps: Deps) {
    ipcMain.handle('editor:load', (e) => (this.owns(e.sender) ? this.source() : { error: 'Not available.' }))
    ipcMain.handle('editor:reveal', (e) => {
      if (this.owns(e.sender) && this.file && existsSync(this.file)) shell.showItemInFolder(this.file)
    })
    ipcMain.handle('editor:proxy', (e) => (this.owns(e.sender) ? this.makeProxy() : ''))
    ipcMain.handle('editor:save', (e, req: SaveRequest) => (this.owns(e.sender) ? this.save(req) : { ok: false }))
    ipcMain.handle('editor:cancel', (e) => {
      if (!this.owns(e.sender)) return
      this.cancelled = true
      this.exportProc?.kill()
    })
    ipcMain.handle('editor:discard', (e) => (this.owns(e.sender) ? this.discard() : false))
  }

  private owns(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents
  }

  get currentFile(): string | null {
    return this.file
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  open(file: string): void {
    this.file = file
    if (this.win && !this.win.isDestroyed()) {
      this.deps.load(this.win)
      this.win.show()
      this.win.focus()
      return
    }
    this.win = new BrowserWindow({
      width: 1180,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      title: 'Review recording',
      backgroundColor: '#101216',
      autoHideMenuBar: true,
      icon: this.deps.icon,
      webPreferences: { preload: this.deps.preload }
    })
    this.win.setContentProtection(true)
    this.win.once('ready-to-show', () => {
      this.win?.show()
      this.win?.focus()
    })
    this.win.on('close', (e) => {
      if (this.exportProc) e.preventDefault()
    })
    this.win.on('closed', () => {
      this.win = null
      this.deps.onClosed()
    })
    this.deps.load(this.win)
  }

  close(): void {
    this.file = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }

  private async source(): Promise<EditorLoad> {
    const file = this.file
    if (!file || !existsSync(file)) return { error: 'This recording has already been saved or deleted.' }
    const meta = await probeMedia(file)
    if (!meta) {
      return { error: 'This recording can’t be opened — it has no video in it (the recording probably failed). You can discard it.' }
    }
    const name = basename(file)
    return {
      source: {
      name,
      url: mediaUrl(name),
      meta,
      sizeBytes: statSync(file).size,
      defaultName: name.replace(/\.mp4$/i, ''),
      outputDir: this.deps.settings().outputDir
      }
    }
  }

  private async makeProxy(): Promise<string> {
    const file = this.file
    if (!file) return ''
    const proxy = proxyPathFor(file)
    if (!existsSync(proxy)) {
      const res = await runFfmpeg(buildProxyArgs(file, proxy), 60 * 60 * 1000)
      if (!res.ok) {
        rmSync(proxy, { force: true })
        return ''
      }
    }
    return mediaUrl(basename(proxy))
  }

  private async save(req: SaveRequest): Promise<{ ok: boolean; path?: string; error?: string }> {
    const file = this.file
    const win = this.win
    if (!file || !win || this.exportProc) return { ok: false }
    const meta = await probeMedia(file)
    if (!meta) return { ok: false, error: 'Could not read the recording.' }

    const outputDir = this.deps.settings().outputDir
    const fileName = sanitizeFileName(req.fileName, basename(file, '.mp4'))
    let target: string
    if (req.saveAs) {
      const res = await dialog.showSaveDialog(win, {
        title: 'Save recording',
        defaultPath: join(outputDir, fileName),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
      })
      if (res.canceled || !res.filePath) return { ok: false }
      target = /\.mp4$/i.test(res.filePath) ? res.filePath : `${res.filePath}.mp4`
      mkdirSync(dirname(target), { recursive: true })
    } else {
      mkdirSync(outputDir, { recursive: true })
      target = uniquePath(outputDir, fileName)
    }

    const segments = req.segments.length ? req.segments : [[0, meta.duration] as [number, number]]
    const crop = cropToPixels(req.crop, meta.width, meta.height)
    const convert = meta.yuv444 && req.compatible
    try {
      if (!crop && !convert && isFullRange(segments, meta.duration)) {
        // Untouched recording: move it as-is — no re-encode, zero quality loss.
        moveFile(file, target)
      } else {
        await this.export(file, target, meta, segments, crop, convert)
      }
    } catch (err) {
      rmSync(target, { force: true })
      return this.cancelled ? { ok: false } : { ok: false, error: (err as Error).message }
    }

    removePending(file)
    this.close()
    this.deps.onSaved(target)
    return { ok: true, path: target }
  }

  private async export(
    file: string, target: string, meta: RecordingMeta, segments: [number, number][], crop: Rect | null, compatible: boolean
  ): Promise<void> {
    // Re-encode at the top tier so edits don't visibly lose quality.
    const quality = meta.yuv444 && !compatible ? 'studio' : 'maximum'
    const s = this.deps.settings()
    const encoders = await this.deps.encoders()
    const encoder = chooseEncoder(encoders, s.encoder, quality)
    const w = crop?.width ?? meta.width
    const h = crop?.height ?? meta.height
    const args = buildExportArgs({
      input: file, output: target, segments, crop, hasAudio: meta.hasAudio, fps: meta.fps, quality, encoder, pixelRate: w * h * meta.fps,
      basicTuning: needsBasicTuning(encoders, encoder)
    })
    const total = Math.max(0.1, totalDuration(segments))
    this.cancelled = false

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath(), args, { windowsHide: true })
      this.exportProc = proc
      const parser = new ProgressParser()
      let stderr = ''
      proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        for (const p of parser.push(chunk)) this.win?.webContents.send('editor:progress', Math.min(1, p.outTimeUs / 1e6 / total))
      })
      proc.stderr.setEncoding('utf8').on('data', (c: string) => (stderr = (stderr + c).slice(-2000)))
      proc.once('error', reject)
      proc.once('exit', (code) => {
        this.exportProc = null
        if (code === 0) resolve()
        else reject(new Error(this.cancelled ? 'cancelled' : stderr.trim().split(/\r?\n/).pop() || `FFmpeg exited with ${code}`))
      })
    })
  }

  private async discard(): Promise<boolean> {
    const file = this.file
    if (!file || !this.win) return false
    const res = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Discard', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Discard recording',
      message: 'Discard this recording?',
      detail: 'It will be permanently deleted.'
    })
    if (res.response !== 0) return false
    removePending(file)
    this.close()
    this.deps.onDiscarded()
    return true
  }
}
