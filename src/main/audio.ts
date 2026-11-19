import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
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
}

type Loader = (win: BrowserWindow) => void

/**
 * Captures computer sound (WASAPI loopback via Chromium) and a microphone in a hidden window,
 * mixes them, and serves the result as 48 kHz stereo f32le PCM on a named pipe FFmpeg reads from.
 */
export class AudioCapture extends EventEmitter {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private server: Server | null = null
  private sink: Socket | null = null
  private running = false
  private seq = 0

  constructor(
    private readonly preload: string,
    private readonly load: Loader
  ) {
    super()
    ipcMain.on('audio:pcm', (e, chunk: ArrayBufferView) => {
      if (e.sender !== this.win?.webContents) return
      const sink = this.sink
      if (sink && !sink.destroyed && sink.writable) sink.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })
    ipcMain.on('audio:levels', (e, levels: AudioLevels) => {
      if (e.sender === this.win?.webContents) this.emit('levels', levels)
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

  listMicrophones(): Promise<MicInfo[]> {
    return this.request<MicInfo[]>('audio:devices').catch(() => [])
  }

  /** Starts capture. With `pipe`, PCM is served on a named pipe whose path is returned. */
  async start(cfg: AudioConfig, pipe: boolean): Promise<AudioStartResult & { pipePath: string | null }> {
    await this.stop()
    let pipePath: string | null = null
    if (pipe) {
      pipePath =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\screen-recorder-audio-${process.pid}-${Date.now()}`
          : join(tmpdir(), `screen-recorder-audio-${process.pid}-${Date.now()}.sock`)
      this.server = createServer((socket) => {
        // Only audio captured after FFmpeg connects is sent, so it lines up with the first video frame.
        this.sink?.destroy()
        this.sink = socket
        socket.on('error', () => socket.destroy())
      })
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(pipePath!, () => resolve())
      })
    }
    this.running = true
    const result = await this.request<AudioStartResult>('audio:start', cfg)
    return { ...result, pipePath }
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.running = false
      await this.request('audio:stop').catch(() => undefined)
    }
    this.sink?.end()
    this.sink = null
    if (this.server) {
      const server = this.server
      this.server = null
      const addr = server.address()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (typeof addr === 'string' && process.platform !== 'win32') rmSync(addr, { force: true })
    }
  }
}
