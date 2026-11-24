import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs'
import {
  buildConcatArgs, buildJoinReencodeArgs, buildRecordArgs, buildRemuxArgs, concatList, effectiveEncoder, ENCODER_LABELS, outputSize,
  type RecordArgsInput
} from './args.ts'
import { ffmpegPath, runFfmpeg } from './ffmpeg.ts'
import { ProgressParser } from './parse.ts'
import { joinListFor, moveFile, segmentPathFor } from './pending.ts'
import { probeMedia, verifyRecording, type Verdict } from './verify.ts'
import type { RecordingStatus } from '../shared/types.ts'

type Attempt = Omit<RecordArgsInput, 'outputPath'>

export interface RecordedInfo extends Verdict {
  /** Last lines FFmpeg printed (warnings/errors). */
  stderr: string
  /** Full FFmpeg log for this recording. */
  log: string
  /** Something the person should know about a recording that did save (e.g. only part of a paused one could be joined). */
  note?: string
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
  /** When the very first piece was started (wall clock, ms): what a camera recorded alongside is lined up with. */
  firstSpawnAt = 0
  /** When the first picture of the first piece arrived (wall clock, ms). */
  firstFrameAt = 0
  private ticker: NodeJS.Timeout | null = null
  private finalPath = ''
  /** The capture method that started, reused to pick the recording back up after a pause. */
  private attempt: Attempt | null = null
  /** A paused recording is captured in pieces and joined when it stops. */
  private pieces: string[] = []
  private pieceCount = 0
  private doneSeconds = 0
  private doneBytes = 0
  private doneDropped = 0
  private pausing = false
  private transition: Promise<void> | null = null
  private resumeWarning: string | undefined
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
    this.attempt = null
    this.pieces = []
    this.pieceCount = 0
    this.doneSeconds = this.doneBytes = this.doneDropped = 0
    this.resumeWarning = undefined

    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        // Recorded as crash-safe fragmented MP4, then remuxed losslessly to a normal MP4 on stop.
        await this.launch(attempt, segmentPathFor(finalPath, ++this.pieceCount))
        this.attempt = attempt
        return
      } catch (err) {
        errors.push(`${attempt.backend}/${attempt.encoder}: ${(err as Error).message}`)
      }
    }
    this.log?.end()
    this.log = null
    throw new Error(`FFmpeg could not start recording.\n${errors.join('\n')}\nLog: ${logPath}`)
  }

  private launch(attempt: Attempt, piecePath: string): Promise<void> {
    const args = buildRecordArgs({ ...attempt, outputPath: piecePath })
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
        if (started) this.update({ bytes: this.doneBytes + p.totalSize, droppedFrames: this.doneDropped + p.dropFrames, speed: p.speed })
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
        rmSync(piecePath, { force: true })
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
        if (!this.pieces.length) {
          this.firstSpawnAt = spawnedAt
          this.firstFrameAt = Date.now()
        }
        this.pieces.push(piecePath)
        const out = outputSize(attempt.rect, attempt.outputHeight)
        this.update({
          state: 'recording', resuming: false, elapsed: this.doneSeconds + (Date.now() - spawnedAt) / 1000, bytes: this.doneBytes,
          droppedFrames: this.doneDropped, speed: null, error: undefined,
          encoder: ENCODER_LABELS[effectiveEncoder(attempt.encoder, attempt.quality)] ?? attempt.encoder,
          backend: BACKEND_LABELS[attempt.backend],
          resolution: `${out.width}×${out.height} @ ${attempt.fps}fps`
        })
        this.ticker = setInterval(() => this.update({ elapsed: this.doneSeconds + (Date.now() - this.startedAt) / 1000 }), 500)
        proc.once('exit', () => {
          if (!this.stopping && !this.pausing) this.stopping = this.finish(`Recording stopped unexpectedly: ${stderrTail.trim().split(/\r?\n/).pop() ?? ''}`)
        })
        resolve()
      }
    })
  }

  /** Pauses: the capture stops and the piece recorded so far is closed. Resume starts a new piece from here. */
  pause(): Promise<void> {
    if (this.transition) return this.transition
    const proc = this.proc
    if (this.status.state !== 'recording' || !proc || this.stopping) return Promise.resolve()
    this.transition = this.doPause(proc).finally(() => (this.transition = null))
    return this.transition
  }

  private async doPause(proc: ChildProcess): Promise<void> {
    const seconds = (Date.now() - this.startedAt) / 1000
    this.pausing = true
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.log?.write(`\n> paused after ${seconds.toFixed(1)}s of this piece\n`)
    await this.closeProcess(proc)
    this.proc = null
    // The timer should match the video exactly, so use the real length of the piece (the clock above includes FFmpeg's start-up).
    const piece = this.pieces[this.pieces.length - 1]
    const real = piece && existsSync(piece) ? (await probeMedia(piece))?.duration : undefined
    this.doneSeconds += real && real > 0 && real < seconds + 5 ? real : seconds
    this.doneBytes = this.status.bytes
    this.doneDropped = this.status.droppedFrames
    this.pausing = false
    this.update({ state: 'paused', resuming: false, elapsed: this.doneSeconds, speed: null })
  }

  /** Picks the recording back up from where it was paused, with the same capture settings. */
  resume(): Promise<void> {
    if (this.transition) return this.transition
    if (this.status.state !== 'paused' || !this.attempt || this.stopping) return Promise.resolve()
    this.transition = this.doResume(this.attempt).finally(() => (this.transition = null))
    return this.transition
  }

  private async doResume(attempt: Attempt): Promise<void> {
    this.update({ resuming: true })
    this.log?.write('\n> resuming\n')
    try {
      await this.launch(attempt, segmentPathFor(this.finalPath, ++this.pieceCount))
      if (this.status.warning && this.status.warning === this.resumeWarning) this.update({ warning: undefined })
      this.resumeWarning = undefined
    } catch (err) {
      this.resumeWarning = `Couldn’t pick the recording back up (${(err as Error).message.slice(0, 160)}). Press Resume to try again, or Stop to save what you have so far.`
      this.log?.write(`\n! resume failed: ${(err as Error).message}\n`)
      this.update({ resuming: false, warning: this.resumeWarning })
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.transition) await this.transition
    if (this.stopping) return this.stopping
    if (!this.proc && this.status.state !== 'paused') return
    this.stopping = this.finish()
    return this.stopping
  }

  /** Asks FFmpeg to finish the file cleanly ('q'), and makes sure it really has exited. */
  private async closeProcess(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null) return
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

  /** One piece → a normal faststart MP4 (falling back to the raw fragmented file if that can't be proven to play). */
  private async finishOne(piece: string): Promise<Verdict> {
    let verdict: Verdict = { ok: false, reason: 'FFmpeg did not create a recording.' }
    const remux = await runFfmpeg(buildRemuxArgs(piece, this.finalPath), 10 * 60 * 1000)
    if (remux.ok) verdict = await verifyRecording(this.finalPath)
    if (verdict.ok) {
      rmSync(piece, { force: true })
      return verdict
    }
    const raw = await verifyRecording(piece)
    if (raw.ok) {
      // The fragmented file is still a valid MP4, just less seek-friendly: keep it rather than lose the take.
      rmSync(this.finalPath, { force: true })
      moveFile(piece, this.finalPath)
      return raw
    }
    this.log?.write(`\n! verification failed: ${verdict.reason ?? ''} / raw: ${raw.reason ?? ''}\n`)
    rmSync(this.finalPath, { force: true })
    rmSync(piece, { force: true })
    return verdict
  }

  /** Several pieces (the recording was paused) → one MP4 with the pieces back to back and nothing re-encoded. */
  private async finishMany(pieces: string[]): Promise<{ verdict: Verdict; note?: string }> {
    const list = joinListFor(this.finalPath)
    writeFileSync(list, concatList(pieces))
    const clean = (): void => {
      for (const p of [...pieces, list]) rmSync(p, { force: true })
    }

    const joined = await runFfmpeg(buildConcatArgs(list, this.finalPath), 10 * 60 * 1000)
    let verdict: Verdict = joined.ok ? await verifyRecording(this.finalPath) : { ok: false, reason: `Joining the pieces failed: ${joined.stderr.trim().split(/\r?\n/).pop() ?? ''}` }
    if (verdict.ok) {
      clean()
      return { verdict }
    }
    this.log?.write(`\n! the straight join did not play (${verdict.reason ?? ''}) — encoding the pieces together instead\n`)

    const first = await verifyRecording(pieces[0])
    const again = await runFfmpeg(
      buildJoinReencodeArgs(pieces, this.finalPath, first.meta?.hasAudio ?? false, this.attempt?.quality ?? 'veryhigh'), 60 * 60 * 1000
    )
    verdict = again.ok ? await verifyRecording(this.finalPath) : { ok: false, reason: 'Could not join the pieces.' }
    if (verdict.ok) {
      clean()
      return { verdict }
    }

    // Never lose a take: keep the longest piece that plays and say that only part of it was saved.
    this.log?.write(`\n! could not join the pieces (${verdict.reason ?? ''}) — keeping the longest one that plays\n`)
    rmSync(this.finalPath, { force: true })
    const ranked = [...pieces].sort((a, b) => statSync(b).size - statSync(a).size)
    for (const piece of ranked) {
      const one = await this.finishOne(piece)
      if (one.ok) {
        clean()
        return { verdict: one, note: 'The recording could only be saved in part: the pieces from before and after the pause could not be joined, so only one of them was kept.' }
      }
    }
    clean()
    return { verdict }
  }

  private async finish(error?: string): Promise<void> {
    const proc = this.proc
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.update({ state: 'saving', resuming: false })

    if (proc) await this.closeProcess(proc)
    this.proc = null

    // Join the pieces, then prove the result plays. If it doesn't, fall back to what was captured.
    const pieces = this.pieces.filter((p) => existsSync(p) && statSync(p).size > 0)
    for (const p of this.pieces) if (!pieces.includes(p)) rmSync(p, { force: true })
    let verdict: Verdict = { ok: false, reason: 'FFmpeg did not create a recording.' }
    let note: string | undefined
    if (pieces.length === 1) verdict = await this.finishOne(pieces[0])
    else if (pieces.length > 1) ({ verdict, note } = await this.finishMany(pieces))
    this.pieces = []
    this.log?.write(`\n> verdict: ${JSON.stringify(verdict)}\n`)
    this.log?.end()
    this.log = null
    this.stopping = null
    this.update({ state: 'idle', error, resuming: false })
    const info: RecordedInfo = { ...verdict, stderr: this.stderrTail, log: this.logPath, note }
    this.emit('recorded', this.finalPath, info)
  }
}
