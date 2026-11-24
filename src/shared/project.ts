import type { Rect } from './types.ts'

/**
 * Everything the editor knows about a video being made: the pieces on the main track, the things laid over it
 * (comments, shapes, blur, zoom, picture-in-picture), and the background music. All positions are fractions of the
 * frame (0–1) and all sizes are in "1080p pixels", so a project looks the same at any resolution.
 */

let counter = 0
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

// ---------- main track ----------

export interface TitleCard {
  title: string
  subtitle: string
  /** One colour, or two for a top-to-bottom gradient. */
  bg: [string, string]
  color: string
  font: string
  align: 'left' | 'center'
}

export interface Clip {
  id: string
  /** The recording being edited, a video the person added, or a still picture (title cards are pictures too). */
  kind: 'recording' | 'video' | 'image'
  /** 'recording', or the id of a file registered with the app. */
  media: string
  name: string
  /** Seconds into the source where this piece starts and ends. For pictures: 0 and how long they stay on screen. */
  in: number
  out: number
  hasAudio: boolean
  /** 0–2: the clip's own sound. */
  volume: number
  /** How this clip comes in after the one before it. */
  transition: 'cut' | 'fade'
  transitionDur: number
  width: number
  height: number
  card?: TitleCard
  /**
   * For the recording: which of its sounds to use. The recording holds the computer's sound and the microphone as tracks
   * of their own (as well as a mix of both); 'mix' (the default) plays everything as recorded.
   */
  audioSource?: 'mix' | 'pc' | 'mic'
}

/** Which sounds the screen recording itself holds. */
export interface RecordingTracks {
  /** It has the computer's sound. */
  pc: boolean
  /** It has the microphone. */
  mic: boolean
}

export interface Placed {
  clip: Clip
  start: number
  end: number
  /** Seconds this clip overlaps the one before it (a cross-fade); 0 for a hard cut. */
  overlap: number
}

export const MIN_CLIP = 0.1
export const clipLength = (c: Clip): number => Math.max(MIN_CLIP, c.out - c.in)

/** Where every clip sits on the timeline. A fade starts early so the two clips overlap. */
export function layout(clips: Clip[]): Placed[] {
  const out: Placed[] = []
  let cursor = 0
  clips.forEach((clip, i) => {
    const len = clipLength(clip)
    let overlap = 0
    if (i > 0 && clip.transition === 'fade') overlap = Math.max(0, Math.min(clip.transitionDur, len / 2, clipLength(clips[i - 1]) / 2))
    const start = Math.max(0, cursor - overlap)
    out.push({ clip, start, end: start + len, overlap })
    cursor = start + len
  })
  return out
}

export const totalDuration = (clips: Clip[]): number => layout(clips).reduce((m, p) => Math.max(m, p.end), 0)

