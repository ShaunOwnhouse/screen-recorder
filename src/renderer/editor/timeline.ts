import {
  audioTracks, cameraPieces, clipEnd, clipLength, moveClip, moveSound, soundEnd, trackById, trimClip, trimSound, videoTracks, type Clip, type Overlay, type Sound, type Track
} from '../../shared/project.ts'
import { clampNum, fmtTime, type Store } from './store.ts'

export const overlayLabel = (o: Overlay): string => {
  switch (o.kind) {
    case 'bubble':
    case 'note':
    case 'text':
      return o.text.trim().slice(0, 40) || (o.kind === 'bubble' ? 'Comment' : o.kind === 'note' ? 'Note' : 'Text')
    case 'arrow':
      return 'Arrow'
    case 'box':
      return 'Highlight'
    case 'step':
      return `Step ${o.n}`
    case 'spotlight':
      return 'Spotlight'
    case 'blur':
      return o.mode === 'pixelate' ? 'Pixelate' : 'Blur / hide'
    case 'zoom':
      return 'Zoom in'
  }
}

const KIND_CLASS: Record<Overlay['kind'], string> = {
  bubble: 'k-comment', note: 'k-note', text: 'k-comment', arrow: 'k-shape', box: 'k-shape', step: 'k-step', spotlight: 'k-spot',
  blur: 'k-blur', zoom: 'k-zoom'
}

interface Deps {
  strip(mediaId: string): Promise<string>
  wave(mediaId: string): Promise<number[]>
  sourceLength(c: Clip): number | null
  setTrack(id: string, patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>): void
  addVideoTrack(): void
  addAudioTrack(): void
  removeTrack(id: string): void
}

const VIDEO_H = 56
const AUDIO_H = 46
const CAM_H = 40
const SNAP_PX = 8

const SVG: Record<string, string> = {
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.9 10.9 0 0112 5c7 0 11 7 11 7a18 18 0 01-3.2 4M6.1 6.1A18 18 0 001 12s4 7 11 7a10.9 10.9 0 005.4-1.5',
  speaker: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14',
  speakerOff: 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 017.5-2',
  close: 'M6 6l12 12M18 6L6 18'
}

function icon(name: keyof typeof SVG): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', SVG[name])
  svg.append(p)
  return svg
}

/** The strip under the video: every track, with its pieces, the comments and the face camera, all on one time line. */
export class Timeline {
  private readonly scroll: HTMLElement
  private readonly inner: HTMLElement
  private readonly labels: HTMLElement
  private readonly head: HTMLElement
  private strips = new Map<string, string>()
  private waves = new Map<string, number[]>()
  private asking = new Set<string>()
  private drag: ((e: PointerEvent) => void) | null = null
  private dragEnd: (() => void) | null = null

