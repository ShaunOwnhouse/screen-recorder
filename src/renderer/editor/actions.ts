import {
  activeClips, addAudioTrack, addCameraClip, addClip, addSound, addVideoTrack, clipEnd, deleteClip, detachSound, duplicateClip, duplicateSound, freezeFrame, insertClipPushing, newId, patchTrack,
  isFloating, removeTrack, setClipSpeed, setSoundSpeed, splitAt, splitSound, trackById, type Clip, type Overlay, type Sound, type Track
} from '../../shared/project.ts'
import type { MediaInfo } from '../../shared/types.ts'
import { CARD_STYLES, newCardClip, newClipFrom, newOverlay, newPipClip, type NewKind } from './defaults.ts'
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

  /**
   * Asks for videos or pictures and puts them on the timeline at the playhead: on the track that has room (so a sequence
   * builds up on one row), or on a new track in front. With `push`, everything after the playhead moves later to make room.
   */
  async addClips(list?: MediaInfo[], push = false): Promise<void> {
    const picked = list ?? (await api.pickMedia('clip'))
    if (!picked.length) return
    this.register(picked)
    const s = this.store
    let at = s.playhead
    for (const m of picked) {
      const clip = newClipFrom(s, m)
      let placed: Clip | undefined
      s.edit(
        (p) => {
          const e = push ? insertClipPushing(p, clip, at) : addClip(p, clip, at)
          placed = e.project.clips.find((c) => c.id === e.select)
          return e.project
        },
        { select: { kind: 'clip', id: clip.id } }
      )
      if (placed) at = clipEnd(placed)
    }
    this.onReveal(s.playhead)
  }

  /** A video or picture in a small window over the video (on a track of its own). */
  async addPip(): Promise<void> {
    const picked = await api.pickMedia('clip')
    const m = picked[0]
    if (!m) return
    this.register([m])
    const s = this.store
    const clip = newPipClip(s, m)
    s.edit(
      (p) => {
        const r = addVideoTrack(p)
        return { ...r.project, clips: [...r.project.clips, { ...clip, track: r.track.id, start: s.playhead }] }
      },
      { select: { kind: 'clip', id: clip.id } }
    )
    this.onReveal(s.playhead)
  }

  /** Puts audio files under the video, each as a sound of its own (as many as are chosen). */
  async addMusic(list?: MediaInfo[]): Promise<void> {
    const picked = (list ?? (await api.pickMedia('music'))).filter((m) => m.kind === 'audio' || m.kind === 'video')
    if (!picked.length) return
    this.register(picked)
    const s = this.store
    const total = s.duration
    const hasVoice = s.project.clips.some((c) => c.kind !== 'image' && c.hasAudio) 
    let last: Sound | null = null
    for (const m of picked) {
      const short = m.duration > 0 && m.duration < total
      const base: Omit<Sound, 'track'> = {
        id: newId('s'), origin: 'music', media: m.id, name: m.name, duration: m.duration, offset: 0, start: 0, speed: 1,
        length: Math.max(0.5, short ? total : Math.min(total, m.duration)), volume: 0.4, fadeIn: 1, fadeOut: 2, loop: short, duck: hasVoice
      }
      s.edit(
        (p) => {
          const r = addSound(p, base)
          last = r.sound
          return r.project
        },
        { select: { kind: 'sound', id: base.id } }
      )
    }
    if (last) this.onReveal((last as Sound).start)
  }

  /** One picker for everything: videos and pictures go onto the timeline, audio files go under it. */
  async addAny(list?: MediaInfo[], push = false): Promise<void> {
    const picked = list ?? (await api.pickMedia('any'))
    if (!picked.length) return
    const audio = picked.filter((m) => m.kind === 'audio')
    const visual = picked.filter((m) => m.kind !== 'audio')
    if (visual.length) await this.addClips(visual, push)
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

  /** Puts the camera recording back on the timeline (on a track of its own, lined up with the screen recording). */
  addCamera(): void {
    const s = this.store
    const m = s.media.get('camera')
    if (!m) return
    s.edit((p) => {
      const r = addCameraClip(p, { media: m.id, name: 'Face camera', duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio }, s.cameraOffset, s.aspect)
      return r ? r.project : null
    })
  }

  /** The camera's microphone is the voice (the screen recording keeps only its computer sound) — or the screen's microphone is, and the camera goes silent. */
  setCameraVoice(id: string, on: boolean): void {
    const s = this.store
    const camHasAudio = !!s.media.get('camera')?.hasAudio
    s.edit((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id === id) return { ...c, hasAudio: on && camHasAudio }
        if (c.kind === 'recording') return { ...c, audioSource: on ? (p.recTracks.pc ? ('pc' as const) : ('none' as const)) : ('mix' as const) }
        return c
      })
    }))
  }

  /** Saves one piece (the video without sound, or just the sound) as its own file. */
  async saveAsset(what: 'video' | 'audio', id: string): Promise<void> {
    const s = this.store
    let spec: { media: string; from: number; to: number; what: 'video' | 'audio'; name: string } | null = null
    const c = s.project.clips.find((x) => x.id === id)
    if (c && c.kind !== 'image') spec = { media: c.media, from: c.in, to: c.out, what, name: c.name }
    const snd = s.project.sounds.find((x) => x.id === id)
    if (snd) spec = { media: snd.media, from: snd.offset, to: snd.offset + Math.min(snd.length * snd.speed, Math.max(0.1, snd.duration - snd.offset)), what: 'audio', name: snd.name }
    if (!spec) return this.onNote('Choose something with sound or video first.')
    const r = await api.saveAsset(spec)
    if (r.error) this.onNote(r.error)
    else if (r.path) this.onNote(`Saved: ${r.path}`)
  }

  addTitle(styleId: string): void {
    const style = CARD_STYLES.find((c) => c.id === styleId) ?? CARD_STYLES[0]
    const clip = newCardClip(this.store, style)
    this.store.edit((p) => addClip(p, clip, this.store.playhead).project, { select: { kind: 'clip', id: clip.id } })
    this.onReveal(this.store.playhead)
  }

  // ---------- tracks ----------

  newVideoTrack(): void {
    this.store.edit((p) => addVideoTrack(p).project)
  }

  newAudioTrack(): void {
    this.store.edit((p) => addAudioTrack(p).project)
  }

  setTrack(id: string, patch: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>>): void {
    this.store.edit((p) => patchTrack(p, id, patch), { merge: `track:${id}:${Object.keys(patch)[0]}` })
  }

  deleteTrack(id: string): void {
    const next = removeTrack(this.store.project, id)
    if (!next) return this.onNote('Only an empty track can be removed (one of each kind always stays).')
    this.store.edit(() => next)
  }

  // ---------- cutting, copying, removing ----------

  split(): void {
    const s = this.store
    const t = s.snap(s.playhead)
    if (s.selection?.kind === 'sound') {
      const r = splitSound(s.project, s.selection.id, t)
      if (!r) return this.onNote('Move the playhead into the sound first — you can’t cut right at an edge.')
      s.edit(() => r.project, { select: { kind: 'sound', id: r.select } })
      return
    }
    const sel = s.selection?.kind === 'clip' ? s.selection.id : undefined
    const e = splitAt(s.project, t, sel)
    if (!e) return this.onNote('Move the playhead into a piece first — you can’t cut right at an edge.')
    s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : s.selection })
  }

  /** How long the next freeze frame holds, in seconds (set in the piece's settings, used by every freeze button). */
  freezeHold = 2

  /**
   * Freezes the picture at the playhead for `hold` seconds: takes a still of that exact moment and puts it between the two halves
   * of the piece (everything after moves later). It is the selected piece when that is showing at the playhead, otherwise the
   * piece in front of the screen (not a small window) that is playing there.
   */
  async freeze(hold = this.freezeHold): Promise<void> {
    const s = this.store
    const p = s.project
    const t = s.snap(s.playhead)
    const usable = (c: Clip): boolean => {
      const tr = trackById(p, c.track)
      return c.kind !== 'image' && !c.card && t > c.start + 0.1 && t < clipEnd(c) - 0.1 && !!tr && !tr.locked && !tr.hidden
    }
    const showing = activeClips(p, t).filter(usable).reverse()
    const c = s.selectedClip && usable(s.selectedClip) ? s.selectedClip : (showing.find((k) => !isFloating(k)) ?? showing[0])
    if (!c) return this.onNote('Move the playhead onto the video first (not right at the start or end of a piece), then freeze.')
    const source = c.in + (t - c.start) * c.speed
    const got = await api.grabFrame({ media: c.kind === 'recording' ? 'recording' : c.media, time: source, crop: c.kind === 'recording' ? p.crop : null })
    if ('error' in got) return this.onNote(got.error)
    this.register([got])
    const e = freezeFrame(s.project, c.id, t, { media: got.id, name: got.name, width: got.width, height: got.height }, hold)
    if (!e) return this.onNote('That piece can’t be frozen here.')
    s.edit(() => e.project, { select: e.select ? { kind: 'clip', id: e.select } : s.selection })
    this.onReveal(t)
  }

  /** Deletes whatever is selected. A piece of video closes the gap on every track, unless `ripple` is off (then it leaves a gap). */
  deleteSelected(ripple = true): void {
    const s = this.store
    const sel = s.selection
    if (!sel) return this.onNote('Click a piece of the video, a comment or a sound first, then delete it.')
    if (sel.kind === 'clip') {
      const e = deleteClip(s.project, sel.id, ripple)
      if (!e) return this.onNote('That is the only piece of video, so it can’t be removed.')
      s.edit(() => e.project, { select: null })
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

  /** Plays the selected piece or sound faster or slower. */
  setSpeed(speed: number): void {
    const s = this.store
    const sel = s.selection
    if (sel?.kind === 'clip') s.edit((p) => setClipSpeed(p, sel.id, speed), { merge: `speed:${sel.id}` })
    else if (sel?.kind === 'sound') s.edit((p) => setSoundSpeed(p, sel.id, speed), { merge: `speed:${sel.id}` })
  }
}