/** The clip that is showing at time t (the later one while two cross-fade). */
export function placedAt(clips: Clip[], t: number): Placed | null {
  const placed = layout(clips)
  let found: Placed | null = null
  for (const p of placed) if (t >= p.start - 1e-6 && t < p.end - 1e-6) found = p
  return found ?? (placed.length && t >= placed[placed.length - 1].end - 1e-6 ? placed[placed.length - 1] : null)
}

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
export interface PipOverlay extends Common {
  kind: 'pip'
  x: number
  y: number
  /** Width as a fraction of the frame width. */
  w: number
  media: string
  mediaKind: 'video' | 'image'
  name: string
  in: number
  sourceDuration: number
  hasAudio: boolean
  volume: number
  width: number
  height: number
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

export type Overlay = TextOverlay | ArrowOverlay | BoxOverlay | StepOverlay | SpotlightOverlay | BlurOverlay | PipOverlay | ZoomOverlay
export type OverlayKind = Overlay['kind']

/** Overlays that are drawn by the editor and sent to FFmpeg as pictures. */
export const isDrawn = (o: Overlay): o is TextOverlay | ArrowOverlay | BoxOverlay | StepOverlay | SpotlightOverlay =>
  o.kind === 'bubble' || o.kind === 'note' || o.kind === 'text' || o.kind === 'arrow' || o.kind === 'box' || o.kind === 'step' || o.kind === 'spotlight'

// ---------- sounds ----------

/**
 * A sound laid under the video: a song or other audio file, or the sound taken off a video or the recording. There can be
 * as many as the person likes, each placed, trimmed, split and mixed on its own.
 */
export interface Sound {
  id: string
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
  /** 0–2 */
  volume: number
  fadeIn: number
  fadeOut: number
  /** Repeat the file to fill its length. */
  loop: boolean
  /** Turn it down whenever the video has sound (a voice). */
  duck: boolean
}

export const MIN_SOUND = 0.1
export const soundEnd = (s: Sound): number => s.start + s.length

/**
 * The person's own face on camera, recorded together with the screen. It is tied to the recording itself, not to the
 * timeline: wherever a piece of the recording is shown, the camera from the same moment is shown with it, so cutting
 * the recording cuts the camera too.
 */
export interface CameraTrack {
  /** The camera file's id (registered with the editor like any other added file). */
  media: string
  name: string
  /** How long the camera file is, seconds. */
  duration: number
  width: number
  height: number
  /** Camera time = recording time + offset (the camera may have started a moment after, or before, the screen). */
  offset: number
  /** The person's own fix for a camera that runs late (voice ahead of the lips), seconds: the camera is shown that much earlier. */
  nudge: number
  /** Top-left corner, as fractions of the frame. */
  x: number
  y: number
  /** Width as a fraction of the frame width; the window is square. */
  w: number
  shape: 'circle' | 'rounded' | 'square'
  border: boolean
  fade: boolean
  visible: boolean
  /** Does the camera file have the person's voice recorded with it? */
  hasAudio: boolean
  /** Use the camera's own sound (instead of the screen recording's), so voice and lips are one recording. */
  audio: boolean
  /** 0–2: how loud the camera's sound is. */
  volume: number
}

export interface Project {
  clips: Clip[]
  overlays: Overlay[]
  sounds: Sound[]
  camera: CameraTrack | null
  /** What the recording holds (not something the person edits). */
  tracks: RecordingTracks
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

// ---------- editing ----------

export interface Edit {
  project: Project
  /** The clip to select afterwards. */
  select?: string
}

/** Cuts the clip showing at time t in two. Null if t is too close to an edge. */
export function splitAt(p: Project, t: number): Edit | null {
  const placed = layout(p.clips)
  const hit = placed.find((x) => t > x.start + 0.1 && t < x.end - 0.1)
  if (!hit) return null
  const offset = t - hit.start
  const first: Clip = { ...hit.clip, out: hit.clip.in + offset }
  const second: Clip = { ...hit.clip, id: newId('c'), in: hit.clip.kind === 'image' ? 0 : hit.clip.in + offset, out: hit.clip.kind === 'image' ? clipLength(hit.clip) - offset : hit.clip.out, transition: 'cut' }
  const clips = p.clips.flatMap((c) => (c.id === hit.clip.id ? [first, second] : [c]))
  return { project: { ...p, clips }, select: second.id }
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

/** Removes a clip and closes the gap: later comments, shapes and so on slide left with the video. */
export function deleteClip(p: Project, id: string): Edit | null {
  const placed = layout(p.clips)
  const hit = placed.find((x) => x.clip.id === id)
  if (!hit || p.clips.length <= 1) return null
  const a = hit.start
  const b = hit.end
  const clips = p.clips.filter((c) => c.id !== id)
  if (clips.length && placed[0].clip.id === id) clips[0] = { ...clips[0], transition: 'cut' }
  const overlays = cutOverlays(p.overlays, a, b)
  const next = clips[Math.min(placed.findIndex((x) => x.clip.id === id), clips.length - 1)]
  return { project: { ...p, clips, overlays }, select: next?.id }
}

/**
 * Changes how much of a clip is used by dragging one of its edges. `to` is the new source time of that edge; `sourceLen`
 * is how long the file is (null for pictures, which can be shown for as long as you like). Later overlays follow the edit.
 */
export function trimClip(p: Project, id: string, edge: 'start' | 'end', to: number, sourceLen: number | null): Project | null {
  const placed = layout(p.clips)
  const hit = placed.find((x) => x.clip.id === id)
  if (!hit) return null
  const c = hit.clip
  const max = sourceLen === null ? Number.POSITIVE_INFINITY : sourceLen
  let next: Clip
  let overlays: Overlay[]
  if (edge === 'start') {
    const inn = clamp(to, 0, c.out - MIN_CLIP)
    const delta = inn - c.in
    if (Math.abs(delta) < 1e-6) return p
    next = { ...c, in: inn }
    overlays = delta > 0 ? cutOverlays(p.overlays, hit.start, hit.start + delta) : openGap(p.overlays, hit.start, -delta)
  } else {
    const out = clamp(to, c.in + MIN_CLIP, max)
    const delta = out - c.out
    if (Math.abs(delta) < 1e-6) return p
    next = { ...c, out }
    overlays = delta < 0 ? cutOverlays(p.overlays, hit.end + delta, hit.end) : openGap(p.overlays, hit.end, delta)
  }
  return { ...p, clips: p.clips.map((x) => (x.id === id ? next : x)), overlays }
}

export function moveClip(p: Project, id: string, toIndex: number): Project {
  const from = p.clips.findIndex((c) => c.id === id)
  if (from < 0) return p
  const clips = p.clips.slice()
  const [c] = clips.splice(from, 1)
  clips.splice(clamp(toIndex, 0, clips.length), 0, c)
  if (clips.length) clips[0] = { ...clips[0], transition: 'cut' }
  return { ...p, clips }
}

/** Puts a new clip into the main track at time t: between two pieces, or by cutting the one showing there. */
export function insertClip(p: Project, clip: Clip, t: number): Edit {
  const placed = layout(p.clips)
  const hit = placed.find((x) => t > x.start + 0.1 && t < x.end - 0.1)
  let clips: Clip[]
  if (hit) {
    const split = splitAt(p, t)!.project.clips
    const idx = split.findIndex((c) => c.id === hit.clip.id)
    clips = [...split.slice(0, idx + 1), clip, ...split.slice(idx + 1)]
  } else {
    const before = placed.filter((x) => x.end <= t + 0.1).length
    clips = [...p.clips.slice(0, before), clip, ...p.clips.slice(before)]
  }
  if (clips.length) clips[0] = { ...clips[0], transition: 'cut' }
  // Everything after the new clip moves later by its length.
  const at = layout(clips).find((x) => x.clip.id === clip.id)!
  const overlays = openGap(p.overlays, at.start, at.end - at.start)
  return { project: { ...p, clips, overlays }, select: clip.id }
}



// ---------- the recording's own sounds ----------

export const RECORDING_PC = 'recording-pc'
export const RECORDING_MIC = 'recording-mic'
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/**
 * Where a clip's sound comes from. 'own' = from the clip's own file; 'media' = from a track of its own taken out of the
 * recording; 'none' = silent. When the camera's voice is used, a recording keeps only its computer sound.
 */
export function clipTrack(p: Project, c: Clip): { mode: 'own' | 'media' | 'none'; media?: string } {
  if (c.kind !== 'recording') return { mode: 'own' }
  const want = usesCameraSound(p) ? 'pc' : (c.audioSource ?? 'mix')
  if (want === 'mix') return { mode: 'own' }
  const t = p.tracks
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
}

/** The stretches of sound that come from a track taken out of the recording (computer sound or microphone alone). */
export function clipVoiceParts(p: Project): VoicePart[] {
  const out: VoicePart[] = []
  for (const pl of layout(p.clips)) {
    const t = clipTrack(p, pl.clip)
    if (t.mode === 'media' && t.media && pl.clip.hasAudio) out.push({ media: t.media, from: pl.clip.in, start: pl.start, length: pl.end - pl.start, volume: pl.clip.volume })
  }
  return out
}

/** Does the clip play the sound of its own file? */
export const clipPlaysOwnSound = (p: Project, c: Clip): boolean => c.kind !== 'image' && c.hasAudio && clipTrack(p, c).mode === 'own'

// ---------- more editing: duplicate, detach sound, split / trim sounds ----------

/** Puts a copy of a clip right after it. */
export function duplicateClip(p: Project, id: string): Edit | null {
  const placed = layout(p.clips)
  const hit = placed.find((x) => x.clip.id === id)
  if (!hit) return null
  const copy: Clip = { ...JSON.parse(JSON.stringify(hit.clip)), id: newId('c'), transition: 'cut' }
  const idx = p.clips.findIndex((c) => c.id === id)
  const clips = [...p.clips.slice(0, idx + 1), copy, ...p.clips.slice(idx + 1)]
  const at = layout(clips).find((x) => x.clip.id === copy.id)!
  return { project: { ...p, clips, overlays: openGap(p.overlays, at.start, at.end - at.start) }, select: copy.id }
}

/**
 * Takes the sound off a clip and makes it a sound of its own, on the timeline right under where it was. The clip goes
 * silent. Pictures and clips with no sound can't be split.
 */
export function detachSound(p: Project, id: string): { project: Project; sound: Sound } | null {
  const hit = layout(p.clips).find((x) => x.clip.id === id)
  if (!hit) return null
  const c = hit.clip
  if (c.kind === 'image' || !c.hasAudio) return null
  const track = clipTrack(p, c)
  if (track.mode === 'none') return null
  const sound: Sound = {
    id: newId('s'), origin: 'split', media: track.media ?? c.media, name: `Sound of ${c.name}`, duration: c.out, offset: c.in, start: hit.start,
    length: hit.end - hit.start, volume: c.volume, fadeIn: 0, fadeOut: 0, loop: false, duck: false
  }
  const clips = p.clips.map((x) => (x.id === id ? { ...x, hasAudio: false } : x))
  return { project: { ...p, clips, sounds: [...p.sounds, sound] }, sound }
}

/** Cuts the sound in two at time t on the timeline. */
export function splitSound(p: Project, id: string, t: number): { project: Project; select: string } | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s || t <= s.start + MIN_SOUND || t >= soundEnd(s) - MIN_SOUND) return null
  const rel = t - s.start
  const first: Sound = { ...s, length: rel, fadeOut: 0 }
  const second: Sound = { ...s, id: newId('s'), start: t, length: s.length - rel, offset: s.loop && s.duration > 0 ? (s.offset + rel) % s.duration : s.offset + rel, fadeIn: 0 }
  return { project: { ...p, sounds: p.sounds.flatMap((x) => (x.id === id ? [first, second] : [x])) }, select: second.id }
}

export function duplicateSound(p: Project, id: string): { project: Project; select: string } | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s) return null
  const copy: Sound = { ...s, id: newId('s'), start: soundEnd(s) }
  return { project: { ...p, sounds: [...p.sounds, copy] }, select: copy.id }
}

