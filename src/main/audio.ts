import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import type { AudioInput } from './args.ts'
import { spawnSystemAudio } from './mac-helper.ts'
import type { AudioLevels, MicInfo } from '../shared/types.ts'

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
 * - Windows: computer sound (WASAPI loopback via Chromium) and the mic are captured and mixed in a
 *   hidden window, then served as one 48 kHz stereo f32le stream.
 * - macOS: the mic comes from the hidden window; computer sound comes from the native
 *   ScreenCaptureKit helper on a second pipe, and FFmpeg mixes the two.
 */
export class AudioCapture extends EventEmitter {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private mixPipe: PcmPipe | null = null
  private systemPipe: PcmPipe | null = null
  private helper: ChildProcess | null = null
  private rendererRunning = false
  private seq = 0
  private micLevel: number | null = null
  private systemLevel: number | null = null
  private levelTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly preload: string,
    private readonly load: Loader
  ) {
    super()
    ipcMain.on('audio:pcm', (e, chunk: ArrayBufferView) => {
      if (e.sender !== this.win?.webContents) return
      this.mixPipe?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
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

  /** `prime` briefly opens the default mic so device names are available (asks permission on macOS). */
  listMicrophones(prime = true): Promise<MicInfo[]> {
    return this.request<MicInfo[]>('audio:devices', { prime }).catch(() => [])
  }

  /** Starts capture. With `pipe`, audio is served for FFmpeg; without, it only drives the level meters. */
  async start(cfg: AudioConfig, pipe: boolean): Promise<AudioStartResult> {
    await this.stop()
    const started: string[] = []
    const errors: string[] = []
    const inputs: AudioInput[] = []
    const mac = process.platform === 'darwin'

    const rendererCfg = { ...cfg, system: cfg.system && !mac }
    if (rendererCfg.system || rendererCfg.mic) {
      if (pipe) this.mixPipe = await PcmPipe.create()
      this.rendererRunning = true
      const res = await this.request<{ started: string[]; errors: string[] }>('audio:start', rendererCfg)
      started.push(...res.started)
      errors.push(...res.errors)
      if (res.started.length && this.mixPipe) inputs.push({ url: this.mixPipe.url, volume: 1 })
    }

    if (mac && cfg.system) {
      const err = await this.startHelper(pipe)
      if (err) errors.push(`Computer sound: ${err}`)
      else {
        started.push('system')
        if (this.systemPipe) inputs.push({ url: this.systemPipe.url, volume: cfg.systemVolume })
      }
    }

    return { started, errors, inputs }
  }

  private async startHelper(pipe: boolean): Promise<string | null> {
    const helper = spawnSystemAudio()
    if (!helper) return 'the macOS audio helper is missing from this build'
    if (pipe) this.systemPipe = await PcmPipe.create()
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
    const pipes = [this.mixPipe, this.systemPipe]
    this.mixPipe = null
    this.systemPipe = null
    await Promise.all(pipes.map((p) => p?.close()))
  }
}
