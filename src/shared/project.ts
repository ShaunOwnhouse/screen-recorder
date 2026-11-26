import type { Rect } from './types.ts'

/**
 * Everything the editor knows about a video being made: the pieces on its video and audio tracks, the things laid over it
 * (comments, shapes, blur, zoom, picture-in-picture), and the background music. All positions are fractions of the
 * frame (0–1) and all sizes are in "1080p pixels", so a project looks the same at any resolution.
 */

let counter = 0
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

// ---------- tracks and the pieces on them ----------

/** A row of the timeline. Video tracks stack like layers (the one at the top is in front); audio tracks only mix. */
export interface Track {
  id: string
  kind: 'video' | 'audio'
  name: string
  /** Silent (its sound is not in the finished video). */
  muted: boolean
  /** Not shown (its picture and its sound are left out of the finished video). */
  hidden: boolean
  /** Can't be changed by accident. */
  locked: boolean
}

export interface TitleCard {
  title: string
  subtitle: string
  /** One colour, or two for a top-to-bottom gradient. */
  bg: [string, string]
  color: string
  font: string
  align: 'left' | 'center'
}

/** A fade at the start or end of a piece: into (or out of) a colour, or 'dissolve' to let what is behind show through. */
export interface Fade {
  dur: number
  color: string
}

export const DISSOLVE = 'dissolve'
export const NO_FADE: Fade = { dur: 0, color: '#000000' }

/** Where a piece sits in the picture: width as a fraction of the frame (1 = the whole frame; x and y then don't matter). */
export interface Box {
  x: number
  y: number
  w: number
}

export const FULL_BOX: Box = { x: 0, y: 0, w: 1 }
export const isFullBox = (b: Box): boolean => b.w >= 0.999

/**
 * A level that changes over time, drawn as a line through points (and straight between them): 1 = as set, 0 = silent (or
 * hidden). Before the first point and after the last it stays at that point's level. Used to dip the music under a voice,
 * or to let the face camera disappear for a while.
 */
export interface EnvPoint {
  /** Seconds from the start of the piece (for the face camera: seconds on the whole timeline). */
  t: number
  /** 0–1 */
  v: number
}

