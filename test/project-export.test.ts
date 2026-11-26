// Runs the real FFmpeg on the command the editor builds, with generated pictures and sound standing in for a recording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProjectArgs, type ExportMedia, type ExportPicture, type ProjectExportInput } from '../src/main/project-export.ts'
import { activeClips, audioTracks, baseVideoTrack, clipLength, detachSound, envDip, addVideoTrack, patchTrack, removeSpan, type ClipShape, newClipBase, newId, newProject, DISSOLVE, type Clip, type Overlay, type Project, type Sound } from '../src/shared/project.ts'
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

const snd = (p: Project, o: Partial<Sound> & Pick<Sound, 'media' | 'duration' | 'length'>): Sound => ({
  id: newId('s'), track: audioTracks(p)[0].id, origin: 'music', name: 'sound', offset: 0, start: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, loop: false, duck: false, ...o
})

/** Puts pieces one after another on the bottom track (what a person gets by adding them in order). */
function sequence(p: Project, clips: Clip[]): void {
  let at = 0
  p.clips = clips.map((c) => {
    const placed: Clip = { ...c, track: baseVideoTrack(p).id, start: at }
    at += clipLength(placed)
    return placed
  })
}

/** A new piece on its own: the 'video' kind, from the file with this id. */
const piece = (p: Project, media: string, len: number, extra: Partial<Clip> = {}): Clip => ({
  id: newId('c'), track: baseVideoTrack(p).id, start: 0, kind: 'video', media, name: media, in: 0, out: len, hasAudio: false, volume: 1, width: W, height: H, ...newClipBase(), ...extra
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
  sequence(s.project, [{ ...c, out: 1 }, second])
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 2) < 0.15, `${seconds(out.file)}`)
  assert.equal(execFileSync(ffmpeg, ['-v', 'error', '-i', out.file, '-f', 'null', '-']).toString(), '')
}))

test('a piece can fade in from black and out to a colour of the person\'s choice', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4)
  const plain = exportIt(dir, s)
  const normal = frame(plain.file, 2).at(300, 100)
  const c = s.project.clips[0]
  s.project.clips = [{ ...c, fadeIn: { dur: 1, color: '#000000' }, fadeOut: { dur: 1, color: '#ffffff' } }]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 4) < 0.2)
  const dark = frame(out.file, 0.05).at(300, 100)
  assert.ok(dark[0] < 40 && dark[1] < 60 && dark[2] < 40, `from black ${dark}`)
  assert.ok(near(frame(out.file, 2).at(300, 100), normal, 8), `in the middle: untouched ${frame(out.file, 2).at(300, 100)} vs ${normal}`)
  const white = frame(out.file, 3.95).at(300, 100)
  assert.ok(white[0] > 200 && white[1] > 200 && white[2] > 200, `to white ${white}`)
}))

test('a piece on a track in front covers the one behind only while it is there, and a dissolve lets the one behind show through', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4)
  const blue = makeVideo(dir, 'blue.mp4', 2, { source: 'color=c=0x2040e0' })
  s.media.blue = { path: blue, kind: 'video', hasAudio: false, duration: 2, width: W, height: H }
  const up = addVideoTrack(s.project)
  s.project = up.project
  s.project.clips = [...s.project.clips, piece(s.project, 'blue', 2, { track: up.track.id, start: 1, fadeIn: { dur: 1, color: DISSOLVE } })]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 4) < 0.2)
  assert.ok(near(frame(out.file, 0.5).at(300, 100), [0x20, 0xa0, 0x40], 16), 'before it: the recording')
  const mid = frame(out.file, 1.5).at(300, 100)
  assert.ok(mid[2] > 100 && mid[1] > 70 && mid[0] < 80, `dissolving ${mid}`)
  assert.ok(near(frame(out.file, 2.5).at(300, 100), [0x20, 0x40, 0xe0], 24), 'covering it')
  assert.ok(near(frame(out.file, 3.5).at(300, 100), [0x20, 0xa0, 0x40], 16), 'after it: the recording again')
  // a hidden track leaves nothing of its picture
  const hidden = { ...s, project: patchTrack(s.project, up.track.id, { hidden: true }) }
  assert.ok(near(frame(exportIt(dir, hidden).file, 2.5).at(300, 100), [0x20, 0xa0, 0x40], 16))
}))

