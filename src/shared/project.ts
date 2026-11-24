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

// ---------- music ----------

export interface Music {
  media: string
  name: string
  /** Length of the file, seconds. */
  duration: number
  /** Where in the file to start playing. */
  offset: number
  /** Where on the timeline it starts. */
  start: number
  /** 0–1 */
  volume: number
  fadeIn: number
  fadeOut: number
  /** Repeat the file to fill the video. */
  loop: boolean
  /** Turn the music down whenever the video has sound (a voice). */
  duck: boolean
}

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
}

export interface Project {
  clips: Clip[]
  overlays: Overlay[]
  music: Music | null
  camera: CameraTrack | null
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

/** Keeps every overlay inside the video, and music inside its file. */
export function tidy(p: Project): Project {
  const total = totalDuration(p.clips)
  const overlays = p.overlays
    .map((o) => ({ ...o, start: clamp(o.start, 0, Math.max(0, total - 0.1)), end: clamp(o.end, 0.1, total) }))
    .filter((o) => o.end - o.start >= 0.1)
  return { ...p, overlays }
}

/** Is there anything beyond the untouched recording? Decides between moving the file as-is and re-encoding. */
export function isPlain(p: Project, recordingDuration: number): boolean {
  if (p.overlays.length || p.music || p.crop || (p.camera && p.camera.visible)) return false
  if (p.clips.length !== 1) return false
  const c = p.clips[0]
  return c.kind === 'recording' && c.volume === 1 && c.in <= 0.01 && c.out >= recordingDuration - 0.01
}

export function newProject(recording: { duration: number; width: number; height: number; hasAudio: boolean }): Project {
  return {
    clips: [
      {
        id: newId('c'), kind: 'recording', media: 'recording', name: 'Recording', in: 0, out: recording.duration, hasAudio: recording.hasAudio,
        volume: 1, transition: 'cut', transitionDur: 0.5, width: recording.width, height: recording.height
      }
    ],
    overlays: [],
    music: null,
    camera: null,
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
export function cameraPieces(p: Project): CameraPiece[] {
  const cam = p.camera
  if (!cam || !cam.visible) return []
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
