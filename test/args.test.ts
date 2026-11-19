import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExportArgs, buildRecordArgs, cropToPixels, effectiveEncoder, encoderArgs, even, outputSize, type RecordArgsInput
} from '../src/main/args.ts'
import { matchOutput, parseDxgiOutputs } from '../src/main/displays.ts'
import { parseAvfoundationScreens, parseMediaInfo, parseRange, ProgressParser } from '../src/main/parse.ts'
import { isFullRange, keepOnly, playablePosition, removeRange, totalDuration } from '../src/shared/segments.ts'

const base: RecordArgsInput = {
  backend: 'gdigrab',
  rect: { x: 0, y: 0, width: 3840, height: 2160 },
  fps: 60,
  outputHeight: null,
  quality: 'veryhigh',
  encoder: 'libx264',
  audio: [],
  showCursor: true,
  outputPath: 'out.mp4'
}

const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

test('native resolution is captured and encoded without scaling', () => {
  const args = buildRecordArgs(base)
  assert.equal(after(args, '-video_size'), '3840x2160')
  assert.equal(after(args, '-filter_complex'), '[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]')
  assert.equal(after(args, '-map'), '[v]')
  assert.equal(after(args, '-r'), '60')
  assert.equal(args.at(-1), 'out.mp4')
})

test('odd region sizes are rounded down to even for yuv420p', () => {
  assert.equal(even(1001), 1000)
  const args = buildRecordArgs({ ...base, rect: { x: -1920, y: 20, width: 801, height: 601 } })
  assert.equal(after(args, '-video_size'), '800x600')
  assert.equal(after(args, '-offset_x'), '-1920')
})

test('scaling keeps aspect ratio and uses lanczos', () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1920, height: 1080 }, 2160), { width: 3840, height: 2160 })
  const args = buildRecordArgs({ ...base, rect: { x: 0, y: 0, width: 2560, height: 1440 }, outputHeight: 1080 })
  assert.match(after(args, '-filter_complex')!, /scale=w=1920:h=1080:flags=lanczos:/)
})

test('ddagrab binds to the monitor’s own GPU adapter and output', () => {
  const args = buildRecordArgs({ ...base, backend: 'ddagrab', dda: { adapter: 1, output: 2 }, rect: { x: 100, y: 50, width: 1280, height: 720 } })
  assert.equal(after(args, '-init_hw_device'), 'd3d11va=dda:1')
  assert.equal(after(args, '-filter_hw_device'), 'dda')
  assert.ok(!args.includes('gdigrab'))
  assert.match(
    after(args, '-filter_complex')!,
    /^ddagrab=output_idx=2:framerate=60:draw_mouse=1:offset_x=100:offset_y=50:video_size=1280x720,hwdownload,format=bgra,/
  )
})

test('one pre-mixed audio pipe maps straight through (index depends on capture input)', () => {
  const pipe = [{ url: '\\\\.\\pipe\\a', volume: 1 }]
  const gdi = buildRecordArgs({ ...base, audio: pipe })
  assert.equal(after(gdi, '-f'), 'gdigrab')
  assert.ok(gdi.includes('f32le'))
  assert.ok(gdi.includes('1:a'))
  assert.equal(after(gdi, '-c:a'), 'aac')

  const dda = buildRecordArgs({ ...base, backend: 'ddagrab', dda: { adapter: 0, output: 0 }, audio: pipe })
  assert.ok(dda.includes('0:a'))
})

test('two audio sources (macOS mic + computer sound) are gain-adjusted and mixed', () => {
  const args = buildRecordArgs({
    ...base,
    audio: [
      { url: 'unix:/tmp/mic.sock', volume: 1 },
      { url: 'unix:/tmp/sys.sock', volume: 0.5 }
    ]
  })
  assert.match(
    after(args, '-filter_complex')!,
    /;\[1:a\]volume=1\.00\[a0\];\[2:a\]volume=0\.50\[a1\];\[a0\]\[a1\]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0\.95\[aout\]$/
  )
  assert.equal(args[args.lastIndexOf('-map') + 1], '[aout]')
})

test('macOS capture uses avfoundation and crops regions out of the full screen', () => {
  const args = buildRecordArgs({
    ...base,
    backend: 'avfoundation',
    avf: { device: 3, pixelFormat: 'bgr0' },
    rect: { x: 200, y: 100, width: 1601, height: 901 },
    encoder: 'h264_videotoolbox'
  })
  assert.equal(after(args, '-f'), 'avfoundation')
  assert.equal(after(args, '-pixel_format'), 'bgr0')
  assert.equal(after(args, '-i'), '3:none')
  assert.match(after(args, '-filter_complex')!, /^\[0:v\]crop=1600:900:200:100,scale=/)
  assert.equal(after(args, '-c:v'), 'h264_videotoolbox')
  assert.equal(after(args, '-q:v'), '75')
  assert.ok(!buildRecordArgs({ ...base, backend: 'avfoundation', avf: { device: 1, pixelFormat: null } }).includes('-pixel_format'))
})

test('maximum quality is 4:4:4 and falls back to x264 for encoders without it', () => {
  const nv = buildRecordArgs({ ...base, quality: 'maximum', encoder: 'h264_nvenc' })
  assert.match(after(nv, '-filter_complex')!, /format=yuv444p\[v\]$/)
  assert.equal(after(nv, '-profile:v'), 'high444p')
  assert.equal(effectiveEncoder('h264_amf', 'maximum'), 'libx264')
  assert.equal(after(encoderArgs('libx264', 'maximum', 0), '-profile:v'), 'high444')
})