/** The level at time t (1 when there are no points). */
export function envAt(env: EnvPoint[] | undefined, t: number): number {
  if (!env || !env.length) return 1
  if (t <= env[0].t) return env[0].v
  const last = env[env.length - 1]
  if (t >= last.t) return last.v
  for (let i = 1; i < env.length; i++) {
    if (t < env[i].t) {
      const a = env[i - 1]
      const b = env[i]
      return b.t - a.t < 1e-9 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }
  }
  return last.v
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Puts a point in (replacing one that is almost at the same time), keeping the points in time order. */
export function envPut(env: EnvPoint[] | undefined, t: number, v: number): EnvPoint[] {
  const out = (env ?? []).filter((p) => Math.abs(p.t - t) > 0.04)
  out.push({ t: Math.max(0, t), v: clamp01(v) })
  return out.sort((a, b) => a.t - b.t)
}

export function envRemove(env: EnvPoint[] | undefined, index: number): EnvPoint[] {
  return (env ?? []).filter((_, i) => i !== index)
}

/** The level goes down to `low` for `hold` seconds from time t, then comes back to what it was. */
export function envDip(env: EnvPoint[] | undefined, t: number, hold = 3, low = 0.12, ramp = 0.4): EnvPoint[] {
  const before = envAt(env, t)
  const after = envAt(env, t + hold + ramp * 2)
  let e = (env ?? []).filter((p) => p.t < t - 0.04 || p.t > t + hold + ramp * 2 + 0.04)
  for (const [tt, v] of [[t, before], [t + ramp, low], [t + ramp + hold, low], [t + ramp * 2 + hold, after]] as const) e = envPut(e, tt, v)
  return e
}

/** From time t the level glides to `to` over `dur` seconds and stays there. */
export function envRamp(env: EnvPoint[] | undefined, t: number, to: number, dur = 1.5): EnvPoint[] {
  const from = envAt(env, t)
  let e = (env ?? []).filter((p) => p.t < t - 0.04)
  e = envPut(e, t, from)
  return envPut(e, t + dur, to)
}

/** Slides every point by `by` seconds (negative = earlier) and drops the ones that fall before 0, keeping the level at 0. */
export function envShift(env: EnvPoint[] | undefined, by: number): EnvPoint[] | undefined {
  if (!env || !env.length) return env
  const start = envAt(env, -by)
  const kept = env.filter((p) => p.t + by > 1e-6).map((p) => ({ t: p.t + by, v: p.v }))
  const out = by < 0 ? [{ t: 0, v: start }, ...kept] : [...kept]
  return out.length ? out : undefined
}

/** Stretches or squeezes the line in time (for when the piece it belongs to is sped up or slowed down). */
export function envScale(env: EnvPoint[] | undefined, by: number): EnvPoint[] | undefined {
  return env && env.length ? env.map((p) => ({ t: p.t * by, v: p.v })) : env
}

/** Takes the stretch [a, b) out of the line: points inside go, later ones slide earlier. */
export function envCut(env: EnvPoint[] | undefined, a: number, b: number): EnvPoint[] | undefined {
  if (!env || !env.length) return env
  const cut = b - a
  const after = envAt(env, b)
  const out = [...env.filter((p) => p.t < a - 1e-6), { t: a, v: after }, ...env.filter((p) => p.t > b + 1e-6).map((p) => ({ t: p.t - cut, v: p.v }))]
  return out
}

/** Opens a gap of `len` seconds at `at`: later points slide later, and the level just holds across the gap. */
export function envOpen(env: EnvPoint[] | undefined, at: number, len: number): EnvPoint[] | undefined {
  if (!env || !env.length) return env
  const v = envAt(env, at)
  return [...env.filter((p) => p.t < at - 1e-6), { t: at, v }, { t: at + len, v }, ...env.filter((p) => p.t >= at - 1e-6).map((p) => ({ t: p.t + len, v: p.v }))]
}

/** Splits at time t into the part before it and the part after it (which starts again at 0). */
export function envSplit(env: EnvPoint[] | undefined, t: number): [EnvPoint[] | undefined, EnvPoint[] | undefined] {
  if (!env || !env.length) return [env, env]
  const v = envAt(env, t)
  const left = [...env.filter((p) => p.t < t - 1e-6), { t, v }]
  const right = envShift(env, -t)
  return [left, right]
}

export type ClipShape = 'rect' | 'square' | 'rounded' | 'circle'

/** A piece on a video track: the recording, a video or picture the person added, or a title card. */
export interface Clip {
  id: string
  /** Which video track it sits on. */
  track: string
  /** Where on the timeline it starts, seconds. */
  start: number
  /** The recording being edited, a video the person added, or a still picture (title cards are pictures too). */
  kind: 'recording' | 'video' | 'image'
  /** 'recording', or the id of a file registered with the app. */
  media: string
  name: string
  /** Seconds into the source where this piece starts and ends. For pictures: 0 and how long they stay on screen (at normal speed). */
  in: number
  out: number
  /** Playback speed of this piece: 1 = as recorded, 2 = twice as fast, 0.5 = half speed. */
  speed: number
  hasAudio: boolean
  /** 0–2: the piece's own sound. */
  volume: number
  width: number
  height: number
  card?: TitleCard
  /**
   * For the recording: which of its sounds to use. The recording holds the computer's sound and the microphone as tracks
   * of their own (as well as a mix of both); 'mix' (the default) plays everything as recorded.
   */
  audioSource?: 'mix' | 'pc' | 'mic' | 'none'
  fadeIn: Fade
  fadeOut: Fade
  /** The piece's own sound over time (see EnvPoint). */
  volEnv?: EnvPoint[]
  /** How visible the piece is over time (see EnvPoint): fade it out for a while and bring it back. */
  showEnv?: EnvPoint[]
  box: Box
  /**
   * The shape of a piece shown as a small window: 'rect' (the default) keeps the picture's own shape; the others are a square
   * window showing the middle of the picture (the face camera is a circle). Windows that are not 'rect' sit on top of the
   * edits (zoom, blur) and the comments, so the person never zooms with the screen.
   */
  shape?: ClipShape
  /** A white frame round a piece that is smaller than the picture. */
  border: boolean
}

/** Which sounds the screen recording itself holds. */
export interface RecordingTracks {
  /** It has the computer's sound. */
  pc: boolean
  /** It has the microphone. */
  mic: boolean
}

export const MIN_CLIP = 0.1
export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const EPS = 1e-6

/** How long a piece lasts on the timeline (a faster piece is shorter). */
export const clipLength = (c: Clip): number => Math.max(MIN_CLIP, (c.out - c.in) / Math.max(MIN_SPEED, c.speed))
export const clipEnd = (c: Clip): number => c.start + clipLength(c)

// ---------- things laid over the video ----------

export interface Common {
  id: string
  start: number
  end: number
  /** Fade in and out over the first/last 0.3 s. */
  fade: boolean
}

export interface TextOverlay extends Common {
  kind: 'bubble' | 'note' | 'text'
  x: number
  y: number
  /** Width of the box as a fraction of the frame width. */
  w: number
  text: string
  /** Font size in 1080p pixels. */
  size: number
  color: string
  bg: string
  font: string
  align: 'left' | 'center'
  /** For bubbles: where the little pointer points (fractions of the frame). */
  tx: number
  ty: number
}
export interface ArrowOverlay extends Common {
  kind: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
}
export interface BoxOverlay extends Common {
  kind: 'box'
  x: number
  y: number
  w: number
  h: number
  color: string
  width: number
  radius: number
  fill: string | null
}
export interface StepOverlay extends Common {
  kind: 'step'
  x: number
  y: number
  n: number
  color: string
  size: number
}
export interface SpotlightOverlay extends Common {
  kind: 'spotlight'
  x: number
  y: number
  w: number
  h: number
  shape: 'rect' | 'ellipse'
  /** 0–1: how dark the rest of the picture goes. */
  dim: number
}
export interface BlurOverlay extends Common {
  kind: 'blur'
  x: number
  y: number
  w: number
  h: number
  mode: 'blur' | 'pixelate'
  /** 1–10 */
  strength: number
}
export interface ZoomOverlay extends Common {
  kind: 'zoom'
  x: number
  y: number
  w: number
  h: number
  /** Seconds to glide in and out. */
  ease: number
}

export type Overlay = TextOverlay | ArrowOverlay | BoxOverlay | StepOverlay | SpotlightOverlay | BlurOverlay | ZoomOverlay
export type OverlayKind = Overlay['kind']

/** Overlays that are drawn by the editor and sent to FFmpeg as pictures. */
export const isDrawn = (o: Overlay): o is TextOverlay | ArrowOverlay | BoxOverlay | StepOverlay | SpotlightOverlay =>
  o.kind === 'bubble' || o.kind === 'note' || o.kind === 'text' || o.kind === 'arrow' || o.kind === 'box' || o.kind === 'step' || o.kind === 'spotlight'

// ---------- sounds ----------

/**
 * A sound on an audio track: a song or other audio file, or the sound taken off a video or the recording. There can be
 * as many as the person likes, each placed, trimmed, split and mixed on its own.
 */
export interface Sound {
  id: string
  /** Which audio track it sits on. */
  track: string
  /** Where it came from: an audio file the person added, or the sound split off a video / the recording. */
  origin: 'music' | 'split'
  /** 'recording', or the id of an added file (audio or video). */
  media: string
  name: string
  /** Length of the source file, seconds. */
  duration: number
  /** Where in the file it starts playing. */
  offset: number
  /** Where on the timeline it starts. */
  start: number
  /** How long it plays on the timeline (it repeats inside this when `loop` is on and the file is shorter). */
  length: number
  /** 1 = as recorded, 2 = twice as fast (and higher), 0.5 = half speed. */
  speed: number
  /** 0–2 */
  volume: number
  fadeIn: number
  fadeOut: number
  /** Repeat the file to fill its length. */
  loop: boolean
  /** Turn it down whenever the video has sound (a voice). */
  duck: boolean
  /** Its level over time (see EnvPoint): dip the music under a voice, bring it back later. */
  volEnv?: EnvPoint[]
}

export const MIN_SOUND = 0.1
export const soundEnd = (s: Sound): number => s.start + s.length

export interface Project {
  /** The rows of the timeline, top to bottom: video tracks (the top one is in front), then audio tracks. */
  tracks: Track[]
  clips: Clip[]
  overlays: Overlay[]
  sounds: Sound[]
  /** What the recording holds (not something the person edits). */
  recTracks: RecordingTracks
  /** Speed of the finished video: 1 = as recorded, 2 = twice as fast, 0.5 = half speed. */
  speed: number
  /** Normalised crop of the recording (and so of the finished video), or null. */
  crop: Rect | null
}

export const FADE_SECONDS = 0.3

/** How visible an overlay is at time t (0 = hidden, 1 = fully shown). */
export function overlayAlpha(o: Common, t: number): number {
  if (t < o.start || t >= o.end) return 0
  if (!o.fade) return 1
  const d = Math.min(FADE_SECONDS, (o.end - o.start) / 2)
  if (d <= 0) return 1
  return Math.max(0, Math.min(1, (t - o.start) / d, (o.end - t) / d))
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const smooth = (p: number): number => p * p * (3 - 2 * p)

/** The factor and centre one zoom wants at its fullest. */
export function zoomTarget(z: ZoomOverlay): { z: number; cx: number; cy: number } {
  const factor = clamp(1 / Math.max(z.w, z.h, 0.05), 1, 8)
  const half = 0.5 / factor
  return { z: factor, cx: clamp(z.x + z.w / 2, half, 1 - half), cy: clamp(z.y + z.h / 2, half, 1 - half) }
}

/** 0 → 1 → 0 across a zoom's window: it glides in, holds, then glides back out. */
export function zoomWeight(z: ZoomOverlay, t: number): number {
  const ease = Math.max(0.05, Math.min(z.ease, (z.end - z.start) / 2))
  return smooth(clamp((t - z.start) / ease, 0, 1)) * smooth(clamp((z.end - t) / ease, 0, 1))
}

/** The zoom level and centre of the frame at time t (z = 1 means no zoom). Identical maths is used by the export. */
export function zoomState(overlays: Overlay[], t: number): { z: number; cx: number; cy: number } {
  let z = 1
  let cx = 0.5
  let cy = 0.5
  for (const o of overlays) {
    if (o.kind !== 'zoom') continue
    const w = zoomWeight(o, t)
    if (w <= 0) continue
    const tg = zoomTarget(o)
    z += (tg.z - 1) * w
    cx += (tg.cx - 0.5) * w
    cy += (tg.cy - 0.5) * w
  }
  const half = 0.5 / z
  return { z, cx: clamp(cx, half, 1 - half), cy: clamp(cy, half, 1 - half) }
}

// ---------- tracks: finding, adding, placing ----------

export interface Edit {
  project: Project
  /** The clip to select afterwards. */
  select?: string
}


export const videoTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'video')
export const audioTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'audio')
export const trackById = (p: Project, id: string): Track | undefined => p.tracks.find((t) => t.id === id)