test('a small piece on an upper track sits in its corner like a picture-in-picture window', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 3)
  const blue = makeVideo(dir, 'pip.mp4', 3, { source: 'color=c=0x2040e0', tone: 880 })
  s.media.pip = { path: blue, kind: 'video', hasAudio: true, duration: 3, width: W, height: H }
  const up = addVideoTrack(s.project)
  s.project = up.project
  s.project.clips = [...s.project.clips, piece(s.project, 'pip', 1.5, { track: up.track.id, start: 1, hasAudio: true, box: { x: 0.6, y: 0.1, w: 0.3 }, border: true })]
  const out = exportIt(dir, s)
  assert.ok(near(frame(out.file, 1.8).at(430, 60), [0x20, 0x40, 0xe0], 24), `${frame(out.file, 1.8).at(430, 60)}`)
  assert.ok(near(frame(out.file, 0.5).at(430, 60), [0x20, 0xa0, 0x40], 16))
  assert.ok(near(frame(out.file, 2.8).at(430, 60), [0x20, 0xa0, 0x40], 16))
  assert.ok(near(frame(out.file, 1.8).at(30, 300), [0x20, 0xa0, 0x40], 16), 'the rest of the picture is the recording')
}))

test('a piece can play faster or slower, picture and sound together', { timeout: 120000 }, inTemp((dir) => {
  // two seconds red then two seconds blue, with a 440 Hz tone
  const path = join(dir, 'twocolour.mp4')
  run(['-f', 'lavfi', '-i', 'color=c=0xe02020:s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=0x2040e0:s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]', '-map', '[v]', '-map', '2:a', '-t', '4',
    '-c:v', 'libx264', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'aac', path])
  const s: Setup = { project: newProject({ duration: 4, width: W, height: H, hasAudio: true }), media: { recording: { path, kind: 'video', hasAudio: true, duration: 4, width: W, height: H } } }
  s.project.clips[0] = { ...s.project.clips[0], speed: 2 }
  const fast = exportIt(dir, s)
  assert.ok(Math.abs(seconds(fast.file) - 2) < 0.2, `${seconds(fast.file)}`)
  assert.ok(near(frame(fast.file, 0.5).at(300, 100), [0xe0, 0x20, 0x20], 40), 'first half of the picture')
  assert.ok(near(frame(fast.file, 1.5).at(300, 100), [0x20, 0x40, 0xe0], 40), 'second half, already')
  assert.ok(Math.abs(pitch(fast.file, 0.1, 0.5) - 440) < 60, 'the voice keeps its pitch')
  s.project.clips[0] = { ...s.project.clips[0], speed: 0.5 }
  const slow = exportIt(dir, s)
  assert.ok(Math.abs(seconds(slow.file) - 8) < 0.3, `${seconds(slow.file)}`)
  assert.ok(near(frame(slow.file, 3).at(300, 100), [0xe0, 0x20, 0x20], 40), 'red lasts four seconds')
  assert.ok(near(frame(slow.file, 5).at(300, 100), [0x20, 0x40, 0xe0], 40))
}))

test('a gap on the bottom track shows black, and a muted track is silent while a hidden one is gone', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 2, { tone: 440 })
  const c = s.project.clips[0]
  s.project.clips = [{ ...c, start: 1 }]
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 3) < 0.2, `${seconds(out.file)}`)
  assert.ok(near(frame(out.file, 0.5).at(300, 100), [0, 0, 0], 24), 'black before it starts')
  assert.ok(near(frame(out.file, 2).at(300, 100), [0x20, 0xa0, 0x40], 16))
  assert.ok(loud(out.file, 1.2, 1) > -30, 'its sound is there')
  s.project = patchTrack(s.project, c.track, { muted: true })
  assert.ok(loud(exportIt(dir, s).file, 1.2, 1) < -60, 'muted: silent')
  assert.ok(near(frame(exportIt(dir, s).file, 2).at(300, 100), [0x20, 0xa0, 0x40], 16), 'muted: still shown')
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

test('a picture clip and a title card are shown for as long as asked, between recording clips', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 2)
  const card = makePng(dir, 'card.png', '0x6030c0', W, H)
  const pic = makePng(dir, 'pic.png', '0xe0c020', 300, 300)
  const rec = s.project.clips[0]
  const title: Clip = { ...rec, id: newId('c'), kind: 'image', media: 'card', name: 'Title', in: 0, out: 1.5, hasAudio: false, width: W, height: H, card: { title: 'x', subtitle: '', bg: ['#000', '#000'], color: '#fff', font: 'sans', align: 'center' } }
  const photo: Clip = { ...rec, id: newId('c'), kind: 'image', media: 'pic', name: 'pic.png', in: 0, out: 1, hasAudio: false, width: 300, height: 300 }
  sequence(s.project, [title, rec, photo])
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
    s.project.sounds = [snd(s.project, { media: 'song', name: 'song.wav', duration: 2, start: 1, length: 3, volume, fadeIn: 0.3, fadeOut: 0.3, loop: true })]
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
    s.project.sounds = [snd(s.project, { ...base, duck })]
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

