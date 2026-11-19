import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, rmSync, type WriteStream } from 'node:fs'
import { buildRecordArgs, buildRemuxArgs, effectiveEncoder, ENCODER_LABELS, outputSize, type RecordArgsInput } from './args.ts'
import { ffmpegPath, runFfmpeg } from './ffmpeg.ts'
import { ProgressParser } from './parse.ts'
import { moveFile, tempPathFor } from './pending.ts'
import { verifyRecording, type Verdict } from './verify.ts'
import type { RecordingStatus } from '../shared/types.ts'

type Attempt = Omit<RecordArgsInput, 'outputPath'>

export interface RecordedInfo extends Verdict {
  /** Last lines FFmpeg printed (warnings/errors). */
  stderr: string
  /** Full FFmpeg log for this recording. */
  log: string
}

const BACKEND_LABELS: Record<Attempt['backend'], string> = {
  ddagrab: 'Desktop Duplication',
  gdigrab: 'GDI',
  avfoundation: 'AVFoundation',
  x11grab: 'X11'
}

/** A capture method must deliver a real video frame within this long, or the next one is tried. */
const FIRST_FRAME_TIMEOUT_MS = 10000
const STOP_TIMEOUT_MS = 20000
const STOP_RETRY_MS = 5000

export class Recorder extends EventEmitter {
  private proc: ChildProcess | null = null
  private status: RecordingStatus = { state: 'idle', elapsed: 0, bytes: 0, droppedFrames: 0, speed: null, pending: null }
  private startedAt = 0
  private ticker: NodeJS.Timeout | null = null
  private tempPath = ''
  private finalPath = ''
  private stopping: Promise<void> | null = null
  private log: WriteStream | null = null
  private logPath = ''
  private stderrTail = ''
  private pendingNotes: string[] = []

  /** Adds a diagnostic line to this recording's log (queued until the log exists). */
  addNote(text: string): void {
    if (this.log) this.log.write(`# ${text}\n`)
    else this.pendingNotes.push(text)
  }

  getStatus(): RecordingStatus {
    return this.status
  }