/** The video track at the bottom of the stack: where the recording starts out and where a sequence of pieces is built. */
export function baseVideoTrack(p: Project): Track {
  const v = videoTracks(p)
  return v[v.length - 1]
}

/** Video tracks from the back of the picture to the front. */
export const paintOrder = (p: Project): Track[] => [...videoTracks(p)].reverse()

/** Where a piece of this track is in the stack: 0 is the back. */
export const layerOf = (p: Project, trackId: string): number => paintOrder(p).findIndex((t) => t.id === trackId)

function newTrack(kind: Track['kind'], n: number): Track {
  return { id: newId('t'), kind, name: kind === 'video' ? `Video ${n}` : `Audio ${n}`, muted: false, hidden: false, locked: false }
}

/** A new video track in front of all the others (or just in front of `above`). */
export function addVideoTrack(p: Project, above?: string): { project: Project; track: Track } {
  const track = newTrack('video', videoTracks(p).length + 1)
  const idx = above ? p.tracks.findIndex((t) => t.id === above) : 0
  const at = idx < 0 ? 0 : idx
  return { project: { ...p, tracks: [...p.tracks.slice(0, at), track, ...p.tracks.slice(at)] }, track }
}

/** A new audio track below the others. */
export function addAudioTrack(p: Project): { project: Project; track: Track } {
  const track = newTrack('audio', audioTracks(p).length + 1)
  return { project: { ...p, tracks: [...p.tracks, track] }, track }
}

/** Takes away an empty track (there always stays at least one of each kind). */
export function removeTrack(p: Project, id: string): Project | null {
  const t = trackById(p, id)
  if (!t) return null
  if (p.clips.some((c) => c.track === id) || p.sounds.some((s) => s.track === id)) return null
  if (p.tracks.filter((x) => x.kind === t.kind).length <= 1) return null
  return { ...p, tracks: p.tracks.filter((x) => x.id !== id) }
}

