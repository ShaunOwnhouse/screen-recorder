import { deleteClip, insertClip, newId, splitAt, type Clip, type Music, type Overlay } from '../../shared/project.ts'
import type { MediaInfo } from '../../shared/types.ts'
import { CARD_STYLES, newCardClip, newClipFrom, newOverlay, newPip, type NewKind } from './defaults.ts'
import type { Store } from './store.ts'

const api = window.editor

/** Things the person can do, shared by the buttons, the menus and the keyboard. */
export class Actions {
  /** Called when something was added at a time, so the time line can bring it into view. */
  onReveal: (t: number) => void = () => undefined
  /** Called when a message for the person is worth showing on the stage. */
  onNote: (text: string) => void = () => undefined

  constructor(private readonly store: Store) {}

  addOverlay(kind: NewKind): void {
    const o = newOverlay(kind, this.store)
    this.store.edit((p) => ({ ...p, overlays: [...p.overlays, o] }), { select: { kind: 'overlay', id: o.id } })
    this.store.seek(Math.max(o.start + 0.05, this.store.playhead))
    this.onReveal(o.start)
  }

  private register(list: MediaInfo[]): void {
    for (const m of list) this.store.media.set(m.id, m)
    if (list.length) this.store.emit('media')
  }

  /** Asks for videos or pictures and puts them into the video, one after another, at the playhead. */
  async addClips(list?: MediaInfo[]): Promise<void> {
    const picked = list ?? (await api.pickMedia('clip'))
    if (!picked.length) return
    this.register(picked)
    const s = this.store
    let at = s.playhead
    let last: Clip | null = null
    for (const m of picked) {
      const clip = newClipFrom(s, m)
      s.edit((p) => insertClip(p, clip, at).project, { select: { kind: 'clip', id: clip.id } })
      at += clip.out - clip.in
      last = clip
    }
    if (last) this.onReveal(s.playhead)
  }

  async addPip(): Promise<void> {
    const picked = await api.pickMedia('clip')
    const m = picked[0]
    if (!m) return
    this.register([m])
    const o = newPip(this.store, m)
    this.store.edit((p) => ({ ...p, overlays: [...p.overlays, o] }), { select: { kind: 'overlay', id: o.id } })
    this.store.seek(o.start + 0.05)
    this.onReveal(o.start)
  }

  async addMusic(list?: MediaInfo[]): Promise<void> {
    const [m] = list ?? (await api.pickMedia('music'))
    if (!m) return
    this.register([m])
    const hasVoice = this.store.project.clips.some((c) => c.kind !== 'image' && c.hasAudio)
    const music: Music = {
      media: m.id, name: m.name, duration: m.duration, offset: 0, start: 0, volume: 0.4, fadeIn: 1, fadeOut: 2, loop: true, duck: hasVoice
    }
    this.store.edit((p) => ({ ...p, music }), { select: { kind: 'music', id: 'music' } })
  }

  removeMusic(): void {
    this.store.edit((p) => ({ ...p, music: null }), { select: null })
  }

  addTitle(styleId: string): void {
    const style = CARD_STYLES.find((c) => c.id === styleId) ?? CARD_STYLES[0]
    const clip = newCardClip(this.store, style)
    this.store.edit((p) => insertClip(p, clip, this.store.playhead).project, { select: { kind: 'clip', id: clip.id } })
    this.onReveal(this.store.playhead)
  }

  split(): void {
    const s = this.store
    const t = s.snap(s.playhead)
    const e = splitAt(s.project, t)
    if (!e) return this.onNote('Move the playhead into a clip first — you can’t cut right at an edge.')
    s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : null })
  }

  /** Deletes whatever is selected (a clip closes the gap; an overlay or the music just goes). */
  deleteSelected(): void {
    const s = this.store
    const sel = s.selection
    if (!sel) return this.onNote('Click a piece of the video, a comment or the music first, then delete it.')
    if (sel.kind === 'clip') {
      const e = deleteClip(s.project, sel.id)
      if (!e) return this.onNote('That is the only piece of video, so it can’t be removed.')
      s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : null })
    } else if (sel.kind === 'overlay') s.edit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== sel.id) }), { select: null })
    else this.removeMusic()
  }

  duplicate(): void {
    const s = this.store
    const o = s.selectedOverlay
    if (!o) return
    const len = o.end - o.start
    const start = Math.min(Math.max(0, s.duration - len), o.end + 0.1)
    const copy = { ...JSON.parse(JSON.stringify(o)), id: newId('o'), start, end: start + len } as Overlay
    if ('x' in copy && 'y' in copy && copy.kind !== 'step') {
      copy.x = Math.min(0.9, copy.x + 0.03)
      copy.y = Math.min(0.9, copy.y + 0.03)
    }
    s.edit((p) => ({ ...p, overlays: [...p.overlays, copy] }), { select: { kind: 'overlay', id: copy.id } })
    s.seek(copy.start + 0.05)
  }
}
