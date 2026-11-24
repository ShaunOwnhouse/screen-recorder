// Runs the real FFmpeg pipelines, with a synthetic source standing in for the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildConcatArgs, buildExportArgs, buildJoinReencodeArgs, buildProxyArgs, buildRecordArgs, buildRemuxArgs, concatList, type RecordArgsInput
} from '../src/main/args.ts'
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

test('maximum quality is H.264 High 4:2:0, the format Windows Media Player plays', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const info = probe(record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, quality: 'maximum' }))
    assert.match(info, /h264 \(High\)/)
    assert.match(info, /yuv420p\(tv, bt709/)
  }))

test('studio quality records full 4:4:4 colour', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const info = probe(record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, quality: 'studio' }))
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
    const src = record(dir, { rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, quality: 'studio' })
    const proxy = join(dir, 'p.mp4')
    run(buildProxyArgs(src, proxy))
    const info = probe(proxy)
    assert.match(info, /yuv420p/)
    assert.match(info, /1280x720/)
  }))

test('a 4:4:4 recording converts to a play-everywhere 4:2:0 H.264 file', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const src = record(dir, { rect: { x: 0, y: 0, width: 1280, height: 720 }, fps: 30, quality: 'studio' })
    assert.match(probe(src), /High 4:4:4/)
    const out = join(dir, 'compatible.mp4')
    run(buildExportArgs({
      input: src, output: out, segments: [[0, 1]], crop: null, hasAudio: false, fps: 30, quality: 'maximum', encoder: 'libx264', pixelRate: 0
    }))
    const info = probe(out)
    assert.match(info, /h264 \(High\)/)
    assert.match(info, /yuv420p\(tv, bt709/)
  }))

test('studio recordings keep lossless ALAC audio; maximum uses 320k AAC', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const pcm = join(dir, 'a.f32')
    run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', '-f', 'f32le', pcm])
    const studio = probe(record(dir, { rect: { x: 0, y: 0, width: 640, height: 360 }, fps: 30, quality: 'studio', audio: [{ url: pcm, volume: 1 }] }, 2))
    assert.match(studio, /Audio: alac/)
    const max = probe(record(dir, { rect: { x: 0, y: 0, width: 640, height: 360 }, fps: 30, quality: 'maximum', audio: [{ url: pcm, volume: 1 }] }, 2))
    assert.match(max, /Audio: aac \(LC\).*48000 Hz, stereo/)
  }))

// ---- pause and resume: a recording made in pieces is joined back into one seamless file ----

/** Records one synthetic piece (with a sine tone for audio) like the app does between Resume and Pause/Stop. */
function recordPiece(dir: string, n: number, seconds: number, o: Partial<RecordArgsInput> = {}): string {
  const pcm = join(dir, `tone${n}.f32`)
  run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:sample_rate=48000:duration=${seconds}`, '-ac', '2', '-f', 'f32le', pcm])
  const out = join(dir, `piece${n}.recording.mp4`)
  const args = buildRecordArgs({
    backend: 'gdigrab', rect: { x: 0, y: 0, width: 1280, height: 720 }, fps: 30, outputHeight: null, quality: 'veryhigh', encoder: 'libx264',
    audio: [{ url: pcm, volume: 1 }], showCursor: true, ...o, outputPath: out
  })
  run(withSyntheticInput(args, o.fps ?? 30, seconds))
  return out
}

function streamSeconds(file: string, kind: 'v' | 'a'): number {
  // Decodes just one stream and reads how long it really is.
  const err = (() => {
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-map', `0:${kind}`, '-f', 'null', '-'], { stdio: 'pipe' })
      return ''
    } catch (e) {
      return String((e as { stderr: Buffer }).stderr)
    }
  })()
  void err
  const out = execFileSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', `0:${kind}`, '-f', 'null', '-', '-progress', 'pipe:1'], { stdio: 'pipe' }).toString()
  const us = [...out.matchAll(/out_time_us=(\d+)/g)].map((m) => Number(m[1]))
  return Math.max(...us) / 1e6
}

for (const quality of ['veryhigh', 'studio'] as const) {
  test(`pieces recorded around a pause join into one seamless ${quality} file`, { timeout: 180000 }, () =>
    inTemp((dir) => {
      const pieces = [recordPiece(dir, 1, 2, { quality }), recordPiece(dir, 2, 1.5, { quality }), recordPiece(dir, 3, 1, { quality })]
      const list = join(dir, 'pieces.txt')
      writeFileSync(list, concatList(pieces))
      const joined = join(dir, 'joined.mp4')
      run(buildConcatArgs(list, joined))

      const meta = parseMediaInfo(probe(joined))!
      assert.ok(Math.abs(meta.duration - 4.5) < 0.25, `duration ${meta.duration}`)
      assert.equal(meta.width, 1280)
      assert.equal(meta.height, 720)
      assert.ok(meta.hasAudio)
      const info = probe(joined)
      assert.equal((info.match(/Stream #0:\d.*Video:/g) ?? []).length, 1)
      assert.equal((info.match(/Stream #0:\d.*Audio:/g) ?? []).length, 1)
      // Plays from start to end with no decode errors, and video and sound end together (no drift across the joins).
      assert.equal(execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', joined, '-f', 'null', '-'], { stdio: 'pipe' }).toString(), '')
      const v = streamSeconds(joined, 'v')
      const a = streamSeconds(joined, 'a')
      assert.ok(Math.abs(v - 4.5) < 0.2, `video ${v}`)
      assert.ok(Math.abs(a - v) < 0.15, `audio ${a} vs video ${v}`)
      // Same colour tags and (for the playable tier) the same pixel format as a single-piece recording.
      assert.match(info, quality === 'studio' ? /yuv444p/ : /yuv420p\(tv, bt709/)
    }))
}

test('a joined recording starts like any other: faststart, so players open it instantly', { timeout: 120000 }, () =>
  inTemp((dir) => {
    const pieces = [recordPiece(dir, 1, 1), recordPiece(dir, 2, 1)]
    const list = join(dir, 'p.txt')
    writeFileSync(list, concatList(pieces))
    const joined = join(dir, 'j.mp4')
    run(buildConcatArgs(list, joined))
    const head = readFileSync(joined).subarray(0, 4096).toString('latin1')
    assert.ok(head.indexOf('moov') > 0 && head.indexOf('moov') < (readFileSync(joined).indexOf('mdat') >>> 0 || Infinity))
  }))

test('the fallback join (re-encode) also produces one playable file of the right length', { timeout: 180000 }, () =>
  inTemp((dir) => {
    const pieces = [recordPiece(dir, 1, 1.5), recordPiece(dir, 2, 1.5)]
    const out = join(dir, 'r.mp4')
    run(buildJoinReencodeArgs(pieces, out, true, 'veryhigh'))
    const meta = parseMediaInfo(probe(out))!
    assert.ok(Math.abs(meta.duration - 3) < 0.25, `duration ${meta.duration}`)
    assert.ok(meta.hasAudio)
    assert.equal(execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', out, '-f', 'null', '-'], { stdio: 'pipe' }).toString(), '')
    assert.match(probe(out), /yuv420p\(tv, bt709/)
  }))

test('the concat list quotes awkward file names', () => {
  assert.equal(concatList(['C:\\Users\\Jo\'s PC\\a.mp4']), "file 'C:/Users/Jo'\\''s PC/a.mp4'\n")
})