/** Drags an edge of a sound: the left edge moves where it starts (and what part of the file plays), the right edge its length. */
export function trimSound(p: Project, id: string, edge: 'start' | 'end', to: number): Project | null {
  const s = p.sounds.find((x) => x.id === id)
  if (!s) return null
  let next: Sound
  if (edge === 'end') {
    const length = clamp(to - s.start, MIN_SOUND, s.loop ? 36000 : Math.max(MIN_SOUND, s.duration - s.offset))
    next = { ...s, length }
  } else {
    const end = soundEnd(s)
    const start = clamp(to, 0, end - MIN_SOUND)
    const delta = start - s.start
    const offset = clamp(s.offset + delta, 0, Math.max(0, s.duration - MIN_SOUND))
    // the file can only be pulled back as far as its beginning
    const moved = offset - s.offset
    next = { ...s, start: s.start + moved, offset, length: end - (s.start + moved) }
  }
  return { ...p, sounds: p.sounds.map((x) => (x.id === id ? next : x)) }
}

/** Keeps every overlay inside the video. */
export function tidy(p: Project): Project {
  const total = totalDuration(p.clips)
  const overlays = p.overlays
    .map((o) => ({ ...o, start: clamp(o.start, 0, Math.max(0, total - 0.1)), end: clamp(o.end, 0.1, total) }))
    .filter((o) => o.end - o.start >= 0.1)
  return { ...p, overlays }
}