export function patchTrack(p: Project, id: string, patch: Partial<Track>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

interface Span {
  id: string
  start: number
  end: number
}

/** Everything sitting on a track, in time order. */
function spansOn(p: Project, trackId: string, ignore?: string): Span[] {
  const out: Span[] = []
  for (const c of p.clips) if (c.track === trackId && c.id !== ignore) out.push({ id: c.id, start: c.start, end: clipEnd(c) })
  for (const s of p.sounds) if (s.track === trackId && s.id !== ignore) out.push({ id: s.id, start: s.start, end: soundEnd(s) })
  return out.sort((a, b) => a.start - b.start)
}

/** Is there room on this track from `start` to `end`? */
export function isFree(p: Project, trackId: string, start: number, end: number, ignore?: string): boolean {
  return spansOn(p, trackId, ignore).every((s) => s.end <= start + EPS || s.start >= end - EPS)
}

/** The start closest to the one asked for where a piece of this length fits on the track (null if none, which can't happen on an open-ended track). */
export function nearestFree(p: Project, trackId: string, start: number, len: number, ignore?: string): number | null {
  const want = Math.max(0, start)
  const spans = spansOn(p, trackId, ignore)
  const candidates = [want]
  for (const s of spans) candidates.push(s.end, s.start - len)
  let best: number | null = null
  for (const c of candidates) {
    if (c < -EPS) continue
    const s = Math.max(0, c)
    if (!spans.every((x) => x.end <= s + EPS || x.start >= s + len - EPS)) continue
    if (best === null || Math.abs(s - want) < Math.abs(best - want)) best = s
  }
  return best
}

// ---------- adding, moving, trimming ----------

/**
 * Puts a new piece on the timeline at time `at`: on the lowest video track that has room there (so a sequence builds up
 * on one row), or on a new track in front of the others.
 */
export function addClip(p: Project, clip: Clip, at: number): Edit {
  const len = clipLength(clip)
  const start = Math.max(0, at)
  let proj = p
  let track = paintOrder(p).find((t) => !t.locked && isFree(p, t.id, start, start + len))
  if (!track) {
    const r = addVideoTrack(p)
    proj = r.project
    track = r.track
  }
  const placed: Clip = { ...clip, track: track.id, start }
  return { project: { ...proj, clips: [...proj.clips, placed] }, select: placed.id }
}

/** Slides a piece (maybe onto another video track). It lands where there is room, as near to the wished-for place as can be. */
export function moveClip(p: Project, id: string, track: string, start: number): Project | null {
  const c = p.clips.find((x) => x.id === id)
  const t = trackById(p, track)
  if (!c || !t || t.kind !== 'video' || t.locked) return null
  const at = nearestFree(p, track, start, clipLength(c), id)
  if (at === null) return null
  if (c.track === track && Math.abs(at - c.start) < EPS) return p
  return { ...p, clips: p.clips.map((x) => (x.id === id ? { ...x, track, start: at } : x)) }
}

/**
 * Drags one edge of a piece. `to` is the new time of that edge on the timeline; `sourceLen` is how long the file is
 * (null for pictures, which can be shown for as long as you like). Nothing else moves.
 */
export function trimClip(p: Project, id: string, edge: 'start' | 'end', to: number, sourceLen: number | null): Project | null {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return null
  const others = spansOn(p, c.track, id)
  const end = clipEnd(c)
  const prevEnd = others.filter((s) => s.end <= c.start + EPS).reduce((m, s) => Math.max(m, s.end), 0)
  const nextStart = others.filter((s) => s.start >= end - EPS).reduce((m, s) => Math.min(m, s.start), Number.POSITIVE_INFINITY)
  let next: Clip
  if (edge === 'start') {
    let start = clamp(to, prevEnd, end - MIN_CLIP)
    if (c.kind === 'image') {
      next = { ...c, start, in: 0, out: (end - start) * c.speed, volEnv: envShift(c.volEnv, c.start - start), showEnv: envShift(c.showEnv, c.start - start) }
    } else {
      let nin = c.in + (start - c.start) * c.speed
      if (nin < 0) {
        start = c.start - c.in / c.speed
        nin = 0
      }
      next = { ...c, start, in: nin, volEnv: envShift(c.volEnv, c.start - start), showEnv: envShift(c.showEnv, c.start - start) }
    }
  } else {
    const e = clamp(to, c.start + MIN_CLIP, nextStart)
    let out = c.in + (e - c.start) * c.speed
    if (sourceLen !== null) out = Math.min(out, sourceLen)
    next = { ...c, out: Math.max(c.in + MIN_CLIP * c.speed, out) }
  }
  if (Math.abs(next.start - c.start) < EPS && Math.abs(next.in - c.in) < EPS && Math.abs(next.out - c.out) < EPS) return p
  return { ...p, clips: p.clips.map((x) => (x.id === id ? next : x)) }
}

/** Changes how fast a piece plays. It grows or shrinks from its start; anything after it on the same track is pushed if it would overlap. */
export function setClipSpeed(p: Project, id: string, speed: number): Project | null {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return null
  const sp = clamp(speed, MIN_SPEED, MAX_SPEED)
  const next = { ...c, speed: sp, volEnv: envScale(c.volEnv, c.speed / sp), showEnv: envScale(c.showEnv, c.speed / sp) }
  const grow = clipEnd(next) - clipEnd(c)
  let clips = p.clips.map((x) => (x.id === id ? next : x))
  let sounds = p.sounds
  if (grow > EPS) {
    // push whatever now collides, and what follows it, later on the same track
    const after = spansOn(p, c.track, id).filter((s) => s.start >= clipEnd(c) - EPS)
    let edge = clipEnd(next)
    const shift = new Map<string, number>()
    for (const s of after) {
      if (s.start < edge - EPS) {
        shift.set(s.id, edge - s.start)
        edge = s.end + (edge - s.start)
      } else break
    }
    if (shift.size) {
      clips = clips.map((x) => (shift.has(x.id) ? { ...x, start: x.start + shift.get(x.id)! } : x))
      sounds = sounds.map((x) => (shift.has(x.id) ? { ...x, start: x.start + shift.get(x.id)! } : x))
    }
  }
  return { ...p, clips, sounds }
}

/** A copy of a piece on the track just above it (or a new one), at the same moment, ready to be slid wherever it should go. */
export function duplicateClip(p: Project, id: string): Edit | null {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return null
  const end = clipEnd(c)
  const vt = videoTracks(p)
  const idx = vt.findIndex((t) => t.id === c.track)
  let target = vt.slice(0, Math.max(0, idx)).reverse().find((t) => !t.locked && isFree(p, t.id, c.start, end))
  let proj = p
  if (!target) {
    const r = addVideoTrack(p, c.track)
    proj = r.project
    target = r.track
  }
  const copy: Clip = { ...JSON.parse(JSON.stringify(c)), id: newId('c'), track: target.id }
  return { project: { ...proj, clips: [...proj.clips, copy] }, select: copy.id }
}

// ---------- cutting ----------

/** Cuts a piece in two at time t of the timeline. */
export function splitClipAt(c: Clip, t: number): [Clip, Clip] {
  const off = (t - c.start) * c.speed
  const [envA, envB] = envSplit(c.volEnv, t - c.start)
  const [showA, showB] = envSplit(c.showEnv, t - c.start)
  const first: Clip = { ...c, out: c.in + off, fadeOut: NO_FADE, volEnv: envA, showEnv: showA }
  const second: Clip = {
    ...c, id: newId('c'), start: t, in: c.kind === 'image' ? 0 : c.in + off, out: c.kind === 'image' ? c.out - c.in - off : c.out, fadeIn: NO_FADE, volEnv: envB, showEnv: showB
  }
  return [first, second]
}

export function splitSoundAt(s: Sound, t: number): [Sound, Sound] {
  const rel = t - s.start
  const [envA, envB] = envSplit(s.volEnv, rel)
  const first: Sound = { ...s, length: rel, fadeOut: 0, volEnv: envA }
  const adv = rel * s.speed
  const second: Sound = {
    ...s, id: newId('s'), start: t, length: s.length - rel, offset: s.loop && s.duration > 0 ? (s.offset + adv) % s.duration : s.offset + adv, fadeIn: 0, volEnv: envB
  }
  return [first, second]
}

/** Splits every piece and sound that is playing at time t (on tracks that aren't locked, unless `force`). */
function splitEverythingAt(p: Project, t: number, force = false): Project {
  const open = (track: string): boolean => force || !trackById(p, track)?.locked
  return {
    ...p,
    clips: p.clips.flatMap((c) => (open(c.track) && t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2 ? splitClipAt(c, t) : [c])),
    sounds: p.sounds.flatMap((s) => (open(s.track) && t > s.start + MIN_SOUND / 2 && t < soundEnd(s) - MIN_SOUND / 2 ? splitSoundAt(s, t) : [s]))
  }
}

/** Cuts the selected piece at t, or (with nothing chosen) everything that is playing there. Null if there is nothing to cut. */
export function splitAt(p: Project, t: number, selectedClip?: string): Edit | null {
  if (selectedClip) {
    const c = p.clips.find((x) => x.id === selectedClip)
    if (!c || t <= c.start + MIN_CLIP || t >= clipEnd(c) - MIN_CLIP) return null
    const [a, b] = splitClipAt(c, t)
    return { project: { ...p, clips: p.clips.flatMap((x) => (x.id === c.id ? [a, b] : [x])) }, select: b.id }
  }
  const next = splitEverythingAt(p, t)
  if (next.clips.length === p.clips.length && next.sounds.length === p.sounds.length) return null
  const fresh = next.clips.find((c) => !p.clips.some((o) => o.id === c.id))
  return { project: next, select: fresh?.id }
}

/** Takes the span [a, b) out of the whole timeline: everything inside it goes, everything after it slides earlier. */
export function removeSpan(p: Project, a: number, b: number): Project {
  const cut = b - a
  const split = splitEverythingAt(splitEverythingAt(p, a, true), b, true)
  const clips: Clip[] = []
  for (const c of split.clips) {
    const e = clipEnd(c)
    if (c.start >= a - EPS && e <= b + EPS) continue
    clips.push(c.start >= b - EPS ? { ...c, start: c.start - cut } : c)
  }
  const sounds: Sound[] = []
  for (const s of split.sounds) {
    const e = soundEnd(s)
    if (s.start >= a - EPS && e <= b + EPS) continue
    sounds.push(s.start >= b - EPS ? { ...s, start: s.start - cut } : s)
  }
  return { ...split, clips, sounds, overlays: cutOverlays(p.overlays, a, b) }
}

/** Opens a gap of `len` seconds at `at` on every track: whatever is playing there is split and the later part slides later. */
export function insertGap(p: Project, at: number, len: number): Project {
  const split = splitEverythingAt(p, at, true)
  return {
    ...split,
    clips: split.clips.map((c) => (c.start >= at - EPS ? { ...c, start: c.start + len } : c)),
    sounds: split.sounds.map((s) => (s.start >= at - EPS ? { ...s, start: s.start + len } : s)),
    overlays: openGap(p.overlays, at, len)
  }
}

/** Puts a new piece in at `at` on the bottom track and pushes everything on every track after that point later. */
export function insertClipPushing(p: Project, clip: Clip, at: number): Edit {
  const len = clipLength(clip)
  const gapped = insertGap(p, Math.max(0, at), len)
  const base = baseVideoTrack(gapped)
  const placed: Clip = { ...clip, track: base.id, start: Math.max(0, at) }
  return { project: { ...gapped, clips: [...gapped.clips, placed] }, select: placed.id }
}

/** Removes a piece. With `ripple` the time it took up is taken out of every track; without, it just leaves a gap. Null if it's the only piece. */
export function deleteClip(p: Project, id: string, ripple = true): Edit | null {
  const c = p.clips.find((x) => x.id === id)
  if (!c || p.clips.length <= 1) return null
  if (!ripple) return { project: { ...p, clips: p.clips.filter((x) => x.id !== id) } }
  const next = removeSpan(p, c.start, clipEnd(c))
  return { project: next.clips.length ? next : { ...p, clips: p.clips.filter((x) => x.id !== id) } }
}

/** The length of the whole video: where the last piece on any video track ends. */
export const totalDuration = (p: Project): number => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)

