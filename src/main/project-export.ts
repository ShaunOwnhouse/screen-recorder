import type { Quality, Rect, VideoFormat } from '../shared/types.ts'
import {
  clipLength, FADE_SECONDS, zoomTarget, zoomWeight, type BlurOverlay, type Clip, type Overlay, type PipOverlay, type Project, type ZoomOverlay
} from '../shared/project.ts'
import {
  audioEncodeArgs, AUDIO_RATE, COLOR_TAGS, effectiveEncoder, encoderArgs, even, GIF_MAX_FPS, GIF_MAX_WIDTH, is444, pixelFormatFor, SWS_FLAGS
} from './args.ts'

/** A file the project uses: the recording, or something the person added. */
export interface ExportMedia {
  path: string
  kind: 'video' | 'image'
  hasAudio: boolean
  duration: number
  width: number
  height: number
}

/** A picture drawn by the editor (a comment, an arrow, a title card…) and where it goes, in output pixels. */
export interface ExportPicture {
  path: string
  x: number
  y: number
  width: number
  height: number
}

export interface ProjectExportInput {
  project: Project
  /** 'recording' plus every file the person added, by id. */
  media: Record<string, ExportMedia>
  /** Drawn overlays by overlay id; title cards by `card:<clip id>`. */
  pictures: Record<string, ExportPicture>
  /** The recording's own size, which the crop is relative to. */
  recording: { width: number; height: number }
  fps: number
  output: string
  format: VideoFormat
  quality: Quality
  encoder: string
  basicTuning?: boolean
}

export interface ProjectExport {
  args: string[]
  /** Length of the finished video, for the progress bar. */
  seconds: number
  /** Size of the finished video. */
  width: number
  height: number
}

const num = (n: number): string => (Math.round(n * 10000) / 10000).toString()
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The crop in whole, even source pixels (null = whole frame). */
function cropPixels(crop: Rect | null, w: number, h: number): Rect | null {
  if (!crop) return null
  const off = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)
  const x = off(Math.round(crop.x * w))
  const y = off(Math.round(crop.y * h))
  const cw = Math.min(even(Math.round(crop.width * w)), even(w - x))
  const ch = Math.min(even(Math.round(crop.height * h)), even(h - y))
  if (cw >= even(w) && ch >= even(h)) return null
  return { x, y, width: cw, height: ch }
}

/** The size of the finished video: the recording (cropped, if asked), made even. */
export function exportSize(recording: { width: number; height: number }, crop: Rect | null): { width: number; height: number } {
  const c = cropPixels(crop, recording.width, recording.height)
  return c ? { width: c.width, height: c.height } : { width: even(recording.width), height: even(recording.height) }
}

/** FFmpeg expression for how far (0–1) a zoom has glided in at the time held in `t`. Same maths as `zoomWeight`. */
function zoomWeightExpr(z: ZoomOverlay, t: string): string {
  const ease = Math.max(0.05, Math.min(z.ease, (z.end - z.start) / 2))
  const sm = (p: string): string => `(${p})*(${p})*(3-2*(${p}))`
  const a = `clip((${t}-${num(z.start)})/${num(ease)},0,1)`
  const b = `clip((${num(z.end)}-${t})/${num(ease)},0,1)`
  return `((${sm(a)})*(${sm(b)}))`
}

/** zoompan x, y and z for a set of zooms, evaluated at `on / fps + offset` seconds. Same maths as `zoomState`. */
function zoomExpressions(zooms: ZoomOverlay[], fps: number, offset: number): { z: string; x: string; y: string } {
  const t = `(${num(offset)}+on/${fps})`
  let z = '1'
  let cx = '0.5'
  let cy = '0.5'
  for (const o of zooms) {
    const w = zoomWeightExpr(o, t)
    const tg = zoomTarget(o)
    z += `+(${num(tg.z - 1)})*${w}`
    cx += `+(${num(tg.cx - 0.5)})*${w}`
    cy += `+(${num(tg.cy - 0.5)})*${w}`
  }
  return {
    z: `'${z}'`,
    x: `'clip((${cx})*iw-iw/zoom/2,0,iw-iw/zoom)'`,
    y: `'clip((${cy})*ih-ih/zoom/2,0,ih-ih/zoom)'`
  }
}

class Graph {
  readonly inputs: string[] = []
  readonly lines: string[] = []
  private inputCount = 0
  private labels = 0

