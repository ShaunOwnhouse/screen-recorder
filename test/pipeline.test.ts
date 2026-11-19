// Runs the real FFmpeg pipelines, with a synthetic source standing in for the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExportArgs, buildProxyArgs, buildRecordArgs, buildRemuxArgs, type RecordArgsInput } from '../src/main/args.ts'
import { parseMediaInfo } from '../src/main/parse.ts'

const ffmpeg: string = createRequire(import.meta.url)('ffmpeg-static')
const run = (args: string[]): void => void execFileSync(ffmpeg, args, { stdio: 'pipe' })

function withSyntheticInput(args: string[], fps: number, seconds: number): string[] {
  const start = args.indexOf('-f')
  const end = args.indexOf('desktop')
  const size = args[args.indexOf('-video_size') + 1]
  return [
    ...args.slice(0, start),
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps},format=bgra`,
    ...args.slice(end + 1, args.indexOf('-filter_complex')),
    '-t', String(seconds),
    ...args.slice(args.indexOf('-filter_complex'))
  ]
}

function probe(file: string): string {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' })
  } catch (e) {
    return String((e as { stderr: Buffer }).stderr)
  }
  return ''
}

type Opts = Partial<Omit<RecordArgsInput, 'outputPath' | 'backend'>> & Pick<RecordArgsInput, 'rect' | 'fps'>

function record(dir: string, o: Opts, seconds = 1): string {
  const temp = join(dir, 'a.recording.mp4')
  const mp4 = join(dir, 'a.mp4')
  const args = buildRecordArgs({
    backend: 'gdigrab', outputHeight: null, quality: 'veryhigh', encoder: 'libx264', audio: [], showCursor: true,
    ...o, outputPath: temp
  })
  run(withSyntheticInput(args, o.fps, seconds))
  run(buildRemuxArgs(temp, mp4))
  assert.ok(statSync(mp4).size > 0)
  return mp4
}

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rec-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('4K60 native capture comes out as 3840x2160 60fps H.264 BT.709', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const info = probe(record(dir, { rect: { x: 0, y: 0, width: 3840, height: 2160 }, fps: 60 }))
    assert.match(info, /h264 \(High\)/)
    assert.match(info, /yuv420p\(tv, bt709/)
    assert.match(info, /3840x2160/)
    assert.match(info, /, 60 fps/)
  }))

test('maximum quality records full 4:4:4 colour', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const info = probe(record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, quality: 'maximum' }))
    assert.match(info, /High 4:4:4/)
    assert.match(info, /yuv444p\(tv, bt709/)
  }))

test('1080p source scaled to 4K output is 3840x2160', { timeout: 120000 }, () =>
  inTemp((dir) => {
    assert.match(probe(record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, outputHeight: 2160 })), /3840x2160/)
  }))

test('audio from the PCM pipe is muxed as AAC alongside video', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const pcm = join(dir, 'audio.f32')
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', '-f', 'f32le', pcm])
    const info = probe(record(dir, { rect: { x: 0, y: 0, width: 1280, height: 720 }, fps: 30, audio: [{ url: pcm, volume: 1 }] }, 2))
    assert.match(info, /Audio: aac \(LC\).*48000 Hz, stereo/)
  }))

test('two audio sources are mixed into one track', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const a = join(dir, 'a.f32')
    const b = join(dir, 'b.f32')
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', '-f', 'f32le', a])
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-ac', '2', '-f', 'f32le', b])
    const out = record(dir, { rect: { x: 0, y: 0, width: 640, height: 360 }, fps: 30, audio: [{ url: a, volume: 1 }, { url: b, volume: 0.5 }] }, 2)
    const info = probe(out)
    assert.equal((info.match(/Stream #0:\d.*Audio:/g) ?? []).length, 1)
    assert.match(info, /Audio: aac/)
  }))

test('audio streamed over a unix socket (the macOS path) is recorded', { skip: process.platform === 'win32', timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-test-'))
  try {
    const pcmFile = join(dir, 'a.f32')
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '2', '-f', 'f32le', pcmFile])
    const pcm = readFileSync(pcmFile)
    const sock = join(dir, 'audio.sock')
    const server = createServer((s) => s.end(pcm))
    await new Promise<void>((r) => server.listen(sock, () => r()))
    const { execFile } = await import('node:child_process')
    const temp = join(dir, 'a.recording.mp4')
    const args = withSyntheticInput(
      buildRecordArgs({
        backend: 'gdigrab', rect: { x: 0, y: 0, width: 640, height: 360 }, fps: 30, outputHeight: null, quality: 'veryhigh',
        encoder: 'libx264', audio: [{ url: `unix:${sock}`, volume: 1 }], showCursor: true, outputPath: temp
      }),
      30,
      2
    )
    await new Promise<void>((resolve, reject) => execFile(ffmpeg, args, (err) => (err ? reject(err) : resolve())))
    server.close()
    assert.match(probe(temp), /Audio: aac/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('editor export trims to the kept parts and crops exactly', { timeout: 180000 }, () =>
  inTemp((dir) => {
    const pcm = join(dir, 'audio.f32')
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-ac', '2', '-f', 'f32le', pcm])
    const src = record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, audio: [{ url: pcm, volume: 1 }] }, 4)
    const out = join(dir, 'edited.mp4')
    run(buildExportArgs({
      input: src, output: out, segments: [[0.5, 1.5], [2.5, 3.5]], crop: { x: 100, y: 60, width: 1280, height: 720 },
      hasAudio: true, fps: 30, quality: 'veryhigh', encoder: 'libx264', pixelRate: 1280 * 720 * 30
    }))
    const info = parseMediaInfo(probe(out))!
    assert.equal(info.width, 1280)
    assert.equal(info.height, 720)
    assert.equal(info.fps, 30)
    assert.ok(info.hasAudio)
    assert.ok(Math.abs(info.duration - 2) < 0.15, `duration ${info.duration}`)
  }))

test('preview proxy is small 4:2:0 H.264', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const src = record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, quality: 'maximum' })
    const proxy = join(dir, 'p.mp4')
    run(buildProxyArgs(src, proxy))
    const info = probe(proxy)
    assert.match(info, /yuv420p/)
    assert.match(info, /1280x720/)
  }))
