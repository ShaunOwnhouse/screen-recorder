import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { buildCopyArgs, buildProxyArgs } from './args.ts'
import { chooseEncoder, ffmpegPath, needsBasicTuning, runFfmpeg } from './ffmpeg.ts'
import { mediaUrl, addedMediaUrl } from './media-protocol.ts'
import { ProgressParser, parseMediaInfo } from './parse.ts'
import { cameraFileFor, cameraInfoFor, moveFile, proxyPathFor, removePending, sanitizeFileName, uniquePath } from './pending.ts'
import { buildProjectArgs, type ExportMedia, type ExportPicture } from './project-export.ts'
import { probeMedia } from './verify.ts'
import { isPlain, type Project } from '../shared/project.ts'
import type { EditorLoad } from '../shared/api.ts'
import { videoFormat } from '../shared/formats.ts'
import type { Brand, BrandFont, DrawnPicture, EncoderInfo, MediaInfo, RecordingMeta, SaveRequest, Settings, VideoFormat } from '../shared/types.ts'

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma']
const FONT_EXT = ['ttf', 'otf', 'woff', 'woff2']
const extOf = (f: string): string => extname(f).slice(1).toLowerCase()

interface Added {
  info: MediaInfo
  path: string
}

interface Deps {
  preload: string
  icon: string
  load: (win: BrowserWindow) => void
  settings: () => Settings
  encoders: () => Promise<EncoderInfo[]>
  formats: () => Promise<VideoFormat[]>
  onSaved: (path: string) => void
  onDiscarded: () => void
  onClosed: () => void
  saveBrand: (brand: Brand) => Brand
}

export class EditorController {
  private win: BrowserWindow | null = null
  private file: string | null = null
  private exportProc: ChildProcess | null = null
  private cancelled = false
  /** Files the person added to this video, by id (the recording itself is 'recording'). */
  private readonly added = new Map<string, Added>()
  private counter = 0
  /** Background FFmpeg jobs that read the recording to draw the timeline; they must not still be running when it is moved or deleted. */
  private readonly previewJobs = new Set<ChildProcess>()
  private readonly strips = new Map<string, string>()
  private readonly waves = new Map<string, number[]>()