/** The pieces showing at time t, from the back of the picture to the front. */
export function activeClips(p: Project, t: number): Clip[] {
  return p.clips
    .filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS)
    .sort((a, b) => layerOf(p, a.track) - layerOf(p, b.track) || a.start - b.start)
}

/** The piece to show a still of when nothing is exactly at t (the last one before it), for the preview's sake. */
export function lastClipBefore(p: Project, t: number): Clip | null {
  let hit: Clip | null = null
  for (const c of p.clips) if (clipEnd(c) <= t + EPS && (!hit || clipEnd(c) > clipEnd(hit))) hit = c
  return hit
}

// ---------- sounds: adding, moving, cutting ----------

/** Puts a sound on the first audio track that has room at that moment (or a new track below). */
export function addSound(p: Project, sound: Omit<Sound, 'track'>): { project: Project; sound: Sound } {
  const len = sound.length
  const start = Math.max(0, sound.start)
  let proj = p
  let track = audioTracks(p).find((t) => !t.locked && isFree(p, t.id, start, start + len))
  if (!track) {
    const r = addAudioTrack(p)
    proj = r.project
    track = r.track
  }
  const placed: Sound = { ...sound, start, track: track.id }
  return { project: { ...proj, sounds: [...proj.sounds, placed] }, sound: placed }
}

