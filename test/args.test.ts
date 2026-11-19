import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRecordArgs, encoderArgs, even, outputSize, type RecordArgsInput } from '../src/main/args.ts'
import { parseDshowAudioDevices, ProgressParser } from '../src/main/parse.ts'

const base: RecordArgsInput = {
  backend: 'gdigrab',
  rect: { x: 0, y: 0, width: 3840, height: 2160 },
  fps: 60,
  outputHeight: null,
  quality: 'veryhigh',
  encoder: 'libx264',
  audioDevice: null,
  showCursor: true,
  outputPath: 'out.mp4'
}

const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

test('native resolution is captured and encoded without scaling', () => {
  const args = buildRecordArgs(base)
  assert.equal(after(args, '-video_size'), '3840x2160')
  assert.equal(after(args, '-vf'), 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p')
  assert.equal(after(args, '-r'), '60')
  assert.equal(args.at(-1), 'out.mp4')
})

test('odd region sizes are rounded down to even for yuv420p', () => {
  assert.equal(even(1001), 1000)
  const args = buildRecordArgs({ ...base, rect: { x: 10, y: 20, width: 801, height: 601 } })
  assert.equal(after(args, '-video_size'), '800x600')
  assert.equal(after(args, '-offset_x'), '10')
  assert.equal(after(args, '-offset_y'), '20')
})

test('scaling keeps aspect ratio and uses lanczos', () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1920, height: 1080 }, 2160), { width: 3840, height: 2160 })
  const args = buildRecordArgs({ ...base, rect: { x: 0, y: 0, width: 2560, height: 1440 }, outputHeight: 1080 })
  assert.match(after(args, '-vf')!, /^scale=w=1920:h=1080:flags=lanczos:/)
})

test('ddagrab uses desktop duplication and downloads frames from the GPU', () => {
  const args = buildRecordArgs({ ...base, backend: 'ddagrab' })
  assert.equal(after(args, '-f'), 'lavfi')
  assert.match(after(args, '-i')!, /^ddagrab=output_idx=0:framerate=60:draw_mouse=1:offset_x=0:offset_y=0:video_size=3840x2160$/)
  assert.match(after(args, '-vf')!, /^hwdownload,format=bgra,/)
})

test('audio adds a dshow input, mapping and AAC', () => {
  const args = buildRecordArgs({ ...base, audioDevice: 'Microphone (Realtek)' })
  assert.ok(args.includes('audio=Microphone (Realtek)'))
  assert.ok(args.includes('1:a'))
  assert.equal(after(args, '-c:a'), 'aac')
})

test('lossless always uses x264 qp 0 in 4:4:4', () => {
  const args = buildRecordArgs({ ...base, quality: 'lossless', encoder: 'h264_nvenc' })
  assert.equal(after(args, '-c:v'), 'libx264')
  assert.equal(after(args, '-qp'), '0')
  assert.match(after(args, '-vf')!, /format=yuv444p$/)
})

test('hardware encoders get constant-quality settings', () => {
  assert.deepEqual(encoderArgs('h264_nvenc', 'veryhigh', 0).slice(0, 2), ['-c:v', 'h264_nvenc'])
  assert.equal(after(encoderArgs('h264_nvenc', 'veryhigh', 0), '-cq'), '16')
  assert.equal(after(encoderArgs('h264_qsv', 'high', 0), '-global_quality'), '20')
  assert.equal(after(encoderArgs('libx264', 'veryhigh', 3840 * 2160 * 60), '-preset'), 'superfast')
})

test('progress parser emits one entry per block', () => {
  const p = new ProgressParser()
  assert.deepEqual(p.push('frame=10\ntotal_size=2048\ndrop_fr'), [])
  const [prog] = p.push('ames=3\nspeed=0.98x\nprogress=continue\n')
  assert.equal(prog.frame, 10)
  assert.equal(prog.totalSize, 2048)
  assert.equal(prog.dropFrames, 3)
  assert.equal(prog.speed, 0.98)
})

test('dshow audio devices parse in new and legacy formats', () => {
  const modern = [
    '[dshow @ 0001] "HD Webcam" (video)',
    '[dshow @ 0001]   Alternative name "@device_pnp_x"',
    '[dshow @ 0001] "Microphone (Realtek Audio)" (audio)',
    '[dshow @ 0001] "Stereo Mix (Realtek Audio)" (audio)'
  ].join('\n')
  assert.deepEqual(parseDshowAudioDevices(modern), ['Microphone (Realtek Audio)', 'Stereo Mix (Realtek Audio)'])

  const legacy = [
    '[dshow @ 0001] DirectShow video devices',
    '[dshow @ 0001]  "HD Webcam"',
    '[dshow @ 0001] DirectShow audio devices',
    '[dshow @ 0001]  "Microphone (USB)"'
  ].join('\n')
  assert.deepEqual(parseDshowAudioDevices(legacy), ['Microphone (USB)'])
})