  constructor(
    private readonly store: Store,
    private readonly root: HTMLElement,
    private readonly deps: Deps
  ) {
    root.innerHTML = `
      <div class="tl-labels" id="tl-labels"></div>
      <div class="tl-scroll" id="tl-scroll">
        <div class="tl-inner" id="tl-inner">
          <div class="tl-ruler" id="tl-ruler"></div>
          <div id="tl-rows"></div>
          <div class="tl-head" id="tl-head"><span></span></div>
        </div>
      </div>`
    this.scroll = root.querySelector('#tl-scroll')!
    this.inner = root.querySelector('#tl-inner')!
    this.labels = root.querySelector('#tl-labels')!
    this.head = root.querySelector('#tl-head')!
    this.inner.addEventListener('pointerdown', (e) => this.down(e))
    window.addEventListener('pointermove', (e) => this.drag?.(e))
    window.addEventListener('pointerup', () => {
      this.dragEnd?.()
      this.drag = null
      this.dragEnd = null
      this.store.endMerge()
    })
    this.scroll.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          this.setZoom(this.store.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
        } else if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && !e.shiftKey && this.root.scrollHeight <= this.root.clientHeight) {
          this.scroll.scrollLeft += e.deltaY
          e.preventDefault()
        }
      },
      { passive: false }
    )
    store.on((what) => {
      if (what === 'playhead') this.movePlayhead()
      else if (what === 'project' || what === 'selection' || what === 'media') this.render()
    })
    this.render()
  }

  setZoom(px: number): void {
    this.store.pxPerSec = clampNum(px, 6, 400)
    this.render()
    this.store.emit('tool')
  }

  private x(t: number): number {
    return t * this.store.pxPerSec
  }

  private timeAt(clientX: number): number {
    const r = this.inner.getBoundingClientRect()
    return clampNum((clientX - r.left) / this.store.pxPerSec, 0, this.store.duration)
  }

  private movePlayhead(): void {
    const x = this.x(this.store.playhead)
    this.head.style.transform = `translateX(${x}px)`
    if (this.store.playing) {
      const view = this.scroll.clientWidth
      if (x > this.scroll.scrollLeft + view - 40 || x < this.scroll.scrollLeft) this.scroll.scrollLeft = Math.max(0, x - view * 0.2)
    }
  }

  // ---------- drawing ----------

  private label(text: string, height: number, id?: string): HTMLElement {
    const l = document.createElement('div')
    l.className = 'tl-label'
    if (id) l.id = id
    l.style.height = `${height}px`
    const n = document.createElement('span')
    n.className = 'tl-name'
    n.textContent = text
    l.append(n)
    return l
  }

  private trackLabel(t: Track, height: number, id: string | undefined, canRemove: boolean): HTMLElement {
    const l = this.label(t.name, height, id)
    l.dataset.track = t.id
    l.classList.toggle('off', t.hidden)
    const box = document.createElement('span')
    box.className = 'tl-ic'
    const btn = (name: string, title: string, on: boolean, iconName: keyof typeof SVG, patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>): HTMLElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `ic-btn${on ? ' on' : ''}`
      b.dataset.act = name
      b.title = title
      b.setAttribute('aria-pressed', String(on))
      b.append(icon(iconName))
      b.addEventListener('click', () => this.deps.setTrack(t.id, patch))
      return b
    }
    if (t.kind === 'video') box.append(btn('hide', t.hidden ? 'Show this track' : 'Hide this track (it is left out of the finished video)', t.hidden, t.hidden ? 'eyeOff' : 'eye', { hidden: !t.hidden }))
    box.append(btn('mute', t.muted ? 'Turn this track’s sound on' : 'Mute this track', t.muted, t.muted ? 'speakerOff' : 'speaker', { muted: !t.muted }))
    box.append(btn('lock', t.locked ? 'Unlock this track' : 'Lock this track so nothing on it can be changed', t.locked, t.locked ? 'lock' : 'unlock', { locked: !t.locked }))
    if (canRemove) {
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'ic-btn rm'
      x.dataset.act = 'remove'
      x.title = 'Remove this empty track'
      x.append(icon('close'))
      x.addEventListener('click', () => this.deps.removeTrack(t.id))
      box.append(x)
    }
    l.append(box)
    return l
  }

  render(): void {
    const s = this.store
    const px = s.pxPerSec
    const total = s.duration
    const width = Math.max(this.scroll.clientWidth, this.x(total) + 160)
    this.inner.style.width = `${width}px`
    this.inner.style.setProperty('--px', `${px}px`)
    const p = s.project

    // ruler
    const ruler = this.root.querySelector<HTMLElement>('#tl-ruler')!
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((v) => v * px >= 70) ?? 600
    const ticks: HTMLElement[] = []
    for (let t = 0; t <= width / px + step; t += step) {
      const d = document.createElement('div')
      d.className = 'tick'
      d.style.left = `${this.x(t)}px`
      d.textContent = fmtTime(t, step < 1)
      ticks.push(d)
    }
    ruler.replaceChildren(...ticks)

    const labels: HTMLElement[] = []
    const rows: HTMLElement[] = []
    const row = (cls: string, height: number, track?: Track): HTMLElement => {
      const r = document.createElement('div')
      r.className = `tl-track ${cls}${track?.locked ? ' locked' : ''}${track?.hidden ? ' off' : ''}`
      r.style.height = `${height}px`
      if (track) {
        r.dataset.track = track.id
        r.dataset.kind = track.kind
      }
      return r
    }

    // the label for the ruler: the "+" for a new video track lives here, above the video tracks
    const top = this.label('', 24)
    top.classList.add('ruler-label')
    const addV = document.createElement('button')
    addV.type = 'button'
    addV.id = 'add-video-track'
    addV.className = 'plus-btn'
    addV.title = 'Add another video track (a new row in front of the others)'
    addV.textContent = '+ Video track'
    addV.addEventListener('click', () => this.deps.addVideoTrack())
    top.querySelector('.tl-name')!.replaceWith(addV)
    labels.push(top)

    // video tracks, the one in front first
    const vts = videoTracks(p)
    vts.forEach((t, i) => {
      const empty = !p.clips.some((c) => c.track === t.id)
      labels.push(this.trackLabel(t, VIDEO_H, i === vts.length - 1 ? 'label-video' : undefined, empty && vts.length > 1))
      const r = row('video', VIDEO_H, t)
      const blocks: HTMLElement[] = []
      for (const c of p.clips.filter((x) => x.track === t.id)) blocks.push(this.clipBlock(c, t))
      r.replaceChildren(...blocks)
      rows.push(r)
    })

    // the face camera: one bar for each stretch of the timeline that has it
    const cam = p.camera
    const showCam = !!cam && cam.visible
    if (showCam) {
      labels.push(this.label('Face cam', CAM_H, 'label-cam'))
      const r = row('cam', CAM_H)
      r.replaceChildren(
        ...cameraPieces(p).map((pc) => {
          const b = document.createElement('div')
          b.className = `blk cam-blk${s.selection?.kind === 'camera' ? ' sel' : ''}`
          b.dataset.camera = '1'
          b.style.left = `${this.x(pc.start)}px`
          b.style.width = `${Math.max(8, this.x(pc.end - pc.start))}px`
          const t = document.createElement('span')
          t.className = 'blk-label'
          t.textContent = 'Face camera'
          b.append(t)
          return b
        })
      )
      rows.push(r)
    }

    // comments and shapes in as few rows as will fit
    const lanes: number[] = []
    const laneOf = new Map<string, number>()
    for (const o of [...p.overlays].sort((a, b) => a.start - b.start)) {
      let lane = lanes.findIndex((end) => end <= o.start + 1e-6)
      if (lane < 0) lane = lanes.length
      lanes[lane] = o.end
      laneOf.set(o.id, lane)
    }
    const oRows = Math.max(1, lanes.length)
    const oHeight = oRows * 30 + 8
    labels.push(this.label('Comments', oHeight, 'label-over'))
    const orow = row('over', oHeight)
    orow.replaceChildren(
      ...p.overlays.map((o) => {
        const b = document.createElement('div')
        b.className = `blk over ${KIND_CLASS[o.kind]}${s.selection?.kind === 'overlay' && s.selection.id === o.id ? ' sel' : ''}`
        b.dataset.overlay = o.id
        b.style.left = `${this.x(o.start)}px`
        b.style.width = `${Math.max(10, this.x(o.end - o.start))}px`
        b.style.top = `${(laneOf.get(o.id) ?? 0) * 30 + 4}px`
        const t = document.createElement('span')
        t.className = 'blk-label'
        t.textContent = overlayLabel(o)
        b.append(t, handle('l', 'start'), handle('r', 'end'))
        return b
      })
    )
    rows.push(orow)

    // audio tracks
    const ats = audioTracks(p)
    ats.forEach((t, i) => {
      const empty = !p.sounds.some((x) => x.track === t.id)
      labels.push(this.trackLabel(t, AUDIO_H, i === 0 ? 'label-music' : undefined, empty && ats.length > 1))
      const r = row('audio', AUDIO_H, t)
      const blocks: HTMLElement[] = []
      for (const m of p.sounds.filter((x) => x.track === t.id)) blocks.push(this.soundBlock(m, t))
      if (!blocks.length) {
        const hint = document.createElement('div')
        hint.className = 'track-hint'
        hint.textContent = i === 0 && !p.sounds.length ? 'No sounds yet — choose “Add audio” to put songs or voices here' : 'Empty'
        blocks.push(hint)
      }
      r.replaceChildren(...blocks)
      rows.push(r)
    })

    // the "+" for a new audio track sits under the last audio track
    const bottom = this.label('', 30)
    bottom.classList.add('add-row')
    const addA = document.createElement('button')
    addA.type = 'button'
    addA.id = 'add-audio-track'
    addA.className = 'plus-btn'
    addA.title = 'Add another audio track (a new row under the others)'
    addA.textContent = '+ Audio track'
    addA.addEventListener('click', () => this.deps.addAudioTrack())
    bottom.querySelector('.tl-name')!.replaceWith(addA)
    labels.push(bottom)
    const spacer = row('spacer', 30)
    rows.push(spacer)

    this.labels.replaceChildren(...labels)
    this.root.querySelector<HTMLElement>('#tl-rows')!.replaceChildren(...rows)
    this.movePlayhead()
  }

  private clipBlock(c: Clip, t: Track): HTMLElement {
    const s = this.store
    const len = clipLength(c)
    const b = document.createElement('div')
    b.className = `blk clip${s.selection?.kind === 'clip' && s.selection.id === c.id ? ' sel' : ''}${t.locked ? ' locked' : ''}`
    b.dataset.clip = c.id
    b.style.left = `${this.x(c.start)}px`
    b.style.width = `${Math.max(6, this.x(len))}px`
    this.paintClipBackground(b, c)
    const label = document.createElement('span')
    label.className = 'blk-label'
    label.textContent = `${c.name} · ${fmtTime(len)}${c.speed !== 1 ? ` · ${Number(c.speed.toFixed(2))}×` : ''}`
    if (c.fadeIn.dur > 0.02) {
      const f = document.createElement('i')
      f.className = 'fade-zone'
      f.style.width = `${this.x(Math.min(c.fadeIn.dur, len / 2))}px`
      b.append(f)
    }
    if (c.fadeOut.dur > 0.02) {
      const f = document.createElement('i')
      f.className = 'fade-zone r'
      f.style.width = `${this.x(Math.min(c.fadeOut.dur, len / 2))}px`
      b.append(f)
    }
    b.append(label, handle('l', 'start'), handle('r', 'end'))
    return b
  }

  private soundBlock(m: Sound, t: Track): HTMLElement {
    const s = this.store
    const b = document.createElement('div')
    b.className = `blk music-blk${m.origin === 'split' ? ' split-blk' : ''}${s.selection?.kind === 'sound' && s.selection.id === m.id ? ' sel' : ''}${t.locked ? ' locked' : ''}`
    b.dataset.sound = m.id
    b.style.left = `${this.x(m.start)}px`
    b.style.width = `${Math.max(10, this.x(m.length))}px`
    const cv = document.createElement('canvas')
    cv.className = 'wave'
    cv.width = Math.max(10, Math.round(this.x(m.length)))
    cv.height = 36
    this.drawWave(cv, m.media, m.offset, m.duration, m.length * m.speed, m.loop)
    const label = document.createElement('span')
    label.className = 'blk-label'
    label.textContent = `${m.name} · ${Math.round(m.volume * 100)}%${m.speed !== 1 ? ` · ${Number(m.speed.toFixed(2))}×` : ''}${m.duck ? ' · quieter under voice' : ''}`
    b.append(cv, label, handle('l', 'start'), handle('r', 'end'))
    return b
  }

  private paintClipBackground(b: HTMLElement, c: Clip): void {
    if (c.card) {
      b.style.background = `linear-gradient(${c.card.bg[0]}, ${c.card.bg[1]})`
      return
    }
    if (c.kind === 'image') {
      const url = this.store.media.get(c.media)?.url
      if (url) b.style.background = `center / cover url("${url}")`
      return
    }
    const len = this.deps.sourceLength(c)
    const want = this.strips.get(c.media)
    if (want && len) {
      const px = this.store.pxPerSec / c.speed
      b.style.backgroundImage = `url("${want}")`
      b.style.backgroundSize = `${len * px}px 100%`
      b.style.backgroundPosition = `${-c.in * px}px 0`
      b.style.backgroundRepeat = 'no-repeat'
    } else if (!this.asking.has(c.media)) {
      this.asking.add(c.media)
      void this.deps.strip(c.media).then((url) => {
        if (url) {
          this.strips.set(c.media, url)
          this.render()
        }
      })
    }
  }

  private drawWave(cv: HTMLCanvasElement, media: string, offset: number, fileLen: number, len: number, loop: boolean): void {
    const peaks = this.waves.get(media)
    if (!peaks) {
      if (!this.asking.has(`w:${media}`)) {
        this.asking.add(`w:${media}`)
        void this.deps.wave(media).then((p) => {
          if (p.length) {
            this.waves.set(media, p)
            this.render()
          }
        })
      }
      return
    }
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = 'rgba(134, 239, 172, 0.85)'
    const mid = cv.height / 2
    for (let x = 0; x < cv.width; x += 3) {
      let pos = offset + (x / cv.width) * len
      if (loop && fileLen > 0) pos %= fileLen
      const i = clampNum(Math.floor((pos / Math.max(0.01, fileLen)) * peaks.length), 0, peaks.length - 1)
      const h = Math.max(2, peaks[i] * (cv.height - 4))
      ctx.fillRect(x, mid - h / 2, 2, h)
    }
  }

  // ---------- pointer ----------

  /** Snaps a time to the playhead, to the start or end of another piece or sound, or to the start of the video. */
  private snapTime(t: number, ignore?: string, ignorePlayhead = false): number {
    const s = this.store
    const near = SNAP_PX / s.pxPerSec
    const cands: number[] = [0]
    if (!ignorePlayhead) cands.push(s.playhead)
    for (const c of s.project.clips) if (c.id !== ignore) cands.push(c.start, clipEnd(c))
    for (const m of s.project.sounds) if (m.id !== ignore) cands.push(m.start, soundEnd(m))
    let best = t
    let bd = near
    for (const c of cands) {
      const d = Math.abs(c - t)
      if (d < bd) {
        bd = d
        best = c
      }
    }
    return best === t ? s.snap(t) : best
  }

  /** Snaps a piece that is being slid: its start or its end lands on a neighbour if either is close. */
  private snapSpan(start: number, len: number, ignore: string): number {
    const a = this.snapTime(start, ignore)
    const b = this.snapTime(start + len, ignore)
    const near = SNAP_PX / this.store.pxPerSec
    const da = Math.abs(a - start)
    const db = Math.abs(b - (start + len))
    if (da <= near && da <= db && a !== this.store.snap(start)) return a
    if (db <= near && b !== this.store.snap(start + len)) return b - len
    return this.store.snap(start)
  }

  /** The tracks of one kind with where they are on the screen, for dropping a piece onto another row. */
  private rowRects(kind: 'video' | 'audio'): Array<{ id: string; top: number; bottom: number }> {
    return [...this.root.querySelectorAll<HTMLElement>(`.tl-track[data-kind="${kind}"]`)].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.track!, top: r.top, bottom: r.bottom }
    })
  }

  private rowAt(rows: Array<{ id: string; top: number; bottom: number }>, y: number): string {
    const hit = rows.find((r) => y >= r.top && y < r.bottom)
    if (hit) return hit.id
    return (y < rows[0].top ? rows[0] : rows[rows.length - 1]).id
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return
    const s = this.store
    const target = e.target as HTMLElement
    const edgeEl = target.closest<HTMLElement>('[data-edge]')
    const blk = target.closest<HTMLElement>('.blk')
    const startX = e.clientX
    const startY = e.clientY
    const base = s.project

    if (blk?.dataset.clip) {
      const id = blk.dataset.clip
      s.select({ kind: 'clip', id })
      const clip = base.clips.find((c) => c.id === id)!
      if (trackById(base, clip.track)?.locked) {
        e.preventDefault()
        return
      }
      if (edgeEl) {
        const edge = edgeEl.dataset.edge as 'start' | 'end'
        const len = this.deps.sourceLength(clip)
        const origin = edge === 'start' ? clip.start : clipEnd(clip)
        this.drag = (ev) => {
          const to = this.snapTime(origin + (ev.clientX - startX) / s.pxPerSec, id)
          const next = trimClip(base, id, edge, to, len)
          if (next && next !== s.project) s.edit(() => next, { merge: `trim:${id}:${edge}` })
        }
      } else {
        const rows = this.rowRects('video')
        const dur = clipLength(clip)
        let moved = false
        this.drag = (ev) => {
          if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
          moved = true
          const want = this.snapSpan(Math.max(0, clip.start + (ev.clientX - startX) / s.pxPerSec), dur, id)
          const next = moveClip(base, id, this.rowAt(rows, ev.clientY), want)
          if (next && next !== s.project) s.edit(() => next, { merge: `move:${id}` })
        }
      }
      e.preventDefault()
      return
    }

    if (blk?.dataset.overlay) {
      const id = blk.dataset.overlay
      s.select({ kind: 'overlay', id })
      const o = base.overlays.find((x) => x.id === id)!
      const total = s.duration
      const apply = (start: number, end: number): void =>
        s.edit((p) => ({ ...p, overlays: p.overlays.map((x) => (x.id === id ? { ...x, start, end } : x)) }), { merge: `time:${id}` })
      this.drag = (ev) => {
        const dt = (ev.clientX - startX) / s.pxPerSec
        if (edgeEl?.dataset.edge === 'start') apply(clampNum(this.snapTime(o.start + dt, id), 0, o.end - 0.1), o.end)
        else if (edgeEl?.dataset.edge === 'end') apply(o.start, clampNum(this.snapTime(o.end + dt, id), o.start + 0.1, total))
        else {
          const len = o.end - o.start
          const start = clampNum(this.snapSpan(o.start + dt, len, id), 0, Math.max(0, total - len))
          apply(start, start + len)
        }
      }
      e.preventDefault()
      return
    }

    if (blk?.dataset.camera) {
      s.select({ kind: 'camera', id: 'camera' })
      e.preventDefault()
      return
    }

    if (blk?.dataset.sound) {
      const id = blk.dataset.sound
      s.select({ kind: 'sound', id })
      const m = base.sounds.find((x) => x.id === id) as Sound
      if (trackById(base, m.track)?.locked) {
        e.preventDefault()
        return
      }
      if (edgeEl) {
        const edge = edgeEl.dataset.edge as 'start' | 'end'
        const origin = edge === 'start' ? m.start : soundEnd(m)
        this.drag = (ev) => {
          const to = this.snapTime(origin + (ev.clientX - startX) / s.pxPerSec, id)
          const next = trimSound(base, id, edge, to)
          if (next && next !== s.project) s.edit(() => next, { merge: `strim:${id}:${edge}` })
        }
      } else {
        const rows = this.rowRects('audio')
        let moved = false
        this.drag = (ev) => {
          if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
          moved = true
          const want = this.snapSpan(Math.max(0, m.start + (ev.clientX - startX) / s.pxPerSec), m.length, id)
          const next = moveSound(base, id, this.rowAt(rows, ev.clientY), want)
          if (next && next !== s.project) s.edit(() => next, { merge: `sound-move:${id}` })
        }
      }
      e.preventDefault()
      return
    }

    // empty space: move the playhead here and let go of whatever was selected
    s.select(null)
    s.setPlaying(false)
    s.seek(this.snapTime(this.timeAt(e.clientX), undefined, true))
    this.drag = (ev) => s.seek(this.snapTime(this.timeAt(ev.clientX), undefined, true))
    e.preventDefault()
  }

  /** Brings a time into view (after adding something at the playhead, for instance). */
  reveal(t: number): void {
    const x = this.x(t)
    if (x < this.scroll.scrollLeft || x > this.scroll.scrollLeft + this.scroll.clientWidth - 60) this.scroll.scrollLeft = Math.max(0, x - 80)
  }
}

function handle(side: 'l' | 'r', edge: 'start' | 'end'): HTMLElement {
  const h = document.createElement('i')
  h.className = `edge ${side}`
  h.dataset.edge = edge
  return h
}