  /** Runs FFmpeg and returns what it printed, in a way that can be stopped (see `stopPreviewJobs`). */
  private preview(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: Buffer }> {
    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath(), args, { windowsHide: true })
      this.previewJobs.add(proc)
      const out: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      proc.stdout.on('data', (c: Buffer) => {
        size += c.length
        if (size <= 256 * 1024 * 1024) out.push(c)
      })
      proc.stderr.resume()
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        this.previewJobs.delete(proc)
        resolve({ ok, stdout: Buffer.concat(out) })
      }
      proc.once('error', () => done(false))
      proc.once('close', (code) => done(code === 0))
    })
  }

  /** Stops the jobs that draw the timeline and waits until they have let go of the files. */
  private async stopPreviewJobs(): Promise<void> {
    const jobs = [...this.previewJobs]
    await Promise.all(
      jobs.map(
        (p) =>
          new Promise<void>((resolve) => {
            if (p.exitCode !== null) return resolve()
            p.once('close', () => resolve())
            p.kill()
            setTimeout(resolve, 5000)
          })
      )
    )
  }

  /** Where the media:// protocol finds an added file. */
  addedPath(id: string): string | null {
    const a = this.added.get(id)
    return a && existsSync(a.path) ? a.path : null
  }

  constructor(private readonly deps: Deps) {
    ipcMain.handle('editor:pick-media', (e, kind: 'clip' | 'music') => (this.owns(e.sender) ? this.pickMedia(kind) : []))
    ipcMain.handle('editor:add-media', (e, paths: string[], kind: 'clip' | 'music') => (this.owns(e.sender) ? this.addMedia(paths, kind) : []))
    ipcMain.handle('editor:waveform', (e, id: string, buckets: number) => (this.owns(e.sender) ? this.waveform(id, buckets) : []))
    ipcMain.handle('editor:strip', (e, id: string, count: number) => (this.owns(e.sender) ? this.strip(id, count) : ''))
    ipcMain.handle('editor:save-brand', (e, brand: Brand) => (this.owns(e.sender) ? this.deps.saveBrand(brand) : brand))
    ipcMain.handle('editor:pick-font', (e) => (this.owns(e.sender) ? this.pickFont() : null))
    ipcMain.handle('editor:font-data', (e, file: string) => (this.owns(e.sender) ? this.fontData(file) : new Uint8Array()))
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
    this.added.clear()
    this.strips.clear()
    this.waves.clear()
    if (this.win && !this.win.isDestroyed()) {
      this.deps.load(this.win)
      this.win.show()
      this.win.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    this.win = new BrowserWindow({
      width: Math.min(1440, area.width - 24),
      height: Math.min(920, area.height - 24),
      minWidth: Math.min(1100, area.width - 24),
      minHeight: Math.min(720, area.height - 24),
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
    for (const p of this.previewJobs) p.kill()
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
    const camera = this.loadCamera(file)
    const formats = await this.deps.formats()
    const wanted = this.deps.settings().videoFormat
    return {
      source: {
        name,
        url: mediaUrl(name),
        meta,
        sizeBytes: statSync(file).size,
        defaultName: name.replace(/\.mp4$/i, ''),
        outputDir: this.deps.settings().outputDir,
        formats,
        format: formats.includes(wanted) ? wanted : 'mp4',
        brand: this.deps.settings().brand,
        camera
      }
    }
  }

  /** The face camera recorded with this recording, made available to the editor like any added file. */
  private loadCamera(file: string): { info: MediaInfo; offset: number } | null {
    const video = cameraFileFor(file)
    const note = cameraInfoFor(file)
    if (!existsSync(video) || !existsSync(note)) return null
    try {
      const j = JSON.parse(readFileSync(note, 'utf8')) as { offset: number; width: number; height: number; duration: number }
      if (!(j.duration > 0) || !Number.isFinite(j.offset)) return null
      const info: MediaInfo = { id: 'camera', name: 'Face camera', kind: 'video', duration: j.duration, width: j.width, height: j.height, hasAudio: false, url: addedMediaUrl('camera') }
      this.added.set('camera', { info, path: video })
      return { info, offset: j.offset }
    } catch {
      return null
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
    await this.stopPreviewJobs()
    const meta = await probeMedia(file)
    if (!meta) return { ok: false, error: 'Could not read the recording.' }

    const format: VideoFormat = (await this.deps.formats()).includes(req.format) ? req.format : 'mp4'
    const info = videoFormat(format)
    const outputDir = this.deps.settings().outputDir
    const fileName = sanitizeFileName(req.fileName, basename(file, '.mp4'), info.ext)
    let target: string
    if (req.saveAs) {
      const res = await dialog.showSaveDialog(win, {
        title: 'Save recording',
        defaultPath: join(outputDir, fileName),
        filters: [{ name: `${info.ext.toUpperCase()} video`, extensions: [info.ext] }]
      })
      if (res.canceled || !res.filePath) return { ok: false }
      target = new RegExp(`\\.${info.ext}$`, 'i').test(res.filePath) ? res.filePath : `${res.filePath}.${info.ext}`
      mkdirSync(dirname(target), { recursive: true })
    } else {
      mkdirSync(outputDir, { recursive: true })
      target = uniquePath(outputDir, fileName)
    }

    const project = req.project
    if (!project || !Array.isArray(project.clips) || !project.clips.length) return { ok: false, error: 'There is nothing to save.' }
    const convert = meta.yuv444 && req.compatible
    const container = format === 'mkv' ? 'mkv' : format === 'mov' ? 'mov' : 'mp4'
    const keepsFile = format === 'mp4' || format === 'mkv' || format === 'mov'
    let scratch: string | null = null
    try {
      if (keepsFile && isPlain(project, meta.duration) && !convert) {
        // Untouched recording: no re-encode, zero quality loss — moved as-is (MP4) or re-wrapped (MKV/MOV).
        if (format === 'mp4') moveFile(file, target)
        else await this.run(buildCopyArgs(file, target, container), meta.duration)
      } else {
        scratch = mkdtempSync(join(app.getPath('userData'), 'export-'))
        const built = await this.buildExport(project, req.pictures ?? [], scratch, file, meta, target, format, convert)
        await this.run(built.args, built.seconds)
      }
    } catch (err) {
      rmSync(target, { force: true })
      return this.cancelled ? { ok: false } : { ok: false, error: (err as Error).message }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }

    removePending(file)
    this.close()
    this.deps.onSaved(target)
    return { ok: true, path: target }
  }

  /** Writes the editor's pictures to disk and builds the FFmpeg command for the whole project. */
  private async buildExport(
    project: Project, drawn: DrawnPicture[], scratch: string, file: string, meta: RecordingMeta, target: string, format: VideoFormat,
    convert: boolean
  ): Promise<{ args: string[]; seconds: number }> {
    const pictures: Record<string, ExportPicture> = {}
    drawn.forEach((d, i) => {
      const path = join(scratch, `picture-${i}.png`)
      writeFileSync(path, Buffer.from(d.png))
      pictures[d.key] = { path, x: Math.round(d.x), y: Math.round(d.y), width: d.width, height: d.height }
    })
    const media: Record<string, ExportMedia> = {
      recording: { path: file, kind: 'video', hasAudio: meta.hasAudio, duration: meta.duration, width: meta.width, height: meta.height }
    }
    for (const [id, a] of this.added) {
      if (a.info.kind === 'audio') media[id] = { path: a.path, kind: 'video', hasAudio: true, duration: a.info.duration, width: 0, height: 0 }
      else media[id] = { path: a.path, kind: a.info.kind, hasAudio: a.info.hasAudio, duration: a.info.duration, width: a.info.width, height: a.info.height }
    }
    // Re-encode at the top tier so edits don't visibly lose quality.
    const quality = meta.yuv444 && !convert ? 'studio' : 'maximum'
    const s = this.deps.settings()
    const encoders = await this.deps.encoders()
    const encoder = chooseEncoder(encoders, s.encoder, quality)
    return buildProjectArgs({
      project, media, pictures, recording: { width: meta.width, height: meta.height }, fps: meta.fps, output: target, format, quality, encoder,
      basicTuning: needsBasicTuning(encoders, encoder)
    })
  }

  // ---------- files added to the video ----------

  private async pickMedia(kind: 'clip' | 'music'): Promise<MediaInfo[]> {
    if (!this.win) return []
    const res = await dialog.showOpenDialog(this.win, {
      title: kind === 'music' ? 'Choose a music file' : 'Add videos or pictures',
      properties: kind === 'music' ? ['openFile'] : ['openFile', 'multiSelections'],
      filters:
        kind === 'music'
          ? [{ name: 'Music', extensions: AUDIO_EXT }]
          : [
              { name: 'Videos and pictures', extensions: [...VIDEO_EXT, ...IMAGE_EXT] },
              { name: 'Videos', extensions: VIDEO_EXT },
              { name: 'Pictures', extensions: IMAGE_EXT }
            ]
    })
    return res.canceled ? [] : this.addMedia(res.filePaths, kind)
  }

  private async addMedia(paths: string[], kind: 'clip' | 'music'): Promise<MediaInfo[]> {
    const out: MediaInfo[] = []
    for (const path of paths.slice(0, 20)) {
      if (!existsSync(path) || !statSync(path).isFile()) continue
      const ext = extOf(path)
      const wantAudio = kind === 'music'
      if (wantAudio ? !AUDIO_EXT.includes(ext) : ![...VIDEO_EXT, ...IMAGE_EXT].includes(ext)) continue
      const { stderr } = await runFfmpeg(['-hide_banner', '-i', path])
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
      const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
      let info: Omit<MediaInfo, 'id' | 'url' | 'name'> | null = null
      if (wantAudio) {
        if (/Stream #.*: Audio:/.test(stderr) && duration > 0) info = { kind: 'audio', duration, width: 0, height: 0, hasAudio: true }
      } else {
        const v = parseMediaInfo(stderr)
        if (v) {
          const image = IMAGE_EXT.includes(ext)
          info = { kind: image ? 'image' : 'video', duration: image ? 0 : v.duration, width: v.width, height: v.height, hasAudio: !image && v.hasAudio }
        }
      }
      if (!info) continue
      const id = `m${++this.counter}`
      const full: MediaInfo = { ...info, id, name: basename(path), url: addedMediaUrl(id) }
      this.added.set(id, { info: full, path })
      out.push(full)
    }
    return out
  }

  private pathOf(id: string): string | null {
    return id === 'recording' ? this.file : (this.added.get(id)?.path ?? null)
  }

  /** Loudness every so often along an audio file, for drawing its waveform. */
  private async waveform(id: string, buckets: number): Promise<number[]> {
    const cached = this.waves.get(`${id}:${buckets}`)
    if (cached) return cached
    const path = this.pathOf(id)
    if (!path) return []
    const res = await this.preview(['-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '2000', '-t', '7200', '-f', 'f32le', '-'], 120000)
    if (!res.ok || res.stdout.length < 8) return []
    const bytes = res.stdout
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 4)))
    const n = Math.max(8, Math.min(2000, Math.round(buckets)))
    const per = Math.max(1, Math.floor(samples.length / n))
    const peaks: number[] = []
    for (let b = 0; b < n; b++) {
      let max = 0
      for (let i = b * per; i < Math.min(samples.length, (b + 1) * per); i++) max = Math.max(max, Math.abs(samples[i]))
      peaks.push(Math.min(1, max))
    }
    this.waves.set(`${id}:${buckets}`, peaks)
    return peaks
  }

  /** A strip of small pictures spread across a video, for the timeline (one data URL per file). */
  private async strip(id: string, count: number): Promise<string> {
    const key = `${id}:${count}`
    const cached = this.strips.get(key)
    if (cached) return cached
    const path = this.pathOf(id)
    const info = id === 'recording' ? await probeMedia(path ?? '') : null
    const duration = id === 'recording' ? (info?.duration ?? 0) : (this.added.get(id)?.info.duration ?? 0)
    if (!path || duration <= 0) return ''
    const n = Math.max(2, Math.min(80, Math.round(count)))
    const res = await this.preview(
      ['-hide_banner', '-loglevel', 'error', '-i', path, '-an', '-vf', `fps=${(n / duration).toFixed(5)},scale=-2:56,tile=${n}x1`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
      120000
    )
    if (!res.ok || res.stdout.length < 100) return ''
    const url = `data:image/png;base64,${res.stdout.toString('base64')}`
    this.strips.set(key, url)
    return url
  }

  // ---------- fonts ----------

  private fontsDir(): string {
    const dir = join(app.getPath('userData'), 'fonts')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private async pickFont(): Promise<BrandFont | null> {
    if (!this.win) return null
    const res = await dialog.showOpenDialog(this.win, { title: 'Add a font', properties: ['openFile'], filters: [{ name: 'Fonts', extensions: FONT_EXT }] })
    if (res.canceled || !res.filePaths[0] || !FONT_EXT.includes(extOf(res.filePaths[0]))) return null
    const name = basename(res.filePaths[0], extname(res.filePaths[0])).replace(/[-_]+/g, ' ').trim() || 'My font'
    let target = join(this.fontsDir(), basename(res.filePaths[0]))
    if (existsSync(target)) target = uniquePath(this.fontsDir(), basename(res.filePaths[0]))
    copyFileSync(res.filePaths[0], target)
    return { name, file: basename(target) }
  }

  private fontData(file: string): Uint8Array {
    if (!file || file !== basename(file)) return new Uint8Array()
    const path = join(this.fontsDir(), file)
    return existsSync(path) ? readFileSync(path) : new Uint8Array()
  }

  /** Runs FFmpeg with progress reporting to the review window; rejects on failure or cancel. */
  private async run(args: string[], seconds: number): Promise<void> {
    const total = Math.max(0.1, seconds)
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
    await this.stopPreviewJobs()
    removePending(file)
    this.close()
    this.deps.onDiscarded()
    return true
  }
}
