import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { buildRecordArgs, buildRemuxArgs, effectiveEncoder, ENCODER_LABELS, outputSize, type RecordArgsInput } from './args.ts'
import { ffmpegPath, runFfmpeg } from './ffmpeg.ts'
import { ProgressParser } from './parse.ts'
import { moveFile, tempPathFor } from './pending.ts'
import type { RecordingStatus } from '../shared/types.ts'

type Attempt = Omit<RecordArgsInput, 'outputPath'>

const STARTUP_GRACE_MS = 1500
const STOP_TIMEOUT_MS = 15000

export class Recorder extends EventEmitter {
  private proc: ChildProcess | null = null
  private status: RecordingStatus = { state: 'idle', elapsed: 0, bytes: 0, droppedFrames: 0, speed: null, pending: null }
  private startedAt = 0
  private ticker: NodeJS.Timeout | null = null
  private tempPath = ''
  private finalPath = ''
  private stopping: Promise<void> | null = null

  getStatus(): RecordingStatus {
    return this.status
  }

  update(patch: Partial<RecordingStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  /** Tries each attempt in order (e.g. Desktop Duplication + GPU first, GDI + CPU last). */
  async start(attempts: Attempt[], finalPath: string): Promise<void> {
    if (this.proc) throw new Error('Already recording.')
    this.finalPath = finalPath
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
    throw new Error(`FFmpeg could not start recording.\n${errors.join('\n')}`)
  }

  private launch(attempt: Attempt): Promise<void> {
    const args = buildRecordArgs({ ...attempt, outputPath: this.tempPath })
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // Capture begins at spawn, not after the startup check, so time the recording from here.
    const spawnedAt = Date.now()
    const parser = new ProgressParser()
    let stderrTail = ''

    proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      for (const p of parser.push(chunk)) {
        this.update({ bytes: p.totalSize, droppedFrames: p.dropFrames, speed: p.speed })
      }
    })
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (msg: string): void => {
        if (settled) return
        settled = true
        rmSync(this.tempPath, { force: true })
        reject(new Error(msg.trim().split(/\r?\n/).slice(-3).join(' ') || 'exited immediately'))
      }

      proc.once('error', (err) => fail(err.message))
      proc.once('exit', () => fail(stderrTail))

      setTimeout(() => {
        if (settled) return
        settled = true
        this.proc = proc
        this.startedAt = spawnedAt
        const out = outputSize(attempt.rect, attempt.outputHeight)
        this.update({
          state: 'recording', elapsed: 0, bytes: 0, droppedFrames: 0, speed: null, error: undefined,
          encoder: ENCODER_LABELS[effectiveEncoder(attempt.encoder, attempt.quality)] ?? attempt.encoder,
          backend: attempt.backend === 'ddagrab' ? 'Desktop Duplication' : 'GDI',
          resolution: `${out.width}×${out.height} @ ${attempt.fps}fps`
        })
        this.ticker = setInterval(() => this.update({ elapsed: (Date.now() - this.startedAt) / 1000 }), 500)
        proc.once('exit', () => {
          if (!this.stopping) this.stopping = this.finish(`Recording stopped unexpectedly: ${stderrTail.trim().split(/\r?\n/).pop() ?? ''}`)
        })
        resolve()
      }, STARTUP_GRACE_MS)
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
        const killer = setTimeout(() => proc.kill(), STOP_TIMEOUT_MS)
        proc.once('exit', () => {
          clearTimeout(killer)
          resolve()
        })
        // 'q' asks FFmpeg to flush and close the file cleanly.
        proc.stdin!.write('q')
        proc.stdin!.end()
      })
    }
    this.proc = null

    const remux = await runFfmpeg(buildRemuxArgs(this.tempPath, this.finalPath), 10 * 60 * 1000)
    if (remux.ok) rmSync(this.tempPath, { force: true })
    // The fragmented file is still a valid MP4, just less seek-friendly, so keep it rather than lose the take.
    else moveFile(this.tempPath, this.finalPath)
    this.stopping = null
    this.update({ state: 'idle', error })
    this.emit('recorded', this.finalPath)
  }
}
