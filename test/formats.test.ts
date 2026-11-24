import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCopyArgs, buildImageConvertArgs, GIF_MAX_FPS, GIF_MAX_WIDTH } from '../src/main/args.ts'
import { buildProjectArgs } from '../src/main/project-export.ts'
import { newProject } from '../src/shared/project.ts'
import type { VideoFormat } from '../src/shared/types.ts'
import { cropBox, pngSize } from '../src/main/crop.ts'
import { sanitizeFileName, uniquePath } from '../src/main/filenames.ts'
import { availableFormats } from '../src/main/ffmpeg-codecs.ts'
import { DEFAULT_IMAGE_FORMAT, DEFAULT_VIDEO_FORMAT, IMAGE_FORMATS, VIDEO_FORMATS } from '../src/shared/formats.ts'

/** The command for saving a 10 s, 1080p, 60 fps recording in a format. */
function made(format: VideoFormat, over: { hasAudio?: boolean; fps?: number } = {}): string[] {
  const hasAudio = over.hasAudio ?? true
  return buildProjectArgs({
    project: newProject({ duration: 10, width: 1920, height: 1080, hasAudio }),
    media: { recording: { path: 'in.mp4', kind: 'video', hasAudio, duration: 10, width: 1920, height: 1080 } },
    pictures: {}, recording: { width: 1920, height: 1080 }, fps: over.fps ?? 60, output: 'out', format, quality: 'maximum', encoder: 'libx264'
  }).args
}

test('MKV / MOV re-wrap copies the streams: no re-encode', () => {
  const mkv = buildCopyArgs('in.mp4', 'out.mkv', 'mkv')
  assert.ok(mkv.join(' ').includes('-c copy'))
  assert.ok(!mkv.includes('-movflags'))
  const mov = buildCopyArgs('in.mp4', 'out.mov', 'mov')
  assert.ok(mov.join(' ').includes('-movflags +faststart'))
  for (const a of [mkv, mov]) assert.ok(!a.includes('-c:v'), 'copy must not name an encoder')
})

test('H.264 edits keep MKV free of the MP4-only faststart flag', () => {
  assert.ok(!made('mkv').includes('-movflags'))
  assert.ok(made('mov').includes('-movflags'))
  assert.ok(made('mp4').includes('-movflags'))
})

test('H.265: libx265 at a visually lossless target, tagged for Apple/Windows, AAC audio, 4:2:0', () => {
  const a = made('hevc').join(' ')
  assert.match(a, /-c:v libx265 .*-crf 15/)
  assert.match(a, /-tag:v hvc1/)
  assert.match(a, /-c:a aac -b:a 320k/)
  assert.match(a, /format=yuv420p/)
  assert.match(a, /-colorspace bt709/)
})

test('WebM: VP9 + Opus, constant quality', () => {
  const a = made('webm').join(' ')
  assert.match(a, /-c:v libvpx-vp9 -crf 17 -b:v 0/)
  assert.match(a, /-c:a libopus/)
  assert.ok(!a.includes('movflags'))
})

test('a recording with no sound makes a file with no audio track, in every format', () => {
  for (const format of ['hevc', 'webm', 'gif', 'mp4', 'mkv'] as const) {
    const a = made(format, { hasAudio: false })
    assert.ok(!a.includes('-c:a'), format)
    assert.ok(!a.includes('[am'), format)
  }
})

test('GIF: capped frame rate and width, one shared palette, silent and looping', () => {
  const a = made('gif', { fps: 120 })
  const graph = a[a.indexOf('-filter_complex') + 1]
  assert.match(graph, new RegExp(`fps=${GIF_MAX_FPS},`))
  assert.match(graph, new RegExp(`min\\(${GIF_MAX_WIDTH},iw\\)`))
  assert.match(graph, /palettegen=stats_mode=diff/)
  assert.match(graph, /paletteuse=/)
  assert.ok(a.includes('-an'))
  assert.equal(a[a.indexOf('-loop') + 1], '0')
  assert.match(made('gif', { fps: 10 })[made('gif', { fps: 10 }).indexOf('-filter_complex') + 1], /fps=10,/)
})