test('lossless always uses x264 qp 0 in 4:4:4', () => {
  const args = buildRecordArgs({ ...base, quality: 'lossless', encoder: 'h264_nvenc' })
  assert.equal(after(args, '-c:v'), 'libx264')
  assert.equal(after(args, '-qp'), '0')
})

test('NVENC uses constant quality with adaptive quantisation', () => {
  const nv = encoderArgs('h264_nvenc', 'veryhigh', 0)
  assert.equal(after(nv, '-cq'), '16')
  assert.equal(after(nv, '-spatial_aq'), '1')
  assert.equal(after(nv, '-rc-lookahead'), '20')
  assert.equal(after(encoderArgs('h264_qsv', 'high', 0), '-global_quality'), '20')
  assert.equal(after(encoderArgs('libx264', 'veryhigh', 3840 * 2160 * 60), '-preset'), 'superfast')
})

test('export keeps selected parts, crops, and keeps audio in sync', () => {
  const args = buildExportArgs({
    input: 'in.mp4', output: 'out.mp4', segments: [[1, 2.5], [4, 6]], crop: { x: 10, y: 20, width: 640, height: 360 },
    hasAudio: true, fps: 60, quality: 'veryhigh', encoder: 'libx264', pixelRate: 0
  })
  assert.equal(
    after(args, '-vf'),
    'select=between(t\\,1.000\\,2.500)+between(t\\,4.000\\,6.000),setpts=N/FRAME_RATE/TB,crop=640:360:10:20,format=yuv420p'
  )
  assert.equal(after(args, '-af'), 'aselect=between(t\\,1.000\\,2.500)+between(t\\,4.000\\,6.000),asetpts=N/SR/TB')
})

test('crop converts to even in-bounds pixels; full frame means no crop', () => {
  assert.deepEqual(cropToPixels({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 1921, 1081), { x: 192, y: 108, width: 960, height: 540 })
  assert.equal(cropToPixels({ x: 0, y: 0, width: 1, height: 1 }, 1920, 1080), null)
  const edge = cropToPixels({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }, 1000, 1000)!
  assert.ok(edge.x + edge.width <= 1000 && edge.y + edge.height <= 1000)
})

test('segment editing: remove, keep only, playback skipping', () => {
  let keep = removeRange([[0, 10]], 3, 5)
  assert.deepEqual(keep, [[0, 3], [5, 10]])
  keep = keepOnly(keep, 2, 7)
  assert.deepEqual(keep, [[2, 3], [5, 7]])
  assert.equal(totalDuration(keep), 3)
  assert.equal(playablePosition(keep, 0), 2)
  assert.equal(playablePosition(keep, 4), 5)
  assert.equal(playablePosition(keep, 6), 6)
  assert.equal(playablePosition(keep, 8), null)
  assert.ok(isFullRange([[0, 10]], 10))
  assert.ok(!isFullRange(keep, 10))
  assert.deepEqual(removeRange([[0, 10]], 0, 10), [])
})

test('DXGI outputs parse and match displays by physical bounds', () => {
  const outputs = parseDxgiOutputs(
    'noise\r\n[{"adapter":0,"output":0,"name":"\\\\\\\\.\\\\DISPLAY1","left":0,"top":0,"right":3840,"bottom":2160},' +
      '{"adapter":1,"output":0,"name":"\\\\\\\\.\\\\DISPLAY2","left":-1920,"top":0,"right":0,"bottom":1080}]\r\n'
  )
  assert.equal(outputs.length, 2)
  assert.equal(matchOutput(outputs, { x: -1920, y: 0, width: 1920, height: 1080 })?.adapter, 1)
  assert.equal(matchOutput(outputs, { x: 0, y: 0, width: 3840, height: 2160 })?.output, 0)
  assert.equal(matchOutput(outputs, { x: 5000, y: 0, width: 1920, height: 1080 }), null)
  assert.deepEqual(parseDxgiOutputs('garbage'), [])
})

test('progress parser emits one entry per block', () => {
  const p = new ProgressParser()
  assert.deepEqual(p.push('frame=10\ntotal_size=2048\ndrop_fr'), [])
  const [prog] = p.push('ames=3\nspeed=0.98x\nprogress=continue\n')
  assert.equal(prog.frame, 10)
  assert.equal(prog.dropFrames, 3)
  assert.equal(prog.speed, 0.98)
})

test('media info is read from ffmpeg -i output', () => {
  const info = parseMediaInfo(
    "Input #0, mov,mp4, from 'a.mp4':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s\n" +
      '  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(tv, bt709, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 1 kb/s, 60 fps, 60 tbr\n' +
      '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s\n'
  )
  assert.deepEqual(info, { width: 3840, height: 2160, fps: 60, duration: 62.5, yuv444: true, hasAudio: true })
})

test('avfoundation screen devices are found after cameras', () => {
  const screens = parseAvfoundationScreens(
    '[AVFoundation indev @ 0x1] AVFoundation video devices:\n' +
      '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n' +
      '[AVFoundation indev @ 0x1] [1] Capture screen 0\n' +
      '[AVFoundation indev @ 0x1] [2] Capture screen 1\n' +
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:\n' +
      '[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone\n'
  )
  assert.equal(screens.get(0), 1)
  assert.equal(screens.get(1), 2)
  assert.equal(screens.size, 2)
})

test('byte ranges for video seeking', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 })
  assert.equal(parseRange(null, 1000), null)
})