/** The screen recording plus a camera clip on a track of its own in front: a 30% wide window at (0.6, 0.5), the camera file's first 4 s. */
function withCamera(dir: string, shape: ClipShape, over: Partial<Clip> = {}): Setup {
  const s = recordingSetup(dir, 4)
  s.media.camera = { path: makeCamera(dir), kind: 'video', hasAudio: false, duration: 4, width: 640, height: 480 }
  const added = addVideoTrack(s.project)
  const clip: Clip = {
    ...newClipBase(), id: newId('c'), track: added.track.id, start: 0, kind: 'video', media: 'camera', name: 'camera.mp4', in: 0, out: 4, hasAudio: false, volume: 1,
    width: 640, height: 480, shape, border: false, box: { x: 0.6, y: 0.5, w: 0.3 }, ...over
  }
  s.project = { ...added.project, clips: [...added.project.clips, clip] }
  return s
}
const cameraOf = (s: Setup): Clip => s.project.clips.find((c) => c.media === 'camera')!

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

test('cutting a stretch out of the whole timeline cuts the camera with the screen', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'square')
  // take 1–2.5 s out of everything: what was at 2.5 s (blue on the camera) now comes right after the first second
  s.project = removeSpan(s.project, 1, 2.5)
  const out = exportIt(dir, s)
  assert.ok(Math.abs(seconds(out.file) - 2.5) < 0.2)
  assert.ok(near(frame(out.file, 0.5).at(480, 276), [0xe0, 0x10, 0x10], 30), 'first piece: red')
  assert.ok(near(frame(out.file, 1.5).at(480, 276), [0x10, 0x20, 0xe0], 30), 'second piece: the camera from the same moment (blue), not red')
}))

test('the camera is a piece of its own: it can start later or earlier than the screen and shows only where it is', { timeout: 120000 }, inTemp((dir) => {
  // starts half a second into the camera file (a camera that ran ahead of the screen) …
  const early = withCamera(dir, 'square', { in: 0.5, out: 4 })
  const a = exportIt(dir, early)
  assert.ok(near(frame(a.file, 1.7).at(480, 276), [0x10, 0x20, 0xe0], 30), `at 1.7 s the camera is at 2.2 s → blue: ${frame(a.file, 1.7).at(480, 276)}`)
  // … or joins one second late: nothing before it
  const late = withCamera(dir, 'square', { start: 1, in: 0, out: 3 })
  const b = exportIt(dir, late)
  assert.ok(near(frame(b.file, 0.5).at(480, 276), [0x20, 0xa0, 0x40], 20), 'before it starts the screen shows')
  assert.ok(near(frame(b.file, 1.5).at(480, 276), [0xe0, 0x10, 0x10], 30), '0.5 s into the camera: red')
  assert.ok(near(frame(b.file, 3.5).at(480, 276), [0x10, 0x20, 0xe0], 30), '2.5 s into the camera: blue')
}))

test('a border rings the camera in white, and a hidden camera leaves no trace', { timeout: 120000 }, inTemp((dir) => {
  const bordered = exportIt(dir, withCamera(dir, 'circle', { border: true }))
  // the window is 192 + 2×6 px; its left edge ring is white at (384 + 2, 276)
  const ring = frame(bordered.file, 0.5).at(386, 276)
  assert.ok(ring[0] > 200 && ring[1] > 200 && ring[2] > 200, `ring ${ring}`)
  const hide = withCamera(dir, 'circle')
  hide.project = patchTrack(hide.project, cameraOf(hide).track, { hidden: true })
  const hidden = exportIt(dir, hide)
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
  const s = withCamera(dir, 'circle', { hasAudio: false })
  s.media.camera = { ...s.media.camera, path: makeVideo(dir, 'cam2.mp4', 4, { tone: 880 }), hasAudio: true }
  // the clip is silent for now (its sound is off): only the screen's sound is heard
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
  // now the camera is the voice: its sound is on and the screen recording keeps none of its own
  s.project = { ...s.project, clips: s.project.clips.map((c) => (c.kind === 'recording' ? { ...c, audioSource: 'none' as const } : c.media === 'camera' ? { ...c, hasAudio: true } : c)) }
  const camVoice = exportIt(dir, s)
  assert.ok(Math.abs(freq(camVoice.file) - 880) < 90, `camera pitch ${freq(camVoice.file)}`)
  assert.ok(Math.abs(seconds(camVoice.file) - 4) < 0.2)
}))

