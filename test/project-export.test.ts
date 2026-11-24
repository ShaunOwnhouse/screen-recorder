// Runs the real FFmpeg on the command the editor builds, with generated pictures and sound standing in for a recording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProjectArgs, type ExportMedia, type ExportPicture, type ProjectExportInput } from '../src/main/project-export.ts'
import { detachSound, duplicateClip, duplicateSound, newId, newProject, splitSound, trimSound, type Clip, type Overlay, type Project, type Sound } from '../src/shared/project.ts'
import type { VideoFormat } from '../src/shared/types.ts'

const ffmpeg: string = createRequire(import.meta.url)('ffmpeg-static')
const W = 640
const H = 360
const run = (args: string[]): void => void execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })

function inTemp(fn: (dir: string) => void): () => void {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-test-'))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A BT.709 H.264 clip of one colour (or a given lavfi picture), with or without a tone. */
function makeVideo(dir: string, name: string, seconds: number, opts: { source?: string; tone?: number | null; size?: [number, number] } = {}): string {
  const [w, h] = opts.size ?? [W, H]
  const path = join(dir, name)
  // The size and rate go on the first filter of the source; the rest of the chain (if any) follows.
  const source = opts.source ?? 'color=c=0x20a040'
  const [head, ...rest] = source.split(',')
  const first = `${head}${head.includes('=') ? ':' : '='}s=${w}x${h}:r=30`
  const args = ['-f', 'lavfi', '-i', [first, ...rest, 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p'].join(',')]
  if (opts.tone !== null) args.push('-f', 'lavfi', '-i', `sine=frequency=${opts.tone ?? 440}:sample_rate=48000`)
  args.push('-t', String(seconds), '-c:v', 'libx264', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv')
  if (opts.tone !== null) args.push('-c:a', 'aac')
  run([...args, path])
  return path
}

function makePng(dir: string, name: string, color: string, w: number, h: number): string {
  const path = join(dir, name)
  run(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h},format=rgba`, '-frames:v', '1', path])
  return path
}

function makeTone(dir: string, name: string, seconds: number): string {
  const path = join(dir, name)
  run(['-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=44100,volume=7`, '-t', String(seconds), path])
  return path
}

const info = (file: string): string => spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr
function seconds(file: string): number {
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info(file))
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0
}

/** The picture at time t as RGB (the way a player shows it: BT.709, TV range). */
function frame(file: string, t: number): { at: (x: number, y: number) => [number, number, number]; data: Buffer } {
  const out = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const data = out.stdout
  return { data, at: (x, y) => [data[(y * W + x) * 3], data[(y * W + x) * 3 + 1], data[(y * W + x) * 3 + 2]] }
}

const near = (a: [number, number, number], b: [number, number, number], tol = 24): boolean => a.every((v, i) => Math.abs(v - b[i]) <= tol)

interface Setup {
  project: Project
  media: Record<string, ExportMedia>
  pictures?: Record<string, ExportPicture>
}

function exportIt(dir: string, s: Setup, extra: Partial<ProjectExportInput> = {}): { file: string; seconds: number } {
  const file = join(dir, `out.${extra.format === 'webm' ? 'webm' : extra.format === 'gif' ? 'gif' : extra.format === 'mkv' ? 'mkv' : 'mp4'}`)
  const built = buildProjectArgs({
    project: s.project, media: s.media, pictures: s.pictures ?? {}, recording: { width: W, height: H }, fps: 30, output: file,
    format: 'mp4', quality: 'maximum', encoder: 'libx264', ...extra
  })
  run(built.args.slice(4)) // run() adds its own leading options
  return { file, seconds: built.seconds }
}

function recordingSetup(dir: string, secondsLong: number, opts: Parameters<typeof makeVideo>[3] = {}): Setup {
  const path = makeVideo(dir, 'rec.mp4', secondsLong, opts)
  const project = newProject({ duration: secondsLong, width: W, height: H, hasAudio: opts.tone !== null })
  return { project, media: { recording: { path, kind: 'video', hasAudio: opts.tone !== null, duration: secondsLong, width: W, height: H } } }
}

const snd = (o: Partial<Sound> & Pick<Sound, 'media' | 'duration' | 'length'>): Sound => ({
  id: newId('s'), origin: 'music', name: 'sound', offset: 0, start: 0, volume: 1, fadeIn: 0, fadeOut: 0, loop: false, duck: false, ...o
})

const overlay = <T extends Overlay>(o: Omit<T, 'id' | 'fade'> & { fade?: boolean }): T => ({ id: newId('o'), fade: false, ...o }) as T

test('a plain recording comes out the same size and length, with its sound', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3)
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 3) < 0.15, `${seconds(out.file)}`)
  const i = info(out.file)
  assert.match(i, /640x360/)
  assert.match(i, /h264 \(High\).*yuv420p\(tv, bt709/)
  assert.match(i, /Audio: aac/)
  assert.ok(near(frame(out.file, 1).at(300, 100), [0x20, 0xa0, 0x40], 16), 'colour survives unchanged')
}))

