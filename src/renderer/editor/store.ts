import { layout, tidy, totalDuration, type CameraTrack, type Clip, type Overlay, type Project, type Sound } from '../../shared/project.ts'
import type { Brand, MediaInfo, RecordingMeta } from '../../shared/types.ts'

export type Tool = 'comments' | 'shapes' | 'media' | 'music' | 'titles' | 'cut' | 'crop'
export type Selection = { kind: 'clip' | 'overlay' | 'sound' | 'camera'; id: string } | null
export type Change = 'project' | 'selection' | 'playhead' | 'tool' | 'brand' | 'media' | 'play'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Everything the editor knows right now, with undo/redo. Screens listen for changes and redraw themselves. */
export class Store {
  project: Project
  selection: Selection = null
  playhead = 0
  playing = false
  /** Timeline zoom: pixels per second. */
  pxPerSec = 48
  tool: Tool = 'comments'
  cropMode = false
  brand: Brand
  readonly media = new Map<string, MediaInfo>()
  private past: Project[] = []
  private future: Project[] = []
  private lastMerge: { key: string; at: number } | null = null
  private listeners = new Set<(what: Change) => void>()

  constructor(
    initial: Project,
    readonly recording: RecordingMeta,
    brand: Brand
  ) {
    this.project = initial
    this.brand = brand
  }

  on(fn: (what: Change) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(what: Change): void {
    for (const fn of this.listeners) fn(what)
  }

  get fps(): number {
    return Math.max(1, Math.round(this.recording.fps || 30))
  }

  get duration(): number {
    return totalDuration(this.project.clips)
  }

  /** Rounds a time to a whole video frame, so cuts land exactly on one. */
  snap(t: number): number {
    return Math.round(t * this.fps) / this.fps
  }

  /** Width ÷ height of the finished video (the whole recording while the crop is being drawn). */
  get aspect(): number {
    const r = this.recording
    const c = this.project.crop
    if (!c || this.cropMode) return r.width / r.height
    return (c.width * r.width) / (c.height * r.height)
  }

  /** Size of the finished video in pixels. */
  get outputSize(): { width: number; height: number } {
    const r = this.recording
    const c = this.project.crop
    const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
    if (!c) return { width: even(r.width), height: even(r.height) }
    return { width: even(c.width * r.width), height: even(c.height * r.height) }
  }

  get selectedOverlay(): Overlay | null {
    return this.selection?.kind === 'overlay' ? (this.project.overlays.find((o) => o.id === this.selection!.id) ?? null) : null
  }

  /** Changes some fields of one overlay as one undo step (merged with the changes just before it when `merge` matches). */
  patchOverlay(id: string, patch: Record<string, unknown>, merge?: string): void {
    this.edit((p) => ({ ...p, overlays: p.overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) }), { merge })
  }

  patchCamera(patch: Partial<CameraTrack>, merge?: string): void {
    this.edit((p) => (p.camera ? { ...p, camera: { ...p.camera, ...patch } } : null), { merge })
  }

  patchSound(id: string, patch: Partial<Sound>, merge?: string): void {
    this.edit((p) => ({ ...p, sounds: p.sounds.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), { merge })
  }

  get selectedSound(): Sound | null {
    return this.selection?.kind === 'sound' ? (this.project.sounds.find((x) => x.id === this.selection!.id) ?? null) : null
  }

  patchClip(id: string, patch: Partial<Clip>, merge?: string): void {
    this.edit((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), { merge })
  }

  get selectedClip(): Clip | null {
    return this.selection?.kind === 'clip' ? (this.project.clips.find((c) => c.id === this.selection!.id) ?? null) : null
  }

  select(sel: Selection): void {
    if (sel?.kind === this.selection?.kind && sel?.id === this.selection?.id) return
    this.selection = sel
    this.emit('selection')
  }

  setTool(tool: Tool): void {
    this.tool = tool
    if (tool !== 'crop' && this.cropMode) this.cropMode = false
    if (tool === 'crop') this.cropMode = true
    this.emit('tool')
    this.emit('project')
  }

  seek(t: number): void {
    this.playhead = clamp(t, 0, this.duration)
    this.emit('playhead')
  }

  setPlaying(on: boolean): void {
    if (this.playing === on) return
    this.playing = on
    this.emit('play')
  }

  /**
   * Changes the project as one undo step. `merge` joins quick repeated changes (typing, dragging a slider) into one step.
   * Return null from `fn` to do nothing.
   */
  edit(fn: (p: Project) => Project | null, opts: { select?: Selection; merge?: string } = {}): void {
    const next = fn(this.project)
    if (!next || next === this.project) return
    const now = Date.now()
    const joined = opts.merge && this.lastMerge && this.lastMerge.key === opts.merge && now - this.lastMerge.at < 900
    if (!joined) {
      this.past.push(this.project)
      if (this.past.length > 200) this.past.shift()
    }
    this.lastMerge = opts.merge ? { key: opts.merge, at: now } : null
    this.future = []
    this.project = tidy(next)
    if (opts.select !== undefined) this.selection = opts.select
    this.fixSelection()
    this.seek(this.playhead)
    this.emit('project')
    if (opts.select !== undefined) this.emit('selection')
  }

  /** Closes a run of merged changes, so the next one is a new undo step. */
  endMerge(): void {
    this.lastMerge = null
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): void {
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(this.project)
    this.project = prev
    this.lastMerge = null
    this.fixSelection()
    this.seek(this.playhead)
    this.emit('project')
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.project)
    this.project = next
    this.lastMerge = null
    this.fixSelection()
    this.seek(this.playhead)
    this.emit('project')
  }

  private fixSelection(): void {
    const s = this.selection
    if (!s) return
    const exists =
      s.kind === 'clip'
        ? this.project.clips.some((c) => c.id === s.id)
        : s.kind === 'overlay'
          ? this.project.overlays.some((o) => o.id === s.id)
          : s.kind === 'camera'
            ? !!this.project.camera?.visible
            : this.project.sounds.some((x) => x.id === s.id)
    if (!exists) {
      this.selection = null
      this.emit('selection')
    }
  }

  /** The clip (and where it sits) that the playhead is in. */
  placedNow(): ReturnType<typeof layout>[number] | null {
    const placed = layout(this.project.clips)
    let hit = placed[0] ?? null
    for (const p of placed) if (this.playhead >= p.start - 1e-6) hit = p
    return hit
  }
}

export function fmtTime(t: number, tenths = true): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return tenths ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`
}

export const clampNum = clamp