/** Is there anything beyond the untouched recording? Decides between moving the file as-is and re-encoding. */
export function isPlain(p: Project, recordingDuration: number): boolean {
  if (p.overlays.length || p.sounds.length || p.crop || (p.camera && (p.camera.visible || (p.camera.audio && p.camera.hasAudio)))) return false
  if (p.clips.length !== 1) return false
  const c = p.clips[0]
  return c.kind === 'recording' && (c.audioSource ?? 'mix') === 'mix' && p.speed === 1 && c.volume === 1 && c.in <= 0.01 && c.out >= recordingDuration - 0.01
}

export function newProject(recording: { duration: number; width: number; height: number; hasAudio: boolean; tracks?: RecordingTracks }): Project {
  return {
    clips: [
      {
        id: newId('c'), kind: 'recording', media: 'recording', name: 'Recording', in: 0, out: recording.duration, hasAudio: recording.hasAudio,
        volume: 1, transition: 'cut', transitionDur: 0.5, width: recording.width, height: recording.height
      }
    ],
    overlays: [],
    sounds: [],
    camera: null,
    tracks: recording.tracks ?? { pc: false, mic: false },
    speed: 1,
    crop: null
  }
}

export interface CameraPiece {
  /** Where on the timeline this piece of camera shows. */
  start: number
  end: number
  /** Where in the camera file it starts playing. */
  from: number
}

