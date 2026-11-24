import { deleteClip, detachSound, duplicateClip, duplicateSound, insertClip, newId, splitAt, splitSound, type Clip, type Overlay, type Sound } from '../../shared/project.ts'
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

  /** Puts audio files under the video, each as a sound of its own (as many as are chosen). */
  async addMusic(list?: MediaInfo[]): Promise<void> {
    const picked = (list ?? (await api.pickMedia('music'))).filter((m) => m.kind === 'audio' || m.kind === 'video')
    if (!picked.length) return
    this.register(picked)
    const s = this.store
    const total = s.duration
    const hasVoice = s.project.clips.some((c) => c.kind !== 'image' && c.hasAudio) || !!s.project.camera?.hasAudio
    let last: Sound | null = null
    for (const m of picked) {
      const short = m.duration > 0 && m.duration < total
      const sound: Sound = {
        id: newId('s'), origin: 'music', media: m.id, name: m.name, duration: m.duration, offset: 0, start: 0,
        length: Math.max(0.5, short ? total : Math.min(total, m.duration)), volume: 0.4, fadeIn: 1, fadeOut: 2, loop: short, duck: hasVoice
      }
      s.edit((p) => ({ ...p, sounds: [...p.sounds, sound] }), { select: { kind: 'sound', id: sound.id } })
      last = sound
    }
    if (last) this.onReveal(last.start)
  }

  /** One picker for everything: videos and pictures go into the video, audio files go under it. */
  async addAny(list?: MediaInfo[]): Promise<void> {
    const picked = list ?? (await api.pickMedia('any'))
    if (!picked.length) return
    const audio = picked.filter((m) => m.kind === 'audio')
    const visual = picked.filter((m) => m.kind !== 'audio')
    if (visual.length) await this.addClips(visual)
    if (audio.length) await this.addMusic(audio)
  }

  removeSound(id: string): void {
    this.store.edit((p) => ({ ...p, sounds: p.sounds.filter((x) => x.id !== id) }), { select: null })
  }

  /** Takes the sound off the selected piece of video so it can be moved, cut, turned down or saved on its own. */
  detach(id: string): void {
    const s = this.store
    const r = detachSound(s.project, id)
    if (!r) return this.onNote('That piece has no sound to separate.')
    s.edit(() => r.project, { select: { kind: 'sound', id: r.sound.id } })
  }

  /** Saves one piece (the video without sound, just the sound, or the camera) as its own file. */
  async saveAsset(what: 'video' | 'audio' | 'camera-video' | 'camera-audio', id: string): Promise<void> {
    const s = this.store
    let spec: { media: string; from: number; to: number; what: 'video' | 'audio'; name: string } | null = null
    if (what === 'video' || what === 'audio') {
      const c = s.project.clips.find((x) => x.id === id)
      if (c && c.kind !== 'image') spec = { media: c.media, from: c.in, to: c.out, what, name: c.name }
      const snd = s.project.sounds.find((x) => x.id === id)
      if (snd) spec = { media: snd.media, from: snd.offset, to: snd.offset + Math.min(snd.length, Math.max(0.1, snd.duration - snd.offset)), what: 'audio', name: snd.name }
    } else if (s.project.camera) {
      const cam = s.project.camera
      spec = { media: cam.media, from: 0, to: cam.duration, what: what === 'camera-audio' ? 'audio' : 'video', name: 'Face camera' }
    }
    if (!spec) return this.onNote('Choose something with sound or video first.')
    const r = await api.saveAsset(spec)
    if (r.error) this.onNote(r.error)
    else if (r.path) this.onNote(`Saved: ${r.path}`)
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
    if (s.selection?.kind === 'sound') {
      const r = splitSound(s.project, s.selection.id, t)
      if (!r) return this.onNote('Move the playhead into the sound first — you can’t cut right at an edge.')
      s.edit(() => r.project, { select: { kind: 'sound', id: r.select } })
      return
    }
    const e = splitAt(s.project, t)
    if (!e) return this.onNote('Move the playhead into a clip first — you can’t cut right at an edge.')
    s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : null })
  }

  /** Deletes whatever is selected (a clip closes the gap; an overlay or a sound just goes). */
  deleteSelected(): void {
    const s = this.store
    const sel = s.selection
    if (!sel) return this.onNote('Click a piece of the video, a comment or a sound first, then delete it.')
    if (sel.kind === 'clip') {
      const e = deleteClip(s.project, sel.id)
      if (!e) return this.onNote('That is the only piece of video, so it can’t be removed.')
      s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : null })
    } else if (sel.kind === 'overlay') s.edit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== sel.id) }), { select: null })
    else if (sel.kind === 'sound') this.removeSound(sel.id)
  }

  duplicate(): void {
    const s = this.store
    if (s.selection?.kind === 'clip') {
      const e = duplicateClip(s.project, s.selection.id)
      if (e) s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : null })
      return
    }
    if (s.selection?.kind === 'sound') {
      const r = duplicateSound(s.project, s.selection.id)
      if (r) s.edit(() => r.project, { select: { kind: 'sound', id: r.select } })
      return
    }
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