test('cutting out the middle joins what is left with no gap', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { source: 'testsrc2' })
  const c = s.project.clips[0]
  const second: Clip = { ...c, id: newId('c'), in: 3, out: 4 }
  s.project.clips = [{ ...c, out: 1 }, second]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 2) < 0.15, `${seconds(out.file)}`)
  assert.equal(execFileSync(ffmpeg, ['-v', 'error', '-i', out.file, '-f', 'null', '-']).toString(), '')
}))

test('a fade between two clips overlaps them and blends the colours', { timeout: 120000 }, inTemp((dir) => {
  const red = makeVideo(dir, 'red.mp4', 2, { source: 'color=c=0xe02020' })
  const blue = makeVideo(dir, 'blue.mp4', 2, { source: 'color=c=0x2040e0', tone: 880 })
  const project = newProject({ duration: 2, width: W, height: H, hasAudio: true })
  const a = project.clips[0]
  const b: Clip = { ...a, id: newId('c'), media: 'blue', transition: 'fade', transitionDur: 0.6 }
  project.clips = [a, b]
  const out = exportIt(dir, {
    project,
    media: {
      recording: { path: red, kind: 'video', hasAudio: true, duration: 2, width: W, height: H },
      blue: { path: blue, kind: 'video', hasAudio: true, duration: 2, width: W, height: H }
    }
  })
  assert.ok(Math.abs(seconds(out.file) - 3.4) < 0.15, `${seconds(out.file)}`)
  const mid = frame(out.file, 1.7).at(100, 100)
  assert.ok(mid[0] > 70 && mid[2] > 70, `blended ${mid}`)
  assert.ok(near(frame(out.file, 0.5).at(100, 100), [0xe0, 0x20, 0x20]))
  assert.ok(near(frame(out.file, 3).at(100, 100), [0x20, 0x40, 0xe0]))
  assert.match(info(out.file), /Audio: aac/)
}))

test('a drawn picture appears exactly when asked, in the right place and the right colour', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3)
  const png = makePng(dir, 'box.png', '0xef4444', 200, 100)
  const o = overlay<Overlay>({ kind: 'box', start: 1, end: 2, x: 0, y: 0, w: 0, h: 0, color: '#fff', width: 2, radius: 0, fill: null } as never)
  s.project.overlays = [o]
  s.pictures = { [o.id]: { path: png, x: 100, y: 50, width: 200, height: 100 } }
  const out = exportIt(dir, s)
  assert.ok(near(frame(out.file, 1.5).at(150, 80), [0xef, 0x44, 0x44], 14), `inside ${frame(out.file, 1.5).at(150, 80)}`)
  assert.ok(near(frame(out.file, 0.5).at(150, 80), [0x20, 0xa0, 0x40], 16), 'not there before')
  assert.ok(near(frame(out.file, 2.6).at(150, 80), [0x20, 0xa0, 0x40], 16), 'gone after')
  assert.ok(near(frame(out.file, 1.5).at(50, 80), [0x20, 0xa0, 0x40], 16), 'nothing outside its box')
}))

