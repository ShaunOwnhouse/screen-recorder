import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { buildCopyArgs, buildProxyArgs, TRACK_NAMES } from './args.ts'
import { chooseEncoder, ffmpegPath, needsBasicTuning, runFfmpeg } from './ffmpeg.ts'
import { mediaUrl, addedMediaUrl } from './media-protocol.ts'
import { ProgressParser, parseMediaInfo } from './parse.ts'
import { cameraFileFor, cameraInfoFor, mediaDirFor, proxyPathFor, removePending, sanitizeFileName, trackFileFor, uniquePath } from './pending.ts'
import { buildProjectArgs, cropPixels, type ExportMedia, type ExportPicture } from './project-export.ts'
import { probeMedia } from './verify.ts'
import { isPlain, type Project } from '../shared/project.ts'
import type { AssetSave, EditorLoad } from '../shared/api.ts'
import { videoFormat } from '../shared/formats.ts'
import type { Brand, BrandFont, DrawnPicture, EncoderInfo, MediaInfo, PreviewRequest, RecordingMeta, Rect, SaveRequest, Settings, VideoFormat } from '../shared/types.ts'

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
  /** A video was saved (the editor stays open so the person can carry on editing). */
  onSaved: (path: string) => void
  /** The person is done with this recording (Finish, or closed the window after saving). */
  onFinished: () => void
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
  /** The recording holds more than one sound track (a mix and the two it was made from). */
  private multiTrack = false
  /** Something has been saved from this recording; the recording itself stays until the person finishes. */
  private savedOnce = false
  private readonly savedPaths = new Set<string>()
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
    ipcMain.handle('editor:pick-media', (e, kind: 'clip' | 'music' | 'any') => (this.owns(e.sender) ? this.pickMedia(kind) : []))
    ipcMain.handle('editor:add-media', (e, paths: string[], kind: 'clip' | 'music' | 'any') => (this.owns(e.sender) ? this.addMedia(paths, kind) : []))
    ipcMain.handle('editor:save-asset', (e, spec: AssetSave) => (this.owns(e.sender) ? this.saveAsset(spec) : { error: 'Not available.' }))
    ipcMain.handle('editor:grab-frame', (e, spec: { media: string; time: number; crop: Rect | null }) => (this.owns(e.sender) ? this.grabFrame(spec) : { error: 'Not available.' }))
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
    ipcMain.handle('editor:preview-final', (e, req: PreviewRequest) => (this.owns(e.sender) ? this.previewFinal(req) : { ok: false }))
    ipcMain.handle('editor:finish', (e) => (this.owns(e.sender) ? this.finish() : false))
    ipcMain.handle('editor:reveal-path', (e, path: string) => {
      if (this.owns(e.sender) && this.savedPaths.has(path) && existsSync(path)) shell.showItemInFolder(path)
    })
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
    this.savedOnce = false
    this.savedPaths.clear()
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
    // If any part of the window ends up below the usable screen (under the taskbar), the page is told how much, so the
    // save row and the timeline stay on screen whatever the monitor, its scaling or where the window was dragged.
    let below = -1
    const watch = (): void => {
      const w = this.win
      if (!w || w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return
      const cb = w.getContentBounds()
      const wa = screen.getDisplayMatching(w.getBounds()).workArea
      const zoom = w.webContents.getZoomFactor() || 1
      const px = Math.max(0, Math.round((cb.y + cb.height - (wa.y + wa.height)) / zoom))
      if (px !== below) {
        below = px
        w.webContents.send('editor:below-screen', px)
      }
    }
    const watchTimer = setInterval(watch, 700)
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'restore', 'show'] as const) this.win.on(ev as 'resize', watch)
    this.win.webContents.on('did-finish-load', () => {
      below = -1
      watch()
    })
    this.win.on('closed', () => clearInterval(watchTimer))
    this.win.on('closed', () => {
      this.win = null
      // Closing the window after saving counts as finishing: the recording has been turned into a video, so it goes.
      if (this.savedOnce && this.file) {
        const f = this.file
        this.file = null
        this.savedOnce = false
        for (const p of this.previewJobs) p.kill()
        try {
          removePending(f)
        } catch {
          // a file that is still in use is cleaned up the next time the app starts
        }
        this.deps.onFinished()
        return
      }
      this.deps.onClosed()
    })
    this.deps.load(this.win)
  }

  close(): void {
    this.file = null
    rmSync(this.previewDir(), { recursive: true, force: true })
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
    const tracks = await this.loadTracks(file)
    const trackFiles = ['recording-pc', 'recording-mic'].map((id) => this.added.get(id)?.info).filter((x): x is MediaInfo => !!x)
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
        camera,
        tracks,
        trackFiles
      }
    }
  }

  /**
   * Finds out which sounds the recording holds. Recorded with both the computer's sound and the microphone, it has a mix
   * and a track for each; those two are taken out as files of their own so the editor can use them separately.
   */
  private async loadTracks(file: string): Promise<{ pc: boolean; mic: boolean }> {
    this.multiTrack = false
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', file])
    const names: string[] = []
    const lines = stderr.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/Stream #\d+:\d+.*: Audio:/.test(line)) return
      let name = ''
      for (let j = i + 1; j < lines.length && !/Stream #/.test(lines[j]); j++) {
        const m = /handler_name\s*:\s*(.+)$/.exec(lines[j])
        if (m) name = m[1].trim()
      }
      names.push(name)
    })
    const has = (n: string): boolean => names.includes(n)
    this.multiTrack = names.length > 1
    if (names.length >= 3 && has(TRACK_NAMES.pc) && has(TRACK_NAMES.mic)) {
      // extract both (a plain copy, quick); the editor plays and mixes them like any added sound
      for (const kind of ['pc', 'mic'] as const) {
        const out = trackFileFor(file, kind)
        const stream = names.indexOf(TRACK_NAMES[kind])
        if (!existsSync(out)) {
          const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', `0:a:${stream}`, '-vn', '-c:a', 'copy', out], 10 * 60 * 1000)
          if (!r.ok) {
            rmSync(out, { force: true })
            return { pc: false, mic: false }
          }
        }
        const d = await this.durationOf(out)
        const id = kind === 'pc' ? 'recording-pc' : 'recording-mic'
        const info: MediaInfo = { id, name: kind === 'pc' ? 'Computer sound' : 'Microphone', kind: 'audio', duration: d, width: 0, height: 0, hasAudio: true, url: addedMediaUrl(id) }
        this.added.set(id, { info, path: out })
      }
      return { pc: true, mic: true }
    }
    if (names.length === 1) return { pc: has(TRACK_NAMES.pc), mic: has(TRACK_NAMES.mic) }
    return { pc: false, mic: false }
  }

  private async durationOf(path: string): Promise<number> {
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', path])
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
    return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
  }

  /** The face camera recorded with this recording, made available to the editor like any added file. */
  private loadCamera(file: string): { info: MediaInfo; offset: number } | null {
    const video = cameraFileFor(file)
    const note = cameraInfoFor(file)
    if (!existsSync(video) || !existsSync(note)) return null
    try {
      const j = JSON.parse(readFileSync(note, 'utf8')) as { offset: number; width: number; height: number; duration: number; hasAudio?: boolean }
      if (!(j.duration > 0) || !Number.isFinite(j.offset)) return null
      const info: MediaInfo = { id: 'camera', name: 'Face camera', kind: 'video', duration: j.duration, width: j.width, height: j.height, hasAudio: !!j.hasAudio, url: addedMediaUrl('camera') }
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
        // A recording with separate sound tracks is re-wrapped (no re-encode) so the saved file has just the mix, one track.
        if (format === 'mp4' && !this.multiTrack) copyFileSync(file, target)
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

    // The editor stays open: the recording is kept until the person chooses Finish, so a mistake can still be put right.
    this.savedOnce = true
    this.savedPaths.add(target)
    this.deps.onSaved(target)
    return { ok: true, path: target }
  }

  private previewDir(): string {
    return join(app.getPath('userData'), 'preview')
  }

  private previewCount = 0

  /** A small, quick version of the finished video (every edit, the speed and the sound) to watch before saving. */
  private async previewFinal(req: PreviewRequest): Promise<{ ok: boolean; url?: string; duration?: number; error?: string }> {
    const file = this.file
    if (!file || !this.win || this.exportProc) return { ok: false }
    const project = req.project
    if (!project || !Array.isArray(project.clips) || !project.clips.length) return { ok: false, error: 'There is nothing to preview.' }
    const meta = await probeMedia(file)
    if (!meta) return { ok: false, error: 'Could not read the recording.' }
    rmSync(this.previewDir(), { recursive: true, force: true })
    mkdirSync(this.previewDir(), { recursive: true })
    const n = ++this.previewCount
    const output = join(this.previewDir(), `preview-${n}.mp4`)
    const scratch = mkdtempSync(join(app.getPath('userData'), 'export-'))
    try {
      const built = await this.buildExport(project, req.pictures ?? [], scratch, file, meta, output, 'mp4', false, true)
      await this.run(built.args, built.seconds)
      const id = `preview${n}`
      const info: MediaInfo = { id, name: 'Preview', kind: 'video', duration: built.seconds, width: 0, height: 0, hasAudio: true, url: addedMediaUrl(id) }
      this.added.set(id, { info, path: output })
      return { ok: true, url: info.url, duration: built.seconds }
    } catch (err) {
      rmSync(output, { force: true })
      return this.cancelled ? { ok: false } : { ok: false, error: (err as Error).message }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** Done with this recording: the saved videos stay, the recording and its editing files are removed. */
  private async finish(): Promise<boolean> {
    const file = this.file
    if (!file || this.exportProc) return false
    await this.stopPreviewJobs()
    removePending(file)
    this.savedOnce = false
    this.close()
    this.deps.onFinished()
    return true
  }

  /** Writes the editor's pictures to disk and builds the FFmpeg command for the whole project. */
  private async buildExport(
    project: Project, drawn: DrawnPicture[], scratch: string, file: string, meta: RecordingMeta, target: string, format: VideoFormat,
    convert: boolean, preview = false
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
      basicTuning: needsBasicTuning(encoders, encoder), preview
    })
  }

  // ---------- files added to the video ----------

  private async pickMedia(kind: 'clip' | 'music' | 'any'): Promise<MediaInfo[]> {
    if (!this.win) return []
    const res = await dialog.showOpenDialog(this.win, {
      title: kind === 'music' ? 'Choose audio files' : kind === 'clip' ? 'Add videos or pictures' : 'Add videos, pictures or audio',
      properties: ['openFile', 'multiSelections'],
      filters:
        kind === 'music'
          ? [{ name: 'Audio', extensions: [...AUDIO_EXT, ...VIDEO_EXT] }, { name: 'Audio only', extensions: AUDIO_EXT }]
          : kind === 'clip'
            ? [
                { name: 'Videos and pictures', extensions: [...VIDEO_EXT, ...IMAGE_EXT] },
                { name: 'Videos', extensions: VIDEO_EXT },
                { name: 'Pictures', extensions: IMAGE_EXT }
              ]
            : [
                { name: 'Videos, pictures and audio', extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT] },
                { name: 'Videos', extensions: VIDEO_EXT },
                { name: 'Pictures', extensions: IMAGE_EXT },
                { name: 'Audio', extensions: AUDIO_EXT }
              ]
    })
    return res.canceled ? [] : this.addMedia(res.filePaths, kind)
  }

  private async addMedia(paths: string[], kind: 'clip' | 'music' | 'any'): Promise<MediaInfo[]> {
    const out: MediaInfo[] = []
    for (const path of paths.slice(0, 40)) {
      if (!existsSync(path) || !statSync(path).isFile()) continue
      const ext = extOf(path)
      const allowed = kind === 'music' ? [...AUDIO_EXT, ...VIDEO_EXT] : kind === 'clip' ? [...VIDEO_EXT, ...IMAGE_EXT] : [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT]
      if (!allowed.includes(ext)) continue
      const { stderr } = await runFfmpeg(['-hide_banner', '-i', path])
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
      const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
      let info: Omit<MediaInfo, 'id' | 'url' | 'name'> | null = null
      // An audio file is a sound; a video added as "music" is used for its sound only (the sound track of a video).
      if (AUDIO_EXT.includes(ext) || kind === 'music') {
        if (/Stream #.*: Audio:/.test(stderr) && duration > 0) {
          const v = parseMediaInfo(stderr)
          info = AUDIO_EXT.includes(ext)
            ? { kind: 'audio', duration, width: 0, height: 0, hasAudio: true }
            : { kind: 'video', duration, width: v?.width ?? 0, height: v?.height ?? 0, hasAudio: true }
        }
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

  /**
   * A picture of one moment of a video (for a freeze frame), kept with the recording's other files and registered like any added
   * picture. The recording's crop is applied so the still matches what the video shows.
   */
  private async grabFrame(spec: { media: string; time: number; crop: Rect | null }): Promise<MediaInfo | { error: string }> {
    const src = this.pathOf(spec.media)
    if (!this.file || !src || !existsSync(src) || !Number.isFinite(spec.time)) return { error: 'That picture is no longer available.' }
    const meta = spec.media === 'recording' && spec.crop ? await probeMedia(src) : null
    const crop = meta ? cropPixels(spec.crop, meta.width, meta.height) : null
    const id = `m${++this.counter}`
    const dir = mediaDirFor(this.file)
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `freeze-${id}.png`)
    const vf = [...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []), 'format=rgb24'].join(',')
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, spec.time)), '-i', src, '-frames:v', '1', '-vf', vf, out])
    if (!existsSync(out) || statSync(out).size < 100) return { error: 'Couldn’t take a picture of that moment.' }
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', out])
    const v = parseMediaInfo(stderr)
    if (!v) return { error: 'Couldn’t take a picture of that moment.' }
    const full: MediaInfo = { id, name: `Frame at ${Math.floor(spec.time / 60)}:${String(Math.floor(spec.time % 60)).padStart(2, '0')}.png`, kind: 'image', duration: 0, width: v.width, height: v.height, hasAudio: false, url: addedMediaUrl(id) }
    this.added.set(id, { info: full, path: out })
    return full
  }

  /** Saves a stretch of one file as a file of its own: just its picture, or just its sound. */
  private async saveAsset(spec: AssetSave): Promise<{ path?: string; error?: string }> {
    const win = this.win
    const src = this.pathOf(spec.media)
    if (!win || !src || !existsSync(src)) return { error: 'That file is no longer available.' }
    if (!(spec.to > spec.from) || spec.from < 0 || (spec.what !== 'video' && spec.what !== 'audio')) return { error: 'Nothing to save there.' }
    const meta = await probeMedia(src)
    const whole = !!meta && spec.from <= 0.02 && spec.to >= meta.duration - 0.05
    const base = sanitizeFileName(spec.name.replace(/\.[a-z0-9]{2,4}$/i, ''), 'Screen Snap piece', '').replace(/\.$/, '')
    const outputDir = this.deps.settings().outputDir
    const filters =
      spec.what === 'video'
        ? [{ name: 'MP4 video (no sound)', extensions: ['mp4'] }]
        : [{ name: 'MP3 audio', extensions: ['mp3'] }, { name: 'WAV audio (lossless)', extensions: ['wav'] }, { name: 'M4A audio (AAC)', extensions: ['m4a'] }]
    const res = await dialog.showSaveDialog(win, {
      title: spec.what === 'video' ? 'Save the video without sound' : 'Save the sound',
      defaultPath: join(outputDir, `${base}${spec.what === 'video' ? ' (video only)' : ' (sound)'}`),
      filters
    })
    if (res.canceled || !res.filePath) return {}
    const ext = extOf(res.filePath)
    const target = spec.what === 'video' ? (ext === 'mp4' ? res.filePath : `${res.filePath}.mp4`) : ['mp3', 'wav', 'm4a'].includes(ext) ? res.filePath : `${res.filePath}.mp3`
    mkdirSync(dirname(target), { recursive: true })
    const cut = whole ? [] : ['-ss', String(spec.from), '-t', String(Math.max(0.1, spec.to - spec.from))]
    const args =
      spec.what === 'video'
        ? ['-hide_banner', '-loglevel', 'error', '-y', ...cut, '-i', src, '-map', '0:v:0', '-an', ...(whole ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p']), '-movflags', '+faststart', target]
        : [
            '-hide_banner', '-loglevel', 'error', '-y', ...cut, '-i', src, '-vn', '-map', '0:a:0',
            ...(extOf(target) === 'wav' ? ['-c:a', 'pcm_s16le'] : extOf(target) === 'm4a' ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'libmp3lame', '-b:a', '320k']),
            target
          ]
    const r = await runFfmpeg(args, 30 * 60 * 1000)
    if (!r.ok || !existsSync(target)) {
      rmSync(target, { force: true })
      return { error: spec.what === 'audio' && /Stream map|does not contain any stream/i.test(r.stderr) ? 'That piece has no sound to save.' : 'Could not save that piece.' }
    }
    return { path: target }
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
      detail: this.savedOnce ? 'The video you saved stays where it is; the recording is deleted.' : 'It will be permanently deleted.'
    })
    if (res.response !== 0) return false
    await this.stopPreviewJobs()
    removePending(file)
    this.savedOnce = false
    this.close()
    this.deps.onDiscarded()
    return true
  }
}
