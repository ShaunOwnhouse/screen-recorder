import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { createWriteStream, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import type { AudioInput } from './args.ts'
import { spawnSystemAudio } from './mac-helper.ts'
import type { CameraOpenPayload, CameraOpenResult } from '../shared/api.ts'
import type { AudioLevels, CameraInfo, MicInfo } from '../shared/types.ts'

export interface AudioConfig {
  system: boolean
  systemVolume: number
  mic: string | null
  micVolume: number
  noiseSuppression: boolean
}

export interface AudioStartResult {
  started: string[]
  errors: string[]
  inputs: AudioInput[]
}

type Loader = (win: BrowserWindow) => void

let pipeSeq = 0

/** A local named pipe (Windows) or Unix socket (macOS) that FFmpeg reads raw PCM from. */
export class PcmPipe {
  private sink: Socket | null = null
  /** Called each time FFmpeg connects: that moment is when the recording's clock starts for this sound. */
  onConnect: (() => void) | null = null

  private constructor(
    readonly path: string,
    private readonly server: Server
  ) {}

  static async create(): Promise<PcmPipe> {
    const name = `screen-snap-audio-${process.pid}-${Date.now()}-${++pipeSeq}`
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
    let pipe: PcmPipe | null = null
    const server = createServer((socket) => {
      // Only audio captured after FFmpeg connects is sent, so it lines up with the first video frame.
      pipe?.sink?.destroy()
      if (pipe) pipe.sink = socket
      pipe?.onConnect?.()
      socket.on('error', () => socket.destroy())
    })
    pipe = new PcmPipe(path, server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    return pipe
  }

  /** FFmpeg input URL for this pipe. */
  get url(): string {
    return process.platform === 'win32' ? this.path : `unix:${this.path}`
  }

  write(chunk: Buffer): void {
    const sink = this.sink
    if (sink && !sink.destroyed && sink.writable) sink.write(chunk)
  }

  async close(): Promise<void> {
    this.sink?.end()
    this.sink = null
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (process.platform !== 'win32') rmSync(this.path, { force: true })
  }
}

const FRAME_BYTES = 8 // stereo float32

/** Peak of frame-aligned f32le audio. */
function peakOf(frames: Buffer): number {
  let max = 0
  // Every 4th frame is plenty for a level meter.
  for (let i = 0; i + 4 <= frames.length; i += FRAME_BYTES * 4) max = Math.max(max, Math.abs(frames.readFloatLE(i)))
  return Math.min(1, max)
}

/**
 * Captures audio for recordings:
 * - Windows: computer sound (WASAPI loopback via Chromium) and the mic are captured in a hidden window, each on its
 *   own 48 kHz stereo f32le pipe.
 * - macOS: the mic comes from the hidden window; computer sound comes from the native
 *   ScreenCaptureKit helper on a second pipe.
 * FFmpeg then writes a mix (plays everywhere) and, when both are on, each source as a track of its own.
 */
export class AudioCapture extends EventEmitter {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  /** One pipe per source the hidden window captures. */
  private pipes: { system: PcmPipe | null; mic: PcmPipe | null } = { system: null, mic: null }
  /** The computer-sound pipe fed by the macOS helper. */
  private systemPipe: PcmPipe | null = null
  private helper: ChildProcess | null = null
  /** When FFmpeg last connected to a sound pipe (ms), and who is waiting for the next time. */
  lastConnectAt = 0
  firstConnectAt = 0
  private connectWaiters: Array<() => void> = []
  private rendererRunning = false
  private seq = 0
  private micLevel: number | null = null
  private systemLevel: number | null = null
  private levelTimer: NodeJS.Timeout | null = null
  private camFile: WriteStream | null = null

  constructor(
    private readonly preload: string,
    private readonly load: Loader
  ) {
    super()
    ipcMain.on('audio:pcm', (e, source: 'system' | 'mic', chunk: ArrayBufferView) => {
      if (e.sender !== this.win?.webContents) return
      this.pipes[source === 'system' ? 'system' : 'mic']?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })
    ipcMain.on('camera:chunk', (e, chunk: Uint8Array) => {
      if (e.sender !== this.win?.webContents) return
      this.camFile?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })
    ipcMain.on('audio:levels', (e, levels: AudioLevels) => {
      if (e.sender !== this.win?.webContents) return
      this.micLevel = levels.mic
      if (!this.helper) this.emit('levels', levels)
    })
  }

  private ensureWindow(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready
    this.win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: { preload: this.preload, backgroundThrottling: false }
    })
    const win = this.win
    this.ready = new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    win.on('closed', () => {
      this.win = null
      this.ready = null
    })
    this.load(win)
    return this.ready
  }

  private request<T>(channel: string, payload?: unknown, timeoutMs = 15000): Promise<T> {
    return this.ensureWindow().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = ++this.seq
          const reply = `${channel}:reply:${id}`
          const timer = setTimeout(() => {
            ipcMain.removeAllListeners(reply)
            reject(new Error(`${channel} timed out`))
          }, timeoutMs)
          ipcMain.once(reply, (_e: IpcMainEvent, result: T) => {
            clearTimeout(timer)
            resolve(result)
          })
          this.win!.webContents.send(channel, id, payload)
        })
    )
  }

  // ---------- the webcam (captured in the same hidden page as the sound) ----------

  listCameras(): Promise<CameraInfo[]> {
    return this.request<CameraInfo[]>('camera:devices', undefined, 20000).catch(() => [])
  }

  /** Opens the camera (so recording can begin the instant it is wanted) without recording yet. */
  openCamera(p: CameraOpenPayload): Promise<CameraOpenResult> {
    return this.request<CameraOpenResult>('camera:open', p, 25000).catch((e: Error) => ({ ok: false, error: e.message }))
  }

  /** Starts recording the open camera into `file`; resolves with the wall-clock time recording began. */
  async startCamera(file: string): Promise<number> {
    this.camFile?.end()
    this.camFile = createWriteStream(file)
    const res = await this.request<{ startedAt: number }>('camera:start', undefined, 15000)
    return res.startedAt
  }

  pauseCamera(): Promise<void> {
    return this.request<void>('camera:pause').catch(() => undefined)
  }

  resumeCamera(): Promise<void> {
    return this.request<void>('camera:resume').catch(() => undefined)
  }

  /** Stops the camera and waits until every piece of the picture has been written to the file. */
  async stopCamera(): Promise<void> {
    await this.request<void>('camera:stop', undefined, 30000).catch(() => undefined)
    const f = this.camFile
    this.camFile = null
    if (f) await new Promise<void>((resolve) => f.end(() => resolve()))
  }

  private noteConnect(): void {
    const now = Date.now()
    this.lastConnectAt = now
    if (!this.firstConnectAt) this.firstConnectAt = now
    const waiting = this.connectWaiters.splice(0)
    for (const w of waiting) w()
  }

  /** Resolves when FFmpeg next connects to a sound pipe (the moment a recording piece's clock starts), or after `ms`. */
  nextConnect(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== done)
        resolve(false)
      }, ms)
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.connectWaiters.push(done)
    })
  }

  /** `prime` briefly opens the default mic so device names are available (asks permission on macOS). */
  listMicrophones(prime = true): Promise<MicInfo[]> {
    return this.request<MicInfo[]>('audio:devices', { prime }).catch(() => [])
  }

  /** Starts capture. With `pipe`, audio is served for FFmpeg; without, it only drives the level meters. */
  async start(cfg: AudioConfig, pipe: boolean): Promise<AudioStartResult> {
    await this.stop()
    this.firstConnectAt = 0
    this.lastConnectAt = 0
    const started: string[] = []
    const errors: string[] = []
    const inputs: AudioInput[] = []
    const mac = process.platform === 'darwin'

    const rendererCfg = { ...cfg, system: cfg.system && !mac }
    if (rendererCfg.system || rendererCfg.mic) {
      if (pipe) {
        if (rendererCfg.system) this.pipes.system = await PcmPipe.create()
        if (rendererCfg.mic) this.pipes.mic = await PcmPipe.create()
        for (const p of [this.pipes.system, this.pipes.mic]) if (p) p.onConnect = () => this.noteConnect()
      }
      this.rendererRunning = true
      const res = await this.request<{ started: string[]; errors: string[] }>('audio:start', rendererCfg)
      started.push(...res.started)
      errors.push(...res.errors)
      // the volume is already applied where each source is captured
      if (res.started.includes('system') && this.pipes.system) inputs.push({ url: this.pipes.system.url, volume: 1, kind: 'pc' })
      if (res.started.includes('mic') && this.pipes.mic) inputs.push({ url: this.pipes.mic.url, volume: 1, kind: 'mic' })
    }

    if (mac && cfg.system) {
      const err = await this.startHelper(pipe)
      if (err) errors.push(`Computer sound: ${err}`)
      else {
        started.push('system')
        if (this.systemPipe) inputs.unshift({ url: this.systemPipe.url, volume: cfg.systemVolume, kind: 'pc' })
      }
    }

    return { started, errors, inputs }
  }

  private async startHelper(pipe: boolean): Promise<string | null> {
    const helper = spawnSystemAudio()
    if (!helper) return 'the macOS audio helper is missing from this build'
    if (pipe) {
      this.systemPipe = await PcmPipe.create()
      this.systemPipe.onConnect = () => this.noteConnect()
    }
    this.helper = helper
    let stderr = ''
    helper.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    const launchFailed = new Promise<boolean>((resolve) =>
      helper.on('error', (e) => {
        stderr += e.message
        resolve(false)
      })
    )

    // Forward whole stereo frames only, so FFmpeg never starts reading mid-sample.
    let carry = Buffer.alloc(0)
    let gotData: () => void = () => undefined
    const firstChunk = new Promise<void>((resolve) => (gotData = resolve))
    helper.stdout!.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const whole = data.length - (data.length % FRAME_BYTES)
      carry = Buffer.from(data.subarray(whole))
      const frames = data.subarray(0, whole)
      this.systemPipe?.write(frames)
      this.systemLevel = Math.max(peakOf(frames), (this.systemLevel ?? 0) * 0.6)
      gotData()
    })

    // The helper emits PCM (or padded silence) within ~100 ms of capture starting.
    const ok = await Promise.race([
      firstChunk.then(() => true),
      launchFailed,
      new Promise<boolean>((resolve) => helper.once('exit', () => resolve(false))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
    ])
    if (!ok) {
      this.stopHelper()
      return stderr.trim() || 'could not start (check Screen & System Audio Recording permission)'
    }

    this.levelTimer = setInterval(() => {
      this.emit('levels', { system: this.systemLevel ?? 0, mic: this.micLevel })
      this.systemLevel = (this.systemLevel ?? 0) * 0.6
    }, 100)
    return null
  }

  private stopHelper(): void {
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = null
    const helper = this.helper
    this.helper = null
    if (helper && helper.exitCode === null) {
      helper.stdin?.end()
      setTimeout(() => helper.exitCode === null && helper.kill(), 2000)
    }
    this.systemLevel = null
  }

  async stop(): Promise<void> {
    if (this.rendererRunning) {
      this.rendererRunning = false
      await this.request('audio:stop').catch(() => undefined)
    }
    this.stopHelper()
    this.micLevel = null
    const pipes = [this.pipes.system, this.pipes.mic, this.systemPipe]
    this.pipes = { system: null, mic: null }
    this.systemPipe = null
    await Promise.all(pipes.map((p) => p?.close()))
  }
}