test('fading overlays ramp in and out', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3)
  const png = makePng(dir, 'box.png', '0xffffff', 200, 100)
  const o = overlay<Overlay>({ kind: 'box', start: 1, end: 2.4, fade: true, x: 0, y: 0, w: 0, h: 0, color: '#fff', width: 2, radius: 0, fill: null } as never)
  s.project.overlays = [o]
  s.pictures = { [o.id]: { path: png, x: 100, y: 50, width: 200, height: 100 } }
  const out = exportIt(dir, s)
  const early = frame(out.file, 1.1).at(150, 80)
  const full = frame(out.file, 1.7).at(150, 80)
  assert.ok(full[0] > 230, `fully shown ${full}`)
  assert.ok(early[0] > 0x20 + 8 && early[0] < 235, `part way ${early}`)
}))

test('blur softens just its area and only while it is on', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3, { source: 'testsrc2' })
  s.project.overlays = [overlay<Overlay>({ kind: 'blur', start: 0, end: 1.5, x: 0.25, y: 0.25, w: 0.5, h: 0.5, mode: 'blur', strength: 8 } as never)]
  const out = exportIt(dir, s)
  const spread = (t: number): number => {
    const f = frame(out.file, t)
    let sum = 0
    let n = 0
    for (let y = 100; y < 250; y += 2) for (let x = 200; x < 440; x++) {
      sum += Math.abs(f.at(x, y)[1] - f.at(x + 1, y)[1])
      n++
    }
    return sum / n
  }
  assert.ok(spread(0.7) < spread(2.2) * 0.75, `${spread(0.7)} vs ${spread(2.2)}`)
}))

test('zoom glides onto an area, holds, then returns', { timeout: 180000 }, inTemp((dir) => {
  const quads = 'color=c=black,drawbox=x=0:y=0:w=320:h=180:color=0xdd2222:t=fill,drawbox=x=320:y=0:w=320:h=180:color=0x22dd22:t=fill,drawbox=x=0:y=180:w=320:h=180:color=0x2222dd:t=fill,drawbox=x=320:y=180:w=320:h=180:color=0xdddd22:t=fill'
  const s = recordingSetup(dir, 5, { source: quads })
  s.project.overlays = [overlay<Overlay>({ kind: 'zoom', start: 1, end: 4, x: 0, y: 0, w: 0.5, h: 0.5, ease: 0.5 } as never)]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 5) < 0.2, `${seconds(out.file)}`)
  assert.ok(near(frame(out.file, 0.4).at(500, 100), [0x22, 0xdd, 0x22], 30), 'before the zoom all four are visible')
  assert.ok(near(frame(out.file, 2.5).at(600, 330), [0xdd, 0x22, 0x22], 30), 'holding: the red corner fills the picture')
  assert.ok(near(frame(out.file, 2.5).at(40, 30), [0xdd, 0x22, 0x22], 30))
  assert.ok(near(frame(out.file, 4.6).at(500, 100), [0x22, 0xdd, 0x22], 30), 'after it, back to normal')
}))

test('picture-in-picture shows another video in a corner for its window', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3)
  const blue = makeVideo(dir, 'pip.mp4', 3, { source: 'color=c=0x2040e0', tone: 880 })
  s.media.pip = { path: blue, kind: 'video', hasAudio: true, duration: 3, width: W, height: H }
  s.project.overlays = [
    overlay<Overlay>({ kind: 'pip', start: 1, end: 2.5, x: 0.6, y: 0.1, w: 0.3, media: 'pip', mediaKind: 'video', name: 'pip.mp4', in: 0, sourceDuration: 3, hasAudio: true, volume: 1, width: W, height: H } as never)
  ]
  const out = exportIt(dir, s)
  assert.ok(near(frame(out.file, 1.8).at(430, 60), [0x20, 0x40, 0xe0], 24), `${frame(out.file, 1.8).at(430, 60)}`)
  assert.ok(near(frame(out.file, 0.5).at(430, 60), [0x20, 0xa0, 0x40], 16))
  assert.ok(near(frame(out.file, 2.8).at(430, 60), [0x20, 0xa0, 0x40], 16))
}))