  update(patch: Partial<RecordingStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  /** Tries each attempt in order (e.g. Desktop Duplication + GPU first, GDI + CPU last). */
  async start(attempts: Attempt[], finalPath: string, logPath: string): Promise<void> {
    if (this.proc) throw new Error('Already recording.')
    this.finalPath = finalPath
    this.logPath = logPath
    this.stderrTail = ''
    this.log?.end()
    this.log = createWriteStream(logPath)
    for (const n of this.pendingNotes) this.log.write(`# ${n}\n`)
    this.pendingNotes = []
    // Recorded as crash-safe fragmented MP4, then remuxed losslessly to a normal MP4 on stop.
    this.tempPath = tempPathFor(finalPath)

    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        await this.launch(attempt)
        return
      } catch (err) {
        errors.push(`${attempt.backend}/${attempt.encoder}: ${(err as Error).message}`)
      }
    }
    this.log?.end()
    this.log = null
    throw new Error(`FFmpeg could not start recording.\n${errors.join('\n')}\nLog: ${logPath}`)
  }

  private launch(attempt: Attempt): Promise<void> {
    const args = buildRecordArgs({ ...attempt, outputPath: this.tempPath })
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // Capture begins at spawn, not after the first frame arrives, so time the recording from here.
    const spawnedAt = Date.now()
    const parser = new ProgressParser()
    let stderrTail = ''
    let started = false
    let timedOut = false
    let onFirstFrame: () => void = () => undefined
    this.log?.write(`\n> ${attempt.backend} / ${attempt.encoder}\n> ffmpeg ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`)

    proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      for (const p of parser.push(chunk)) {
        if (started) this.update({ bytes: p.totalSize, droppedFrames: p.dropFrames, speed: p.speed })
        if (p.frame >= 1) onFirstFrame()
      }
    })
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
      this.stderrTail = stderrTail
      this.log?.write(chunk)
    })

    return new Promise((resolve, reject) => {
      let settled = false
      const watchdog = setTimeout(() => {
        // FFmpeg is running but capturing nothing (e.g. a capture API that silently yields no frames).
        timedOut = true
        this.log?.write(`\n! no video frame within ${FIRST_FRAME_TIMEOUT_MS / 1000}s — stopping this attempt\n`)
        proc.kill()
      }, FIRST_FRAME_TIMEOUT_MS)

      const fail = (msg: string): void => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        rmSync(this.tempPath, { force: true })
        reject(new Error(msg.trim().split(/\r?\n/).slice(-3).join(' ') || 'exited immediately'))
      }

      proc.once('error', (err) => fail(err.message))
      // Only reject once the process has really exited, so the next attempt never fights for the output file.
      proc.once('exit', () => fail(timedOut ? `no video frames were captured within ${FIRST_FRAME_TIMEOUT_MS / 1000} s` : stderrTail))

      onFirstFrame = () => {
        if (settled) return
        settled = true
        started = true
        clearTimeout(watchdog)
        this.proc = proc
        this.startedAt = spawnedAt
        const out = outputSize(attempt.rect, attempt.outputHeight)
        this.update({
          state: 'recording', elapsed: (Date.now() - spawnedAt) / 1000, bytes: 0, droppedFrames: 0, speed: null, error: undefined,
          encoder: ENCODER_LABELS[effectiveEncoder(attempt.encoder, attempt.quality)] ?? attempt.encoder,
          backend: BACKEND_LABELS[attempt.backend],
          resolution: `${out.width}×${out.height} @ ${attempt.fps}fps`
        })
        this.ticker = setInterval(() => this.update({ elapsed: (Date.now() - this.startedAt) / 1000 }), 500)
        proc.once('exit', () => {
          if (!this.stopping) this.stopping = this.finish(`Recording stopped unexpectedly: ${stderrTail.trim().split(/\r?\n/).pop() ?? ''}`)
        })
        resolve()
      }
    })
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.proc) return Promise.resolve()
    this.stopping = this.finish()
    return this.stopping
  }

  private async finish(error?: string): Promise<void> {
    const proc = this.proc
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.update({ state: 'saving' })

    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        let retry: NodeJS.Timeout | null = null
        const killer = setTimeout(() => {
          this.log?.write('\n! FFmpeg did not stop in time — terminating it\n')
          proc.kill()
        }, STOP_TIMEOUT_MS)
        proc.once('exit', () => {
          clearTimeout(killer)
          if (retry) clearTimeout(retry)
          resolve()
        })
        // 'q' asks FFmpeg to flush and close the file cleanly. Keep stdin open: on Windows FFmpeg polls
        // it with PeekNamedPipe, which treats an already-closed pipe as "no input".
        const quit = (): void => {
          if (proc.stdin?.writable) proc.stdin.write('q')
        }
        quit()
        retry = setTimeout(quit, STOP_RETRY_MS)
      })
    }
    this.proc = null

    // Remux to a normal MP4, then prove the result plays. If it doesn't, fall back to the raw take.
    let verdict: Verdict = { ok: false, reason: 'FFmpeg did not create a recording.' }
    if (existsSync(this.tempPath)) {
      const remux = await runFfmpeg(buildRemuxArgs(this.tempPath, this.finalPath), 10 * 60 * 1000)
      if (remux.ok) verdict = await verifyRecording(this.finalPath)
      if (verdict.ok) {
        rmSync(this.tempPath, { force: true })
      } else {
        const raw = await verifyRecording(this.tempPath)
        if (raw.ok) {
          // The fragmented file is still a valid MP4, just less seek-friendly: keep it rather than lose the take.
          rmSync(this.finalPath, { force: true })
          moveFile(this.tempPath, this.finalPath)
          verdict = raw
        } else {
          this.log?.write(`\n! verification failed: ${verdict.reason ?? ''} / raw: ${raw.reason ?? ''}\n`)
          rmSync(this.finalPath, { force: true })
          rmSync(this.tempPath, { force: true })
        }
      }
    }
    this.log?.write(`\n> verdict: ${JSON.stringify(verdict)}\n`)
    this.log?.end()
    this.log = null
    this.stopping = null
    this.update({ state: 'idle', error })
    const info: RecordedInfo = { ...verdict, stderr: this.stderrTail, log: this.logPath }
    this.emit('recorded', this.finalPath, info)
  }
}