  /** Adds `-i path` with the given options in front of it. */
  file(options: string[], path: string): number {
    this.inputs.push(...options, '-i', path)
    return this.inputCount++
  }

  label(prefix: string): string {
    return `${prefix}${this.labels++}`
  }

  add(line: string): void {
    this.lines.push(line)
  }
}

/**
 * Turns a project into one FFmpeg command: every clip is cut to length and joined (with cross-fades where asked), then
 * blur, zoom, picture-in-picture and the editor's drawn pictures go on top, and the music is mixed in.
 */
export function buildProjectArgs(o: ProjectExportInput): ProjectExport {
  const { project: p } = o
  const fps = Math.max(1, Math.round(o.fps))
  const frames = (s: number): number => Math.max(1, Math.round(s * fps))
  const sec = (f: number): number => f / fps
  const crop = cropPixels(p.crop, o.recording.width, o.recording.height)
  const out = exportSize(o.recording, p.crop)
  const W = out.width
  const H = out.height
  const encoder = effectiveEncoder(o.encoder, o.quality)
  const wide = o.format === 'mp4' || o.format === 'mkv' || o.format === 'mov' ? is444(o.quality) : false
  const wf = wide ? 'yuv444p' : 'yuv420p'
  const alphaFormat = wide ? 'yuva444p' : 'yuva420p'
  const overlayFormat = wide ? 'yuv444' : 'yuv420'
  const g = new Graph()

  // ---- where every clip sits, in whole frames ----
  const lens = p.clips.map((c) => frames(clipLength(c)))
  const overlaps = p.clips.map((c, i) =>
    i > 0 && c.transition === 'fade' ? clamp(Math.round(c.transitionDur * fps), 1, Math.floor(Math.min(lens[i], lens[i - 1]) / 2)) : 0
  )
  const starts: number[] = []
  let cursor = 0
  p.clips.forEach((_, i) => {
    starts.push(Math.max(0, cursor - overlaps[i]))
    cursor = starts[i] + lens[i]
  })
  const totalFrames = Math.max(1, cursor)
  const T = sec(totalFrames)

  const mediaOf = (id: string): ExportMedia => {
    const m = o.media[id]
    if (!m) throw new Error(`A file used in this video is missing (${id}).`)
    return m
  }

  // ---- video: each clip cut to length and made the same size, rate and colour ----
  const scaleTo = (sw: number, sh: number, matrix = true): string => {
    const colour = matrix ? ':out_color_matrix=bt709:out_range=tv' : ''
    if (sw === W && sh === H) return `scale=${SWS_FLAGS}${colour}`
    return (
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:${SWS_FLAGS}${colour},` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
    )
  }
  const clipInput: number[] = []
  const clipVideo = (c: Clip, i: number): string => {
    const n = lens[i]
    const len = sec(n)
    let idx: number
    let sw: number
    let sh: number
    const filters: string[] = []
    if (c.kind === 'image') {
      const path = c.card ? o.pictures[`card:${c.id}`]?.path : mediaOf(c.media).path
      if (!path) throw new Error('A title card picture is missing.')
      idx = g.file(['-loop', '1', '-framerate', String(fps), '-t', num(len)], path)
      sw = c.card ? W : c.width
      sh = c.card ? H : c.height
      filters.push('setpts=PTS-STARTPTS')
    } else {
      const m = mediaOf(c.media)
      const opts = c.in > 0.001 ? ['-ss', num(c.in), '-t', num(len + 0.5)] : ['-t', num(len + 0.5)]
      idx = g.file(opts, m.path)
      filters.push('setpts=PTS-STARTPTS', `fps=${fps}`)
      if (c.kind === 'recording' && crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
      sw = c.kind === 'recording' ? (crop?.width ?? even(o.recording.width)) : c.width
      sh = c.kind === 'recording' ? (crop?.height ?? even(o.recording.height)) : c.height
      // A source that ends a hair early is held on its last frame rather than throwing every later clip out of step.
      filters.push('tpad=stop_mode=clone:stop_duration=1')
    }
    clipInput[i] = idx
    filters.push(scaleTo(sw, sh), 'setsar=1', `format=${wf}`, `trim=end_frame=${n}`, 'setpts=PTS-STARTPTS', 'settb=AVTB')
    const label = g.label('v')
    g.add(`[${idx}:v]${filters.join(',')}[${label}]`)
    return label
  }

  const videoLabels = p.clips.map(clipVideo)
  let vAcc = videoLabels[0]
  let accFrames = lens[0]
  for (let i = 1; i < p.clips.length; i++) {
    const next = g.label('vj')
    if (overlaps[i] > 0) {
      g.add(`[${vAcc}][${videoLabels[i]}]xfade=transition=fade:duration=${num(sec(overlaps[i]))}:offset=${num(sec(accFrames - overlaps[i]))}[${next}]`)
      accFrames += lens[i] - overlaps[i]
    } else {
      g.add(`[${vAcc}][${videoLabels[i]}]concat=n=2:v=1:a=0[${next}]`)
      accFrames += lens[i]
    }
    vAcc = next
  }
  let video = vAcc

  // ---- blur / pixelate: part of the picture, so it goes under everything else ----
  const evenPx = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
  const window = (a: Overlay): string => `enable='between(t,${num(a.start)},${num(a.end)})'`
  for (const b of p.overlays.filter((x): x is BlurOverlay => x.kind === 'blur')) {
    const x = clamp(Math.floor((b.x * W) / 2) * 2, 0, W - 2)
    const y = clamp(Math.floor((b.y * H) / 2) * 2, 0, H - 2)
    const w = evenPx(Math.min(b.w * W, W - x))
    const h = evenPx(Math.min(b.h * H, H - y))
    const s = clamp(Math.round(b.strength), 1, 10)
    const effect =
      b.mode === 'pixelate'
        ? `scale=${Math.max(2, Math.round(w / (s * 4)))}:${Math.max(2, Math.round(h / (s * 4)))}:flags=bilinear,scale=${w}:${h}:flags=neighbor`
        : `boxblur=luma_radius=${Math.max(1, Math.min(s * 4, Math.floor(Math.min(w, h) / 4)))}:luma_power=3:chroma_radius=${Math.max(1, Math.min(s * 2, Math.floor(Math.min(w, h) / 8)))}:chroma_power=3`
    const a = g.label('b')
    const c = g.label('b')
    const bl = g.label('bl')
    const nv = g.label('vb')
    g.add(`[${video}]split[${a}][${c}]`)
    g.add(`[${c}]crop=${w}:${h}:${x}:${y},${effect}[${bl}]`)
    g.add(`[${a}][${bl}]overlay=${x}:${y}:format=${overlayFormat}:${window(b)}[${nv}]`)
    video = nv
  }

  // ---- zoom: glides in on an area, holds, glides back out ----
  const zooms = p.overlays.filter((x): x is ZoomOverlay => x.kind === 'zoom')
  if (zooms.length) {
    const first = clamp(Math.floor(Math.min(...zooms.map((z) => z.start)) * fps), 0, totalFrames - 1)
    const last = clamp(Math.ceil(Math.max(...zooms.map((z) => z.end)) * fps), first + 1, totalFrames)
    const ex = zoomExpressions(zooms, fps, sec(first))
    const zoomed = (label: string): string => {
      const outL = g.label('z')
      g.add(`[${label}]zoompan=z=${ex.z}:x=${ex.x}:y=${ex.y}:d=1:s=${W}x${H}:fps=${fps},setsar=1,format=${wf},settb=AVTB[${outL}]`)
      return outL
    }
    if (first === 0 && last === totalFrames) video = zoomed(video)
    else {
      const parts: string[] = []
      const cuts: Array<[number, number | null, boolean]> = []
      if (first > 0) cuts.push([0, first, false])
      cuts.push([first, last, true])
      if (last < totalFrames) cuts.push([last, null, false])
      const tags = cuts.map(() => g.label('s'))
      g.add(`[${video}]split=${cuts.length}${tags.map((t) => `[${t}]`).join('')}`)
      cuts.forEach(([a, b, zoom], i) => {
        const piece = g.label('p')
        g.add(`[${tags[i]}]trim=start_frame=${a}${b === null ? '' : `:end_frame=${b}`},setpts=PTS-STARTPTS[${piece}]`)
        parts.push(zoom ? zoomed(piece) : piece)
      })
      const joined = g.label('vz')
      g.add(`${parts.map((x) => `[${x}]`).join('')}concat=n=${parts.length}:v=1:a=0,settb=AVTB[${joined}]`)
      video = joined
    }
  }

  // ---- picture-in-picture, then the editor's drawn pictures, in the order they were added ----
  const audioParts: string[] = []
  const fade = (a: Overlay, len: number): string => {
    if (!a.fade) return ''
    const d = Math.min(FADE_SECONDS, len / 2)
    return d > 0.02 ? `,fade=t=in:st=0:d=${num(d)}:alpha=1,fade=t=out:st=${num(len - d)}:d=${num(d)}:alpha=1` : ''
  }
  const place = (stream: string, a: Overlay, x: number, y: number): void => {
    const nv = g.label('vo')
    g.add(`[${video}][${stream}]overlay=${x}:${y}:eof_action=pass:format=${overlayFormat}:${window(a)}[${nv}]`)
    video = nv
  }
  // picture-in-picture windows sit on top of everything drawn (the editor's preview does the same)
  for (const a of [...p.overlays.filter((x) => x.kind !== 'pip'), ...p.overlays.filter((x) => x.kind === 'pip')]) {
    const start = clamp(a.start, 0, T)
    const end = clamp(a.end, start, T)
    if (end - start < 0.05) continue
    if (a.kind === 'pip') {
      const m = mediaOf(a.media)
      const pw = evenPx(a.w * W)
      const ph = evenPx((pw * (a.height || m.height || 9)) / (a.width || m.width || 16))
      const len = m.kind === 'image' ? end - start : Math.min(end - start, Math.max(0.1, m.duration - a.in))
      const idx =
        m.kind === 'image'
          ? g.file(['-loop', '1', '-framerate', String(fps), '-t', num(len)], m.path)
          : g.file(['-ss', num(a.in), '-t', num(len)], m.path)
      const label = g.label('pv')
      g.add(
        `[${idx}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${pw}:${ph}:${SWS_FLAGS}:out_color_matrix=bt709:out_range=tv,setsar=1,` +
          `pad=${pw + 8}:${ph + 8}:4:4:color=white,format=${alphaFormat}${fade(a, len)},setpts=PTS+${num(start)}/TB[${label}]`
      )
      place(label, a, clamp(Math.round(a.x * W), 0, W - pw - 8), clamp(Math.round(a.y * H), 0, H - ph - 8))
      if (m.hasAudio && m.kind === 'video') {
        const al = g.label('pa')
        g.add(
          `[${idx}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,` +
            `volume=${num(clamp((a as PipOverlay).volume, 0, 2))},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[${al}]`
        )
        audioParts.push(al)
      }
      continue
    }
    const pic = o.pictures[a.id]
    if (!pic) continue
    const len = end - start
    const idx = g.file(['-loop', '1', '-framerate', String(fps), '-t', num(len)], pic.path)
    const label = g.label('pc')
    g.add(
      `[${idx}:v]format=rgba${fade(a, len)},scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=${alphaFormat},setpts=PTS+${num(start)}/TB[${label}]`
    )
    place(label, a, pic.x, pic.y)
  }

  // ---- sound: each clip's own, then picture-in-picture sound, then music ----
  const clipHasSound = (c: Clip): boolean => c.kind !== 'image' && c.hasAudio && mediaOf(c.media).hasAudio
  const music = p.music && o.media[p.music.media] ? p.music : null
  const anySound = o.format !== 'gif' && (p.clips.some(clipHasSound) || audioParts.length > 0 || !!music)
  let audio: string | null = null
  if (anySound) {
    const clipAudio = p.clips.map((c, i) => {
      const len = sec(lens[i])
      const label = g.label('a')
      if (clipHasSound(c)) {
        const idx = clipInput[i]
        g.add(
          `[${idx}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${num(clamp(c.volume, 0, 2))},` +
            `apad=whole_dur=${num(len)},atrim=duration=${num(len)},asetpts=PTS-STARTPTS[${label}]`
        )
      } else {
        g.add(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${num(len)},asetpts=PTS-STARTPTS[${label}]`)
      }
      return label
    })
    let aAcc = clipAudio[0]
    for (let i = 1; i < clipAudio.length; i++) {
      const next = g.label('aj')
      if (overlaps[i] > 0) g.add(`[${aAcc}][${clipAudio[i]}]acrossfade=d=${num(sec(overlaps[i]))}:c1=tri:c2=tri[${next}]`)
      else g.add(`[${aAcc}][${clipAudio[i]}]concat=n=2:v=0:a=1[${next}]`)
      aAcc = next
    }
    let voice = aAcc
    const mixIn: string[] = []
    if (music) {
      const room = Math.max(0.1, T - music.start)
      const len = music.loop ? room : Math.min(room, Math.max(0.1, music.duration - music.offset))
      const idx = music.loop
        ? g.file(['-stream_loop', '-1', '-t', num(len)], o.media[music.media].path)
        : g.file(['-ss', num(music.offset), '-t', num(len)], o.media[music.media].path)
      const fi = clamp(music.fadeIn, 0, len / 2)
      const fo = clamp(music.fadeOut, 0, len / 2)
      const ml = g.label('m')
      g.add(
        `[${idx}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=duration=${num(len)},` +
          `volume=${num(clamp(music.volume, 0, 1))}` +
          (fi > 0.02 ? `,afade=t=in:st=0:d=${num(fi)}` : '') +
          (fo > 0.02 ? `,afade=t=out:st=${num(len - fo)}:d=${num(fo)}` : '') +
          `,adelay=${Math.round(music.start * 1000)}|${Math.round(music.start * 1000)}[${ml}]`
      )
      let bed = ml
      if (music.duck && p.clips.some(clipHasSound)) {
        // Whenever the video has sound (a voice), the music steps back until it stops.
        const v1 = g.label('d')
        const v2 = g.label('d')
        const ducked = g.label('md')
        g.add(`[${voice}]asplit[${v1}][${v2}]`)
        g.add(`[${bed}][${v2}]sidechaincompress=threshold=0.02:ratio=8:attack=30:release=500:makeup=1[${ducked}]`)
        voice = v1
        bed = ducked
      }
      mixIn.push(bed)
    }
    mixIn.push(...audioParts)
    audio = g.label('am')
    if (mixIn.length) {
      g.add(`[${voice}]${mixIn.map((x) => `[${x}]`).join('')}amix=inputs=${mixIn.length + 1}:duration=first:normalize=0,alimiter=limit=0.95,apad=whole_dur=${num(T)},atrim=duration=${num(T)}[${audio}]`)
    } else {
      g.add(`[${voice}]apad=whole_dur=${num(T)},atrim=duration=${num(T)}[${audio}]`)
    }
  }

  // ---- the last steps depend on the format being made ----
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', ...g.inputs]
  let finalVideo: string
  if (o.format === 'gif') {
    const gifFps = Math.min(GIF_MAX_FPS, Math.max(1, fps))
    const a = g.label('ga')
    const b = g.label('gb')
    const pal = g.label('gp')
    finalVideo = g.label('gv')
    g.add(`[${video}]fps=${gifFps},scale='min(${GIF_MAX_WIDTH},iw)':-2:flags=lanczos,split[${a}][${b}]`)
    g.add(`[${a}]palettegen=stats_mode=diff[${pal}]`)
    g.add(`[${b}][${pal}]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[${finalVideo}]`)
    audio = null
  } else {
    finalVideo = g.label('vf')
    const fmt = o.format === 'mp4' || o.format === 'mkv' || o.format === 'mov' ? pixelFormatFor(encoder, o.quality) : 'yuv420p'
    g.add(`[${video}]format=${fmt}[${finalVideo}]`)
  }
  args.push('-filter_complex', g.lines.join(';'), '-map', `[${finalVideo}]`)
  if (audio) args.push('-map', `[${audio}]`)

  if (o.format === 'gif') {
    args.push('-an', '-loop', '0')
  } else if (o.format === 'hevc') {
    args.push('-fps_mode', 'cfr', '-r', String(fps), '-g', String(fps * 2))
    args.push('-c:v', 'libx265', '-preset', 'medium', '-crf', '15', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', ...COLOR_TAGS)
    if (audio) args.push('-c:a', 'aac', '-b:a', '320k')
    args.push('-movflags', '+faststart')
  } else if (o.format === 'webm') {
    args.push('-fps_mode', 'cfr', '-r', String(fps), '-g', String(fps * 2))
    args.push(
      '-c:v', 'libvpx-vp9', '-crf', '17', '-b:v', '0', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-tile-columns', '2',
      ...COLOR_TAGS
    )
    if (audio) args.push('-c:a', 'libopus', '-b:a', '192k')
  } else {
    args.push('-fps_mode', 'cfr', '-r', String(fps))
    args.push(...encoderArgs(encoder, o.quality, W * H * fps, o.basicTuning), '-g', String(fps * 2), ...COLOR_TAGS)
    if (audio) args.push(...audioEncodeArgs(o.quality))
    if (o.format !== 'mkv') args.push('-movflags', '+faststart')
  }
  args.push('-t', num(T), '-progress', 'pipe:1', o.output)
  return { args, seconds: T, width: W, height: H }
}