test('a picture clip and a title card are shown for as long as asked, between recording clips', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 2)
  const card = makePng(dir, 'card.png', '0x6030c0', W, H)
  const pic = makePng(dir, 'pic.png', '0xe0c020', 300, 300)
  const rec = s.project.clips[0]
  const title: Clip = { ...rec, id: newId('c'), kind: 'image', media: 'card', name: 'Title', in: 0, out: 1.5, hasAudio: false, width: W, height: H, card: { title: 'x', subtitle: '', bg: ['#000', '#000'], color: '#fff', font: 'sans', align: 'center' } }
  const photo: Clip = { ...rec, id: newId('c'), kind: 'image', media: 'pic', name: 'pic.png', in: 0, out: 1, hasAudio: false, width: 300, height: 300 }
  s.project.clips = [title, rec, photo]
  s.media.pic = { path: pic, kind: 'image', hasAudio: false, duration: 0, width: 300, height: 300 }
  s.pictures = { [`card:${title.id}`]: { path: card, x: 0, y: 0, width: W, height: H } }
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 4.5) < 0.2, `${seconds(out.file)}`)
  assert.ok(near(frame(out.file, 0.7).at(300, 100), [0x60, 0x30, 0xc0], 20), 'title card first')
  assert.ok(near(frame(out.file, 2.5).at(300, 100), [0x20, 0xa0, 0x40], 16), 'then the recording')
  assert.ok(near(frame(out.file, 4.1).at(320, 180), [0xe0, 0xc0, 0x20], 24), 'then the picture, centred')
  assert.ok(near(frame(out.file, 4.1).at(10, 180), [0, 0, 0], 24), 'with black bars either side of it')
  assert.match(info(out.file), /Audio: aac/, 'the silent clips are padded so the sound stays in step')
}))

test('music is mixed in at the chosen level with fades, even over a silent video', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { tone: null })
  s.media.song = { path: makeTone(dir, 'song.wav', 2), kind: 'video', hasAudio: true, duration: 2, width: 0, height: 0 }
  const make = (volume: number): string => {
    s.project.sounds = [snd({ media: 'song', name: 'song.wav', duration: 2, start: 1, length: 3, volume, fadeIn: 0.3, fadeOut: 0.3, loop: true })]
    return exportIt(dir, s).file
  }
  const peak = (file: string, from: number, len: number): number => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr)
    return m ? Number(m[1]) : -Infinity
  }
  const full = make(1)
  assert.ok(Math.abs(seconds(full) - 4) < 0.2, `${seconds(full)}`)
  assert.match(info(full), /Audio: aac/)
  const fullPeak = peak(full, 1.8, 1)
  assert.ok(peak(full, 0, 0.8) < -60, 'silent before the music starts')
  assert.ok(fullPeak > -4, `full volume: ${fullPeak}`)
  assert.ok(peak(full, 3.9, 0.1) < fullPeak - 6, 'the loop keeps going to the end and fades out')
  const half = make(0.5)
  assert.ok(Math.abs(peak(half, 1.8, 1) - (fullPeak - 6)) < 1.5, `half volume is about 6 dB lower: ${peak(half, 1.8, 1)} vs ${fullPeak}`)
}))

test('music steps back under a voice when asked to', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3, { tone: 300 })
  s.media.song = { path: makeTone(dir, 'song.wav', 3), kind: 'video', hasAudio: true, duration: 3, width: 0, height: 0 }
  const base = { media: 'song', name: 'song.wav', duration: 3, start: 0, length: 3, volume: 1 }
  const level = (duck: boolean): number => {
    s.project.sounds = [snd({ ...base, duck })]
    const out = exportIt(dir, s)
    const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', '1', '-i', out.file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? -99)
  }
  assert.ok(level(true) < level(false) - 1.5, 'quieter overall with ducking on')
}))

