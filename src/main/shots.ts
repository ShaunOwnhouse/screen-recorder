import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron'
import { buildImageConvertArgs } from './args.ts'
import { runFfmpeg } from './ffmpeg.ts'
import { sanitizeFileName, uniquePath } from './pending.ts'
import { shotTmpDir } from './snap.ts'
import { imageFormat } from '../shared/formats.ts'
import type { ShotCopyRequest, ShotSaveRequest, ShotSource, ImageFormat, Settings } from '../shared/types.ts'

interface Deps {
  preload: string
  icon: string
  load: (win: BrowserWindow) => void
  settings: () => Settings
  formats: () => Promise<ImageFormat[]>
  onSaved: (path: string) => void
  onClosed: () => void
}

interface Entry {
  win: BrowserWindow
  file: string
  name: string
  dirty: boolean
  closing: boolean
}

const stamp = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/** The window that opens after a screenshot: Copy / Save / Save as / Discard, plus crop and drawing tools. */
export class ShotReview {
  private readonly entries = new Map<number, Entry>()
  private counter = 0

  constructor(private readonly deps: Deps) {
    const entry = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): Entry | undefined => this.entries.get(e.sender.id)
    ipcMain.handle('shot:load', async (e) => {
      const en = entry(e)
      if (!en || !existsSync(en.file)) return { error: 'This screenshot is no longer available.' }
      const size = nativeImage.createFromPath(en.file).getSize()
      const formats = await this.deps.formats()
      const wanted = this.deps.settings().shotFormat
      const source: ShotSource = {
        width: size.width,
        height: size.height,
        defaultName: `Screenshot ${stamp()}`,
        outputDir: this.deps.settings().shotDir,
        format: formats.includes(wanted) ? wanted : 'png',
        formats
      }
      return { source }
    })
    ipcMain.handle('shot:bytes', (e) => {
      const en = entry(e)
      return en && existsSync(en.file) ? readFileSync(en.file) : new Uint8Array()
    })
    ipcMain.handle('shot:save', (e, req: ShotSaveRequest) => {
      const en = entry(e)
      return en ? this.save(en, req) : { ok: false }
    })
    ipcMain.handle('shot:copy', (e, req: ShotCopyRequest) => {
      const en = entry(e)
      if (!en) return false
      clipboard.writeImage(nativeImage.createFromBuffer(this.bytes(en, req.png), { scaleFactor: 1 }))
      return true
    })
    ipcMain.handle('shot:discard', async (e, edited: boolean) => {
      const en = entry(e)
      if (!en) return false
      if (edited) {
        const res = await dialog.showMessageBox(en.win, {
          type: 'warning',
          buttons: ['Discard', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Discard screenshot',
          message: 'Discard this screenshot?',
          detail: 'Your changes will be lost.'
        })
        if (res.response !== 0) return false
      }
      this.close(en)
      return true
    })
    ipcMain.on('shot:dirty', (e, dirty: boolean) => {
      const en = entry(e)
      if (en) en.dirty = Boolean(dirty)
    })
  }

  isOpen(): boolean {
    return this.entries.size > 0
  }

  open(png: Buffer): void {
    const name = `shot-${++this.counter}.png`
    const file = join(shotTmpDir(), name)
    writeFileSync(file, png)
    const win = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 820,
      minHeight: 600,
      show: false,
      title: 'Review screenshot',
      backgroundColor: '#101216',
      autoHideMenuBar: true,
      icon: this.deps.icon,
      webPreferences: { preload: this.deps.preload }
    })
    win.setContentProtection(true)
    const entry: Entry = { win, file, name, dirty: false, closing: false }
    this.entries.set(win.webContents.id, entry)
    const id = win.webContents.id
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
    win.on('close', (e) => {
      if (!entry.dirty || entry.closing) return
      e.preventDefault()
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: ['Discard', 'Keep editing'],
          defaultId: 1,
          cancelId: 1,
          title: 'Discard screenshot',
          message: 'Close without saving?',
          detail: 'Your changes will be lost.'
        })
        .then((res) => res.response === 0 && this.close(entry))
    })
    win.on('closed', () => {
      this.entries.delete(id)
      rmSync(file, { force: true })
      this.deps.onClosed()
    })
    this.deps.load(win)
  }

  private bytes(en: Entry, png: Uint8Array | null): Buffer {
    return png && png.byteLength ? Buffer.from(png) : readFileSync(en.file)
  }

  private close(en: Entry): void {
    en.closing = true
    if (!en.win.isDestroyed()) en.win.destroy()
  }

  private async save(en: Entry, req: ShotSaveRequest): Promise<{ ok: boolean; path?: string; error?: string }> {
    const format: ImageFormat = (await this.deps.formats()).includes(req.format) ? req.format : 'png'
    const info = imageFormat(format)
    const dir = this.deps.settings().shotDir
    const fileName = sanitizeFileName(req.fileName, 'Screenshot', info.ext)
    let target: string
    if (req.saveAs) {
      const res = await dialog.showSaveDialog(en.win, {
        title: 'Save screenshot',
        defaultPath: join(dir, fileName),
        filters: [{ name: `${info.ext.toUpperCase()} image`, extensions: [info.ext] }]
      })
      if (res.canceled || !res.filePath) return { ok: false }
      target = new RegExp(`\\.${info.ext}$`, 'i').test(res.filePath) ? res.filePath : `${res.filePath}.${info.ext}`
      mkdirSync(dirname(target), { recursive: true })
    } else {
      mkdirSync(dir, { recursive: true })
      target = uniquePath(dir, fileName)
    }

    try {
      const png = this.bytes(en, req.png)
      if (format === 'png') writeFileSync(target, png)
      else {
        const src = join(shotTmpDir(), `convert-${en.name}`)
        writeFileSync(src, png)
        const res = await runFfmpeg(buildImageConvertArgs(src, target, format), 60000)
        rmSync(src, { force: true })
        if (!res.ok) throw new Error(res.stderr.trim().split(/\r?\n/).pop() || 'Could not convert the image.')
      }
    } catch (err) {
      rmSync(target, { force: true })
      return { ok: false, error: (err as Error).message }
    }
    this.close(en)
    this.deps.onSaved(target)
    return { ok: true, path: target }
  }
}