export function moveSound(p: Project, id: string, track: string, start: number): Project | null {
  const s = p.sounds.find((x) => x.id === id)
  const t = trackById(p, track)
  if (!s || !t || t.kind !== 'audio' || t.locked) return null
  const at = nearestFree(p, track, start, s.length, id)
  if (at === null) return null
  if (s.track === track && Math.abs(at - s.start) < EPS) return p
  return { ...p, sounds: p.sounds.map((x) => (x.id === id ? { ...x, track, start: at } : x)) }
}

/** Cuts the sound in two at time t on the timeline. */
export function splitSound(p: Project, id: string, t: number): { project: Project; select: string } | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s || t <= s.start + MIN_SOUND || t >= soundEnd(s) - MIN_SOUND) return null
  const [a, b] = splitSoundAt(s, t)
  return { project: { ...p, sounds: p.sounds.flatMap((x) => (x.id === id ? [a, b] : [x])) }, select: b.id }
}

/** A copy of a sound on the audio track below it (or a new one), at the same moment. */
export function duplicateSound(p: Project, id: string): { project: Project; select: string } | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s) return null
  const at = audioTracks(p)
  const idx = at.findIndex((t) => t.id === s.track)
  let target = at.slice(idx + 1).find((t) => !t.locked && isFree(p, t.id, s.start, soundEnd(s)))
  let proj = p
  if (!target) {
    const r = addAudioTrack(p)
    proj = r.project
    target = r.track
  }
  const copy: Sound = { ...s, id: newId('s'), track: target.id }
  return { project: { ...proj, sounds: [...proj.sounds, copy] }, select: copy.id }
}

/** Drags an edge of a sound: the left edge moves where it starts (and what part of the file plays), the right edge its length. `to` is a time on the timeline. */
export function trimSound(p: Project, id: string, edge: 'start' | 'end', to: number): Project | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s) return null
  const others = spansOn(p, s.track, id)
  const end = soundEnd(s)
  const prevEnd = others.filter((x) => x.end <= s.start + EPS).reduce((m, x) => Math.max(m, x.end), 0)
  const nextStart = others.filter((x) => x.start >= end - EPS).reduce((m, x) => Math.min(m, x.start), Number.POSITIVE_INFINITY)
  let next: Sound
  if (edge === 'end') {
    const room = s.loop ? 36000 : Math.max(MIN_SOUND, (s.duration - s.offset) / s.speed)
    const e = clamp(to, s.start + MIN_SOUND, Math.min(nextStart, s.start + room))
    next = { ...s, length: e - s.start }
  } else {
    const start = clamp(to, prevEnd, end - MIN_SOUND)
    const offset = clamp(s.offset + (start - s.start) * s.speed, 0, Math.max(0, s.duration - MIN_SOUND))
    // the file can only be pulled back as far as its beginning
    const moved = (offset - s.offset) / s.speed
    next = { ...s, start: s.start + moved, offset, length: end - (s.start + moved), volEnv: envShift(s.volEnv, -moved) }
  }
  return { ...p, sounds: p.sounds.map((x) => (x.id === id ? next : x)) }
}