for (const [format, ext] of [['mkv', 'mkv'], ['webm', 'webm'], ['gif', 'gif'], ['hevc', 'mp4']] as Array<[VideoFormat, string]>) {
  test(`the same project can be saved as ${format}`, { timeout: 180000 }, inTemp((dir) => {
    const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout
    if ((format === 'hevc' && !/libx265/.test(encoders)) || (format === 'webm' && !/libvpx-vp9/.test(encoders))) return
    const s = recordingSetup(dir, 2)
    const png = makePng(dir, 'box.png', '0xef4444', 100, 60)
    const o = overlay<Overlay>({ kind: 'box', start: 0.5, end: 1.5, x: 0, y: 0, w: 0, h: 0, color: '#fff', width: 2, radius: 0, fill: null } as never)
    s.project.overlays = [o]
    s.pictures = { [o.id]: { path: png, x: 10, y: 10, width: 100, height: 60 } }
    const out = exportIt(dir, s, { format })
    assert.ok(out.file.endsWith(ext))
    assert.ok(Math.abs(seconds(out.file) - 2) < 0.3, `${seconds(out.file)}`)
    assert.equal(execFileSync(ffmpeg, ['-v', 'error', '-i', out.file, '-f', 'null', '-']).toString(), '')
  }))
}

test('studio quality keeps full 4:4:4 colour through pictures and cuts', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 2)
  const png = makePng(dir, 'box.png', '0xef4444', 100, 60)
  const o = overlay<Overlay>({ kind: 'box', start: 0.5, end: 1.5, x: 0, y: 0, w: 0, h: 0, color: '#fff', width: 2, radius: 0, fill: null } as never)
  s.project.overlays = [o]
  s.pictures = { [o.id]: { path: png, x: 10, y: 10, width: 100, height: 60 } }
  const out = exportIt(dir, s, { quality: 'studio' })
  assert.match(info(out.file), /yuv444p/)
  assert.match(info(out.file), /Audio: alac/)
}))

test('a crop makes the finished video that size, and everything else lines up with it', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 2, { source: 'testsrc2' })
  s.project.crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  const built = buildProjectArgs({
    project: s.project, media: s.media, pictures: {}, recording: { width: W, height: H }, fps: 30, output: join(dir, 'c.mp4'),
    format: 'mp4', quality: 'maximum', encoder: 'libx264'
  })
  assert.equal(built.width, 320)
  assert.equal(built.height, 180)
  run(built.args.slice(4))
  assert.match(info(join(dir, 'c.mp4')), /320x180/)
}))

// ---- the face camera ----

/** A camera file that is red for its first 2 s and blue for the next 2 s. */
function makeCamera(dir: string): string {
  const path = join(dir, 'camera.mp4')
  run(['-f', 'lavfi', '-i', 'color=c=0xe01010:s=640x480:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=0x1020e0:s=640x480:r=30:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]', '-map', '[v]',
    '-c:v', 'libx264', '-colorspace', 'bt709', '-color_range', 'tv', path])
  return path
}

function withCamera(dir: string, shape: 'circle' | 'rounded' | 'square', over: Partial<NonNullable<Project['camera']>> = {}): Setup {
  const s = recordingSetup(dir, 4)
  s.media.camera = { path: makeCamera(dir), kind: 'video', hasAudio: false, duration: 4, width: 640, height: 480 }
  s.project.camera = {
    media: 'camera', name: 'camera.mp4', duration: 4, width: 640, height: 480, offset: 0, nudge: 0, x: 0.6, y: 0.5, w: 0.3, shape, border: false, fade: false,
    visible: true, hasAudio: false, audio: false, volume: 1, ...over
  }
  return s
}

test('the face camera sits in its corner, round, and is not square', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'circle')
  const out = exportIt(dir, s)
  // 0.3 of 640 = 192 px window at (384, 180): centre (480, 276)
  assert.ok(near(frame(out.file, 0.5).at(480, 276), [0xe0, 0x10, 0x10], 30), `centre ${frame(out.file, 0.5).at(480, 276)}`)
  assert.ok(near(frame(out.file, 0.5).at(388, 184), [0x20, 0xa0, 0x40], 30), 'the corner of its square is the recording, so the window is round')
  assert.ok(near(frame(out.file, 0.5).at(100, 100), [0x20, 0xa0, 0x40], 20), 'nothing elsewhere')
}))

test('the camera shows the matching moment (red first, blue after 2 s) and keeps its place', { timeout: 120000 }, inTemp((dir) => {
  const out = exportIt(dir, withCamera(dir, 'square'))
  assert.ok(near(frame(out.file, 1).at(480, 276), [0xe0, 0x10, 0x10], 30))
  assert.ok(near(frame(out.file, 3).at(480, 276), [0x10, 0x20, 0xe0], 30))
}))