/**
 * Every stretch of the timeline that has the camera with it: one per piece of the recording that is showing, trimmed to
 * what the camera file really covers. The camera is hidden over added videos, pictures and title cards.
 */
export function cameraPieces(p: Project, forSound = false): CameraPiece[] {
  const cam = p.camera
  if (!cam || (!cam.visible && !forSound)) return []
  const out: CameraPiece[] = []
  for (const pl of layout(p.clips)) {
    if (pl.clip.kind !== 'recording') continue
    // the camera's own clock for the first moment of this piece
    let from = pl.clip.in + cam.offset + cam.nudge
    let start = pl.start
    if (from < 0) {
      start += -from // the camera had not started yet: it joins a moment later
      from = 0
    }
    const end = Math.min(pl.end, start + Math.max(0, cam.duration - from))
    if (end - start >= 0.05) out.push({ start, end, from })
  }
  return out
}

/** Does the project take its voice from the camera's own recording rather than from the screen recording? */
export const usesCameraSound = (p: Project): boolean => !!p.camera && p.camera.hasAudio && p.camera.audio

/** The face camera's window as fractions of the frame (it is square in pixels, so its height depends on the frame's shape). */
export function cameraBox(cam: CameraTrack, aspect: number): { x: number; y: number; w: number; h: number } {
  return { x: cam.x, y: cam.y, w: cam.w, h: cam.w * aspect }
}

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Where the camera goes to sit in a corner of the frame, a small margin in. */
export function cameraCorner(cam: CameraTrack, aspect: number, corner: Corner): { x: number; y: number } {
  const m = 0.025
  const h = cam.w * aspect
  return {
    x: corner.endsWith('left') ? m : 1 - cam.w - m,
    y: corner.startsWith('top') ? m * aspect : 1 - h - m * aspect
  }
}

/** The camera as it first appears: round, in the bottom right corner. */
export function newCamera(file: { media: string; name: string; duration: number; width: number; height: number; hasAudio?: boolean }, offset: number, aspect: number): CameraTrack {
  const hasAudio = !!file.hasAudio
  const cam: CameraTrack = {
    media: file.media, name: file.name, duration: file.duration, width: file.width, height: file.height,
    offset, nudge: 0, x: 0, y: 0, w: 0.22, shape: 'circle', border: true, fade: true, visible: true, hasAudio, audio: hasAudio, volume: 1
  }
  return { ...cam, ...cameraCorner(cam, aspect, 'bottom-right') }
}