export function setSoundSpeed(p: Project, id: string, speed: number): Project | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s) return null
  const sp = clamp(speed, MIN_SPEED, MAX_SPEED)
  // keep the same stretch of the file: a faster sound is shorter
  const length = s.loop ? s.length : Math.max(MIN_SOUND, (s.length * s.speed) / sp)
  const next = { ...s, speed: sp, length, volEnv: s.loop ? s.volEnv : envScale(s.volEnv, s.speed / sp) }
  const grow = soundEnd(next) - soundEnd(s)
  let clips = p.clips
  let sounds = p.sounds.map((x) => (x.id === id ? next : x))
  if (grow > EPS) {
    const after = spansOn(p, s.track, id).filter((x) => x.start >= soundEnd(s) - EPS)
    let edge = soundEnd(next)
    const shift = new Map<string, number>()
    for (const x of after) {
      if (x.start < edge - EPS) {
        shift.set(x.id, edge - x.start)
        edge = x.end + (edge - x.start)
      } else break
    }
    if (shift.size) {
      clips = clips.map((x) => (shift.has(x.id) ? { ...x, start: x.start + shift.get(x.id)! } : x))
      sounds = sounds.map((x) => (shift.has(x.id) ? { ...x, start: x.start + shift.get(x.id)! } : x))
    }
  }
  return { ...p, clips, sounds }
}

// ---------- the recording's own sounds ----------

export const RECORDING_PC = 'recording-pc'
export const RECORDING_MIC = 'recording-mic'

/**
 * Where a piece's sound comes from. 'own' = from the piece's own file; 'media' = from a track of its own taken out of the
 * recording; 'none' = silent.
 */
export function clipTrack(p: Project, c: Clip): { mode: 'own' | 'media' | 'none'; media?: string } {
  if (c.kind !== 'recording') return { mode: 'own' }
  const want = c.audioSource ?? 'mix'
  if (want === 'mix') return { mode: 'own' }
  if (want === 'none') return { mode: 'none' }
  const t = p.recTracks
  if (t.pc && t.mic) return { mode: 'media', media: want === 'pc' ? RECORDING_PC : RECORDING_MIC }
  // only one kind of sound was recorded: the recording's own sound is that one
  if (want === 'pc') return t.pc ? { mode: 'own' } : { mode: 'none' }
  return t.mic ? { mode: 'own' } : { mode: 'none' }
}

export interface VoicePart {
  media: string
  /** Where in the file it starts. */
  from: number
  /** Where on the timeline. */
  start: number
  length: number
  volume: number
  speed: number
  /** Its level over time, from where it starts on the timeline. */
  env?: EnvPoint[]
}

/** Does this piece's sound count at all (its track is neither muted nor hidden)? */
export function soundOn(p: Project, trackId: string): boolean {
  const t = trackById(p, trackId)
  return !!t && !t.muted && !t.hidden
}

/** The stretches of sound that come from a track taken out of the recording (computer sound or microphone alone). */
export function clipVoiceParts(p: Project): VoicePart[] {
  const out: VoicePart[] = []
  for (const c of p.clips) {
    const t = clipTrack(p, c)
    if (t.mode === 'media' && t.media && c.hasAudio && soundOn(p, c.track)) {
      out.push({ media: t.media, from: c.in, start: c.start, length: clipLength(c), volume: c.volume, speed: c.speed, env: c.volEnv })
    }
  }
  return out
}

/** Does the piece play the sound of its own file? */
export const clipPlaysOwnSound = (p: Project, c: Clip): boolean => c.kind !== 'image' && c.hasAudio && clipTrack(p, c).mode === 'own' && soundOn(p, c.track)

/**
 * Takes the sound off a piece and makes it a sound of its own, on an audio track right under where it was. The piece goes
 * silent. Pictures and pieces with no sound can't be split.
 */
export function detachSound(p: Project, id: string): { project: Project; sound: Sound } | null {
  const c = p.clips.find((x) => x.id === id)
  if (!c || c.kind === 'image' || !c.hasAudio) return null
  const track = clipTrack(p, c)
  if (track.mode === 'none') return null
  const made = addSound(p, {
    id: newId('s'), origin: 'split', media: track.media ?? c.media, name: `Sound of ${c.name}`, duration: c.out, offset: c.in, start: c.start,
    length: clipLength(c), speed: c.speed, volume: c.volume, fadeIn: 0, fadeOut: 0, loop: false, duck: false, volEnv: c.volEnv
  })
  const clips = made.project.clips.map((x) => (x.id === id ? { ...x, hasAudio: false } : x))
  return { project: { ...made.project, clips }, sound: made.sound }
}

// ---------- housekeeping ----------

/** Keeps every overlay inside the video. */
export function tidy(p: Project): Project {
  const total = totalDuration(p)
  const overlays = p.overlays
    .map((o) => ({ ...o, start: clamp(o.start, 0, Math.max(0, total - 0.1)), end: clamp(o.end, 0.1, total) }))
    .filter((o) => o.end - o.start >= 0.1)
  return { ...p, overlays }
}

/** Is there anything beyond the untouched recording? Decides between moving the file as-is and re-encoding. */
export function isPlain(p: Project, recordingDuration: number): boolean {
  if (p.overlays.length || p.sounds.length || p.crop || p.speed !== 1) return false
  if (p.clips.length !== 1) return false
  const c = p.clips[0]
  const t = trackById(p, c.track)
  return (
    c.kind === 'recording' && (c.audioSource ?? 'mix') === 'mix' && c.volume === 1 && c.speed === 1 && c.start <= 0.01 && c.in <= 0.01 &&
    c.out >= recordingDuration - 0.01 && c.fadeIn.dur === 0 && c.fadeOut.dur === 0 && isFullBox(c.box) && !!t && !t.hidden && !t.muted
  )
}