test('cutting the recording cuts the camera with it', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'square')
  const c = s.project.clips[0]
  // keep 0–1 s and 2.5–4 s of the recording: the second piece starts at timeline 1 s and should show camera time 2.5 s (blue)
  s.project.clips = [{ ...c, out: 1 }, { ...c, id: newId('c'), in: 2.5, out: 4 }]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 2.5) < 0.2)
  assert.ok(near(frame(out.file, 0.5).at(480, 276), [0xe0, 0x10, 0x10], 30), 'first piece: red')
  assert.ok(near(frame(out.file, 1.5).at(480, 276), [0x10, 0x20, 0xe0], 30), 'second piece: the camera from the same moment (blue), not red')
}))

test('the camera is not shown over added pictures, and the lip-sync nudge moves it earlier', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'square', { nudge: 0.5 })
  const pic = makePng(dir, 'pic.png', '0x808080', 300, 300)
  s.media.pic = { path: pic, kind: 'image', hasAudio: false, duration: 0, width: 300, height: 300 }
  const rec = s.project.clips[0]
  s.project.clips = [{ ...rec, out: 2 }, { ...rec, id: newId('c'), kind: 'image', media: 'pic', name: 'pic', in: 0, out: 1, hasAudio: false, width: 300, height: 300 }]
  const out = exportIt(dir, s)
  // nudge 0.5: at timeline 1.7 the camera is at 2.2 s → already blue
  assert.ok(near(frame(out.file, 1.7).at(480, 276), [0x10, 0x20, 0xe0], 30), `nudged ${frame(out.file, 1.7).at(480, 276)}`)
  // over the picture (2–3 s) the camera is gone
  assert.ok(!near(frame(out.file, 2.5).at(480, 276), [0x10, 0x20, 0xe0], 40) && !near(frame(out.file, 2.5).at(480, 276), [0xe0, 0x10, 0x10], 40))
}))

test('a border rings the camera in white, and a hidden camera leaves no trace', { timeout: 120000 }, inTemp((dir) => {
  const bordered = exportIt(dir, withCamera(dir, 'circle', { border: true }))
  // the window is 192 + 2×6 px; its left edge ring is white at (384 + 2, 276)
  const ring = frame(bordered.file, 0.5).at(386, 276)
  assert.ok(ring[0] > 200 && ring[1] > 200 && ring[2] > 200, `ring ${ring}`)
  const hidden = exportIt(dir, withCamera(dir, 'circle', { visible: false }))
  assert.ok(near(frame(hidden.file, 0.5).at(480, 276), [0x20, 0xa0, 0x40], 20))
}))

test('a rounded camera has soft corners and a square one fills its box', { timeout: 120000 }, inTemp((dir) => {
  const r = exportIt(dir, withCamera(dir, 'rounded'))
  assert.ok(near(frame(r.file, 0.5).at(386, 182), [0x20, 0xa0, 0x40], 30), 'the very corner is cut away')
  assert.ok(near(frame(r.file, 0.5).at(480, 190), [0xe0, 0x10, 0x10], 30), 'but the middle of an edge is camera')
  const sq = exportIt(dir, withCamera(dir, 'square'))
  assert.ok(near(frame(sq.file, 0.5).at(387, 183), [0xe0, 0x10, 0x10], 30), 'a square one fills right to the corner')
}))

/** Loudness of a stretch of a file, in dB (the max). */
function loud(file: string, from: number, len: number): number {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr)
  return m ? Number(m[1]) : -Infinity
}