test('several sounds play together, and the sound split off a clip is its own, silent in the clip', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { tone: null })
  s.media.a = { path: makeTone(dir, 'a.wav', 1), kind: 'video', hasAudio: true, duration: 1, width: 0, height: 0 }
  s.media.b = { path: makeTone(dir, 'b.wav', 1), kind: 'video', hasAudio: true, duration: 1, width: 0, height: 0 }
  s.project.sounds = [snd(s.project, { media: 'a', duration: 1, length: 1, start: 0 }), snd(s.project, { media: 'b', duration: 1, length: 1, start: 3 })]
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

/** The dominant pitch of the first seconds of a file (zero crossings), a cheap way to tell sounds apart. */
function pitch(file: string, from = 0, len = 2): number {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const b = r.stdout
  let crossings = 0
  let prev = 0
  for (let i = 0; i + 1 < b.length; i += 2) {
    const v = b.readInt16LE(i)
    if (prev < 0 && v >= 0) crossings++
    prev = v
  }
  return crossings / len
}

function toneFile(dir: string, name: string, hz: number, secs: number): string {
  const path = join(dir, name)
  run(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000`, '-t', String(secs), '-c:a', 'aac', path])
  return path
}

/** A recording that holds the computer's sound (440 Hz) and the microphone (880 Hz) as tracks of their own, plus the mix. */
function twoTrackSetup(dir: string): Setup {
  const s = recordingSetup(dir, 4, { tone: 660 })
  s.project.recTracks = { pc: true, mic: true }
  s.media['recording-pc'] = { path: toneFile(dir, 'pc.m4a', 440, 4), kind: 'video', hasAudio: true, duration: 4, width: 0, height: 0 }
  s.media['recording-mic'] = { path: toneFile(dir, 'mic.m4a', 880, 4), kind: 'video', hasAudio: true, duration: 4, width: 0, height: 0 }
  return s
}

test('a recording can use its computer sound alone, its microphone alone, or the mix', { timeout: 120000 }, inTemp((dir) => {
  const s = twoTrackSetup(dir)
  const hz = (src: 'mix' | 'pc' | 'mic'): number => {
    s.project.clips[0].audioSource = src
    return pitch(exportIt(dir, s).file)
  }
  assert.ok(Math.abs(hz('mix') - 660) < 70, 'the mix as recorded')
  assert.ok(Math.abs(hz('pc') - 440) < 50, 'computer sound only')
  assert.ok(Math.abs(hz('mic') - 880) < 90, 'microphone only')
}))

test('using the webcam\'s voice keeps the computer sound and drops only the recorded microphone', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'circle', { hasAudio: true })
  const two = twoTrackSetup(dir)
  s.media = { ...two.media, camera: { path: makeVideo(dir, 'cam3.mp4', 4, { tone: 1320 }), kind: 'video', hasAudio: true, duration: 4, width: 640, height: 480 } }
  s.project = { ...s.project, recTracks: { pc: true, mic: true }, clips: s.project.clips.map((c) => (c.kind === 'recording' ? { ...c, audioSource: 'pc' as const } : c)) }
  const out = exportIt(dir, s)
  // both the computer's 440 Hz and the webcam's 1320 Hz are heard; the microphone's 880 Hz is not
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-t', '3', '-i', out.file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const b = r.stdout
  const n = 8000
  const power = (hz: number): number => {
    let re = 0
    let im = 0
    for (let i = 0; i < n * 2; i++) {
      const v = b.readInt16LE(i * 2) / 32768
      re += v * Math.cos((2 * Math.PI * hz * i) / n)
      im += v * Math.sin((2 * Math.PI * hz * i) / n)
    }
    return Math.hypot(re, im) / n
  }
  assert.ok(power(440) > 0.02, `computer sound present: ${power(440)}`)
  assert.ok(power(1320) > 0.02, `webcam voice present: ${power(1320)}`)
  assert.ok(power(880) < 0.005, `the recorded microphone is gone: ${power(880)}`)
}))

test('the finished video can be sped up or slowed down, sound and picture together', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 4, { tone: 440 })
  for (const [speed, want] of [[2, 2], [0.5, 8], [4, 1]] as const) {
    s.project.speed = speed
    const out = exportIt(dir, s)
    assert.ok(Math.abs(seconds(out.file) - want) < 0.35, `${speed}× → ${seconds(out.file)} s, wanted ${want}`)
    assert.ok(Math.abs(out.seconds - want) < 0.01)
    // atempo keeps the pitch the same
    assert.ok(Math.abs(pitch(out.file, 0.1, 0.5) - 440) < 60, `${speed}× pitch ${pitch(out.file, 0.1, 0.5)}`)
  }
}))

test('music dips partway through and comes back, and a clip\'s own sound can dip too', { timeout: 120000 }, inTemp((dir) => {
  const s = recordingSetup(dir, 6, { tone: null })
  s.media.song = { path: makeTone(dir, 'song.wav', 6), kind: 'video', hasAudio: true, duration: 6, width: 0, height: 0 }
  // dip to almost nothing from 2 s to about 4 s, back up by 4.4 s
  s.project.sounds = [snd(s.project, { media: 'song', name: 'song.wav', duration: 6, start: 0, length: 6, volEnv: envDip(undefined, 1.8, 1.6, 0.03, 0.2) })]
  const out = exportIt(dir, s)
  const before = loud(out.file, 0.2, 1.2)
  const during = loud(out.file, 2.3, 1.2)
  const after = loud(out.file, 4.8, 1)
  assert.ok(before > -6, `full before the dip: ${before}`)
  assert.ok(during < before - 20, `quiet in the dip: ${during} vs ${before}`)
  assert.ok(after > before - 2, `back to full afterwards: ${after} vs ${before}`)
  // the same line on a clip that has its own sound
  const t = recordingSetup(dir, 6, { tone: 440 })
  t.project.clips = t.project.clips.map((c) => ({ ...c, volEnv: envDip(undefined, 1.8, 1.6, 0.03, 0.2) }))
  const own = exportIt(dir, t)
  assert.ok(loud(own.file, 2.3, 1.2) < loud(own.file, 0.2, 1.2) - 20, 'the recording\'s own sound dips as well')
}))

test('the face camera can fade away for a stretch and come back, and its voice can dip on its own', { timeout: 120000 }, inTemp((dir) => {
  const s = withCamera(dir, 'circle', { showEnv: [{ t: 0, v: 1 }, { t: 1.2, v: 1 }, { t: 1.6, v: 0 }, { t: 2.4, v: 0 }, { t: 2.8, v: 1 }] })
  const out = exportIt(dir, s)
  assert.ok(near(frame(out.file, 0.5).at(480, 276), [0xe0, 0x10, 0x10], 30), `visible at first: ${frame(out.file, 0.5).at(480, 276)}`)
  assert.ok(near(frame(out.file, 2.0).at(480, 276), [0x20, 0xa0, 0x40], 20), `gone in the middle (the recording shows): ${frame(out.file, 2.0).at(480, 276)}`)
  assert.ok(near(frame(out.file, 3.5).at(480, 276), [0x10, 0x20, 0xe0], 30), `back at the end: ${frame(out.file, 3.5).at(480, 276)}`)
  const mid = frame(out.file, 1.4).at(480, 276)
  assert.ok(mid[0] < 0xe0 - 8 && mid[0] > 0x20 + 8, `half way through the fade it is half there: ${mid}`)
  // the voice from the camera follows its own line (in timeline seconds), not the picture's
  const v = withCamera(dir, 'circle', { hasAudio: true, volEnv: [{ t: 0, v: 1 }, { t: 1.5, v: 1 }, { t: 1.8, v: 0 }, { t: 3, v: 0 }] })
  v.media.camera = { ...v.media.camera, path: makeVideo(dir, 'cam3.mp4', 4, { tone: 880, source: 'color=c=0xe01010', size: [480, 480] }), hasAudio: true }
  v.project = { ...v.project, clips: v.project.clips.map((c) => (c.kind === 'recording' ? { ...c, audioSource: 'none' as const } : c)) }
  const voiced = exportIt(dir, v)
  assert.ok(loud(voiced.file, 0.2, 1) > -28, 'heard at first')
  assert.ok(loud(voiced.file, 2.2, 0.8) < -40, 'then silent while the line is down')
  assert.ok(near(frame(voiced.file, 1.0).at(480, 276), [0xe0, 0x10, 0x10], 40), `the picture stays while only the voice dips: ${frame(voiced.file, 1.0).at(480, 276)}`)
}))