export function newClipBase(): Pick<Clip, 'speed' | 'fadeIn' | 'fadeOut' | 'box' | 'border'> {
  return { speed: 1, fadeIn: NO_FADE, fadeOut: NO_FADE, box: FULL_BOX, border: false }
}

export function newProject(recording: { duration: number; width: number; height: number; hasAudio: boolean; tracks?: RecordingTracks }): Project {
  const v = newTrack('video', 1)
  const a = newTrack('audio', 1)
  return {
    tracks: [v, a],
    clips: [
      {
        id: newId('c'), track: v.id, start: 0, kind: 'recording', media: 'recording', name: 'Recording', in: 0, out: recording.duration, hasAudio: recording.hasAudio,
        volume: 1, width: recording.width, height: recording.height, ...newClipBase()
      }
    ],
    overlays: [],
    sounds: [],
    recTracks: recording.tracks ?? { pc: false, mic: false },
    speed: 1,
    crop: null
  }
}

/** Takes the span [a, b) out of the timeline: later overlays slide left, ones inside it vanish, ones crossing it shrink. */
export function cutOverlays(overlays: Overlay[], a: number, b: number): Overlay[] {
  const cut = b - a
  const out: Overlay[] = []
  for (const o of overlays) {
    if (o.end <= a + 1e-6) out.push(o)
    else if (o.start >= b - 1e-6) out.push({ ...o, start: o.start - cut, end: o.end - cut })
    else if (o.start >= a && o.end <= b) continue // lived entirely inside the removed piece
    else if (o.start < a && o.end > b) out.push({ ...o, end: o.end - cut })
    else if (o.start < a) out.push({ ...o, end: a })
    else out.push({ ...o, start: a, end: o.end - cut })
  }
  return out.filter((o) => o.end - o.start >= 0.1)
}

/** Opens a gap of `len` seconds at `at`: later overlays slide right and ones that cross it stretch. */
export function openGap(overlays: Overlay[], at: number, len: number): Overlay[] {
  return overlays.map((o) => (o.start >= at - 1e-6 ? { ...o, start: o.start + len, end: o.end + len } : o.end > at ? { ...o, end: o.end + len } : o))
}


export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** A small window that is not a plain rectangle (the face camera): it is drawn on top of the edits and comments. */
export const isFloating = (c: Clip): boolean => !!c.shape && c.shape !== 'rect' && !isFullBox(c.box) && !c.card

/** The height of a small window as a fraction of the frame (shaped windows are square in pixels, the others keep the picture's shape). */
export function clipBoxHeight(c: Clip, aspect: number): number {
  return c.shape && c.shape !== 'rect' ? c.box.w * aspect : c.box.w * aspect * ((c.height || 9) / (c.width || 16))
}

/** Where a small window goes to sit in a corner of the frame, a small margin in. */
export function windowCorner(c: Clip, aspect: number, corner: Corner): { x: number; y: number } {
  const m = 0.025
  const h = clipBoxHeight(c, aspect)
  return {
    x: corner.endsWith('left') ? m : 1 - c.box.w - m,
    y: corner.startsWith('top') ? m * aspect : 1 - h - m * aspect
  }
}

/** What the editor knows about the camera recording that was made together with the screen. */
export interface CameraSource {
  media: string
  name: string
  duration: number
  width: number
  height: number
  hasAudio: boolean
}

/** The track the face camera sits on. */
export const CAMERA_TRACK_NAME = 'Face cam'

/**
 * Puts the camera recording on a video track of its own, in front of the screen, as a round window in the bottom right corner.
 * It starts and ends where the screen recording and the camera file both have picture. From then on it is a piece like any other:
 * it can be moved, trimmed, split, copied, sped up, faded, turned down or deleted on its own. `offset`: camera time = recording time + offset.
 * The camera's voice is used instead of the recording's microphone (the recording keeps its computer sound).
 */
export function addCameraClip(p: Project, cam: CameraSource, offset: number, aspect: number): { project: Project; id: string } | null {
  const rec = p.clips.filter((c) => c.kind === 'recording').sort((a, b) => a.start - b.start)[0]
  if (!rec) return null
  let from = rec.in + offset
  let start = rec.start
  if (from < 0) {
    start += -from / rec.speed
    from = 0
  }
  const end = Math.min(clipEnd(rec), start + Math.max(0, (cam.duration - from) / rec.speed))
  if (end - start < 0.05) return null
  const added = addVideoTrack(p)
  const track = { ...added.track, name: CAMERA_TRACK_NAME }
  const fade: Fade = { dur: FADE_SECONDS, color: DISSOLVE }
  const clip: Clip = {
    ...newClipBase(), id: newId('c'), track: track.id, start, kind: 'video', media: cam.media, name: cam.name, in: from, out: from + (end - start) * rec.speed,
    speed: rec.speed, hasAudio: cam.hasAudio, volume: 1, width: cam.width, height: cam.height, fadeIn: fade, fadeOut: fade, border: true, shape: 'circle',
    box: { x: 0, y: 0, w: 0.22 }
  }
  clip.box = { ...clip.box, ...windowCorner(clip, aspect, 'bottom-right') }
  // the camera brings the voice; the screen recording keeps its computer sound (or none, when that was all it held)
  const hasPc = p.recTracks.pc
  const clips = p.clips.map((c) => (c.kind === 'recording' && cam.hasAudio ? { ...c, audioSource: hasPc ? ('pc' as const) : ('none' as const) } : c))
  const tracks = added.project.tracks.map((t) => (t.id === track.id ? track : t))
  return { project: { ...added.project, tracks, clips: [...clips, clip] }, id: clip.id }
}