test('the camera\'s own voice replaces the screen recording\'s sound and stays with its picture', { timeout: 120000 }, inTemp((dir) => {
  // the screen recording has a loud tone; the camera has a different, shorter-lived one
  const s = withCamera(dir, 'circle', { hasAudio: true, audio: false })
  s.media.camera = { ...s.media.camera, path: makeVideo(dir, 'cam2.mp4', 4, { tone: 880 }), hasAudio: true }
  const screenOnly = exportIt(dir, s)
  assert.ok(loud(screenOnly.file, 0.5, 2) > -30, 'the screen sound is heard')
  const freq = (file: string): number => {
    // zero crossings per second of the first two seconds, a cheap pitch check
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-t', '2', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 })
    const b = r.stdout
    let crossings = 0
    let prev = 0
    for (let i = 0; i + 1 < b.length; i += 2) {
      const v = b.readInt16LE(i)
      if (prev < 0 && v >= 0) crossings++
      prev = v
    }
    return crossings / 2
  }
  assert.ok(Math.abs(freq(screenOnly.file) - 440) < 60, `screen pitch ${freq(screenOnly.file)}`)
  s.project.camera!.audio = true
  const camVoice = exportIt(dir, s)
  assert.ok(Math.abs(freq(camVoice.file) - 880) < 90, `camera pitch ${freq(camVoice.file)}`)
  assert.ok(Math.abs(seconds(camVoice.file) - 4) < 0.2)
}))

test('several sounds play together, and the sound split off a clip is its own, silent in the clip', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { tone: null })
  s.media.a = { path: makeTone(dir, 'a.wav', 1), kind: 'video', hasAudio: true, duration: 1, width: 0, height: 0 }
  s.media.b = { path: makeTone(dir, 'b.wav', 1), kind: 'video', hasAudio: true, duration: 1, width: 0, height: 0 }
  s.project.sounds = [snd({ media: 'a', duration: 1, length: 1, start: 0 }), snd({ media: 'b', duration: 1, length: 1, start: 3 })]
  const out = exportIt(dir, s)
  assert.ok(loud(out.file, 0.1, 0.8) > -6, 'the first sound plays at the start')
  assert.ok(loud(out.file, 1.5, 1) < -60, 'silence between them')
  assert.ok(loud(out.file, 3.1, 0.8) > -6, 'the second sound plays at 3 s')
}))

test('separating a clip\'s sound mutes the clip and the sound plays from the same place', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { tone: 440 })
  const clipId = s.project.clips[0].id
  const r = detachSound(s.project, clipId)!
  assert.equal(r.sound.media, 'recording')
  assert.equal(r.project.clips[0].hasAudio, false)
  s.project = r.project
  const out = exportIt(dir, s)
  assert.ok(loud(out.file, 0.5, 2) > -30, 'the separated sound is still heard once')
  // turn it down: gone from the result, though the clip itself has no sound
  s.project = { ...s.project, sounds: [{ ...s.project.sounds[0], volume: 0 }] }
  assert.ok(loud(exportIt(dir, s).file, 0.5, 2) < -60, 'turning the separate sound down silences the video')
}))

test('sounds and clips can be split, trimmed and duplicated', () => {
  const p = newProject({ duration: 10, width: W, height: H, hasAudio: true })
  const song = snd({ media: 'x', duration: 20, length: 10, start: 2 })
  const withSong: Project = { ...p, sounds: [song] }
  const split = splitSound(withSong, song.id, 6)!
  assert.equal(split.project.sounds.length, 2)
  assert.equal(split.project.sounds[0].length, 4)
  assert.equal(split.project.sounds[1].start, 6)
  assert.equal(split.project.sounds[1].offset, 4, 'the second half carries on where the first stopped')
  assert.equal(splitSound(withSong, song.id, 2.05), null, 'not right at an edge')
  const trimmedEnd = trimSound(withSong, song.id, 'end', 5)!.sounds[0]
  assert.equal(trimmedEnd.length, 3)
  const trimmedStart = trimSound(withSong, song.id, 'start', 4)!.sounds[0]
  assert.equal(trimmedStart.start, 4)
  assert.equal(trimmedStart.offset, 2)
  assert.equal(trimmedStart.length, 8)
  const dup = duplicateSound(withSong, song.id)!
  assert.equal(dup.project.sounds.length, 2)
  assert.equal(dup.project.sounds[1].start, 12)
  const clipCopy = duplicateClip(p, p.clips[0].id)!
  assert.equal(clipCopy.project.clips.length, 2)
  assert.notEqual(clipCopy.project.clips[1].id, p.clips[0].id)
})
