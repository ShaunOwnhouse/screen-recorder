// Runs the real FFmpeg filter/encode/remux pipeline, with a synthetic source standing in for the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRecordArgs, buildRemuxArgs, type RecordArgsInput } from '../src/main/args.ts'

const ffmpeg: string = createRequire(import.meta.url)('ffmpeg-static')

function withSyntheticInput(args: string[], fps: number): string[] {
  const start = args.indexOf('-f')
  const end = args.indexOf('desktop')
  const size = args[args.indexOf('-video_size') + 1]
  return [
    ...args.slice(0, start),
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps},format=bgra`,
    '-t', '1',
    ...args.slice(end + 1)
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

function record(input: Omit<RecordArgsInput, 'outputPath' | 'backend' | 'encoder' | 'audioDevice' | 'showCursor'>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rec-test-'))
  const temp = join(dir, 'a.recording.mp4')
  const mp4 = join(dir, 'a.mp4')
  const args = buildRecordArgs({ ...input, backend: 'gdigrab', encoder: 'libx264', audioDevice: null, showCursor: true, outputPath: temp })
  execFileSync(ffmpeg, withSyntheticInput(args, input.fps), { stdio: 'pipe' })
  execFileSync(ffmpeg, buildRemuxArgs(temp, mp4), { stdio: 'pipe' })
  assert.ok(statSync(mp4).size > 0)
  const info = probe(mp4)
  rmSync(dir, { recursive: true, force: true })
  return info
}

test('4K60 native capture comes out as 3840x2160 60fps H.264 BT.709', { timeout: 120000 }, () => {
  const info = record({ rect: { x: 0, y: 0, width: 3840, height: 2160 }, fps: 60, outputHeight: null, quality: 'veryhigh' })
  assert.match(info, /h264 \(High\)/)
  assert.match(info, /yuv420p\(tv, bt709/)
  assert.match(info, /3840x2160/)
  assert.match(info, /60 fps/)
})

test('1080p source scaled to 4K output is 3840x2160', { timeout: 120000 }, () => {
  const info = record({ rect: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 30, outputHeight: 2160, quality: 'high' })
  assert.match(info, /3840x2160/)
})

test('lossless region keeps exact pixel size in 4:4:4', { timeout: 120000 }, () => {
  const info = record({ rect: { x: 0, y: 0, width: 1281, height: 721 }, fps: 30, outputHeight: null, quality: 'lossless' })
  assert.match(info, /yuv444p/)
  assert.match(info, /1280x720/)
})