test('screenshots: WebP is lossless, JPEG is maximum quality 4:4:4', () => {
  assert.deepEqual(buildImageConvertArgs('a.png', 'b.webp', 'webp').slice(-9), ['-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', '-quality', '100', 'b.webp'])
  const jpg = buildImageConvertArgs('a.png', 'b.jpg', 'jpeg').join(' ')
  assert.match(jpg, /-c:v mjpeg -q:v 1 -pix_fmt yuvj444p/)
})

test('the default format is first and carries no warning; every other one explains the risk', () => {
  assert.equal(VIDEO_FORMATS[0].id, DEFAULT_VIDEO_FORMAT)
  assert.equal(IMAGE_FORMATS[0].id, DEFAULT_IMAGE_FORMAT)
  assert.equal(VIDEO_FORMATS[0].notice, null)
  assert.equal(IMAGE_FORMATS[0].notice, null)
  for (const f of [...VIDEO_FORMATS.slice(1), ...IMAGE_FORMATS.slice(1)]) {
    assert.ok(f.notice && f.notice.title && f.notice.text.length > 40, `${f.id} needs a notice`)
    assert.match(f.notice!.text, /not sure|Use it only/i, `${f.id} should point back to the safe choice`)
  }
  assert.equal(new Set(VIDEO_FORMATS.map((f) => f.id)).size, VIDEO_FORMATS.length)
  assert.equal(VIDEO_FORMATS.find((f) => f.id === 'gif')!.notice!.level, 'bad')
})

test('only formats FFmpeg can really write are offered', () => {
  const all = availableFormats({ x265: true, vp9: true, opus: true, webp: true })
  assert.deepEqual(all.video, ['mp4', 'hevc', 'mkv', 'mov', 'webm', 'gif'])
  assert.deepEqual(all.image, ['png', 'webp', 'jpeg'])
  const bare = availableFormats({ x265: false, vp9: true, opus: false, webp: false })
  assert.deepEqual(bare.video, ['mp4', 'mkv', 'mov', 'gif'])
  assert.deepEqual(bare.image, ['png', 'jpeg'])
})

test('file names: unsafe characters go, the right extension is added once, duplicates get (2), (3)…', () => {
  assert.equal(sanitizeFileName('My: clip?', 'x'), 'My clip.mp4')
  assert.equal(sanitizeFileName('clip.mkv', 'x', 'mkv'), 'clip.mkv')
  assert.equal(sanitizeFileName('clip.MKV', 'x', 'mkv'), 'clip.mkv')
  assert.equal(sanitizeFileName('   ', 'Screenshot', 'png'), 'Screenshot.png')
  assert.equal(sanitizeFileName('a.b', 'x', 'png'), 'a.b.png')
  const dir = mkdtempSync(join(tmpdir(), 'names-'))
  try {
    assert.equal(uniquePath(dir, 'a.png'), join(dir, 'a.png'))
    writeFileSync(join(dir, 'a.png'), '')
    assert.equal(uniquePath(dir, 'a.png'), join(dir, 'a (2).png'))
    writeFileSync(join(dir, 'a (2).png'), '')
    assert.equal(uniquePath(dir, 'a.png'), join(dir, 'a (3).png'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('screenshot crop maps the selection onto real pixels (scaled and offset screens)', () => {
  const bounds = { x: 1920, y: 0, width: 1536, height: 864 } // a 150%-scaled 2304×1296 screen to the right of another
  const picture = { width: 2304, height: 1296 }
  assert.equal(cropBox(picture, bounds, bounds), null, 'whole screen needs no crop')
  assert.deepEqual(cropBox(picture, bounds, { x: 1920 + 100, y: 50, width: 400, height: 200 }), { x: 150, y: 75, width: 600, height: 300 })
  // never reaches outside the picture
  const edge = cropBox(picture, bounds, { x: 1920 + 1500, y: 800, width: 100, height: 100 })!
  assert.ok(edge.x + edge.width <= picture.width && edge.y + edge.height <= picture.height)
  assert.throws(() => cropBox(picture, bounds, { x: 1920 + 2000, y: 0, width: 10, height: 10 }))
})

test('PNG size is read from the header, and non-PNG bytes are rejected', () => {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(2560, 16)
  header.writeUInt32BE(1440, 20)
  assert.deepEqual(pngSize(header), { width: 2560, height: 1440 })
  assert.equal(pngSize(Buffer.from('not a png at all, definitely not one')), null)
  assert.equal(pngSize(Buffer.alloc(4)), null)
})
