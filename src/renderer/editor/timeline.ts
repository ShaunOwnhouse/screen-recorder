import { layout, moveClip, trimClip, type Clip, type Overlay } from '../../shared/project.ts'
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
    case 'pip':
      return o.name
    case 'zoom':
      return 'Zoom in'
  }
}

const KIND_CLASS: Record<Overlay['kind'], string> = {
  bubble: 'k-comment', note: 'k-note', text: 'k-comment', arrow: 'k-shape', box: 'k-shape', step: 'k-step', spotlight: 'k-spot',
  blur: 'k-blur', pip: 'k-pip', zoom: 'k-zoom'
}

interface Deps {
  strip(mediaId: string): Promise<string>
  wave(mediaId: string): Promise<number[]>
  sourceLength(c: Clip): number | null
}

/** The strip under the video: the clips, everything laid over them, and the music, all on one time line. */
export class Timeline {
  private readonly scroll: HTMLElement
  private readonly inner: HTMLElement
  private readonly ruler: HTMLElement
  private readonly trackVideo: HTMLElement
  private readonly trackOver: HTMLElement
  private readonly trackMusic: HTMLElement
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
      <div class="tl-labels">
        <div class="tl-label ruler-label"></div>
        <div class="tl-label" id="label-video">Video</div>
        <div class="tl-label" id="label-over">Comments</div>
        <div class="tl-label" id="label-music">Music</div>
      </div>
      <div class="tl-scroll" id="tl-scroll">
        <div class="tl-inner" id="tl-inner">
          <div class="tl-ruler" id="tl-ruler"></div>
          <div class="tl-track video" id="track-video"></div>
          <div class="tl-track over" id="track-over"></div>
          <div class="tl-track music" id="track-music"></div>
          <div class="tl-head" id="tl-head"><span></span></div>
        </div>
      </div>`
    this.scroll = root.querySelector('#tl-scroll')!
    this.inner = root.querySelector('#tl-inner')!
    this.ruler = root.querySelector('#tl-ruler')!
    this.trackVideo = root.querySelector('#track-video')!
    this.trackOver = root.querySelector('#track-over')!
    this.trackMusic = root.querySelector('#track-music')!
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
        } else if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
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

  render(): void {
    const s = this.store
    const px = s.pxPerSec
    const total = s.duration
    const width = Math.max(this.scroll.clientWidth, this.x(total) + 120)
    this.inner.style.width = `${width}px`
    this.inner.style.setProperty('--px', `${px}px`)

    // ruler
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((v) => v * px >= 70) ?? 600
    const ticks: HTMLElement[] = []
    for (let t = 0; t <= width / px + step; t += step) {
      const d = document.createElement('div')
      d.className = 'tick'
      d.style.left = `${this.x(t)}px`
      d.textContent = fmtTime(t, step < 1)
      ticks.push(d)
    }
    this.ruler.replaceChildren(...ticks)

    // clips
    const placed = layout(s.project.clips)
    const blocks: HTMLElement[] = []
    placed.forEach((pl, i) => {
      const c = pl.clip
      const b = document.createElement('div')
      b.className = `blk clip${s.selection?.kind === 'clip' && s.selection.id === c.id ? ' sel' : ''}${pl.overlap > 0 ? ' fades' : ''}`
      b.dataset.clip = c.id
      b.style.left = `${this.x(pl.start)}px`
      b.style.width = `${Math.max(6, this.x(pl.end - pl.start))}px`
      b.style.zIndex = String(i + 1)
      this.paintClipBackground(b, c)
      const label = document.createElement('span')
      label.className = 'blk-label'
      label.textContent = `${c.name} · ${fmtTime(pl.end - pl.start)}`
      if (pl.overlap > 0) {
        const f = document.createElement('i')
        f.className = 'fade-zone'
        f.style.width = `${this.x(pl.overlap)}px`
        b.append(f)
      }
      b.append(label, handle('l', 'start'), handle('r', 'end'))
      blocks.push(b)
    })
    this.trackVideo.replaceChildren(...blocks)

    // overlays in as few rows as will fit
    const lanes: number[] = []
    const laneOf = new Map<string, number>()
    for (const o of [...s.project.overlays].sort((a, b) => a.start - b.start)) {
      let lane = lanes.findIndex((end) => end <= o.start + 1e-6)
      if (lane < 0) lane = lanes.length
      lanes[lane] = o.end
      laneOf.set(o.id, lane)
    }
    const rows = Math.max(1, lanes.length)
    this.trackOver.style.height = `${rows * 30 + 8}px`
    const label = this.root.querySelector<HTMLElement>('#label-over')!
    label.style.height = `${rows * 30 + 8}px`
    this.trackOver.replaceChildren(
      ...s.project.overlays.map((o) => {
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

    // music
    const m = s.project.music
    if (m) {
      const room = Math.max(0.1, total - m.start)
      const len = m.loop ? room : Math.min(room, Math.max(0.1, m.duration - m.offset))
      const b = document.createElement('div')
      b.className = `blk music-blk${s.selection?.kind === 'music' ? ' sel' : ''}`
      b.dataset.music = '1'
      b.style.left = `${this.x(m.start)}px`
      b.style.width = `${Math.max(10, this.x(len))}px`
      const cv = document.createElement('canvas')
      cv.className = 'wave'
      cv.width = Math.max(10, Math.round(this.x(len)))
      cv.height = 36
      this.drawWave(cv, m.media, m.offset, m.duration, len, m.loop)
      const t = document.createElement('span')
      t.className = 'blk-label'
      t.textContent = `${m.name} · ${Math.round(m.volume * 100)}%${m.duck ? ' · quieter under voice' : ''}`
      b.append(cv, t)
      this.trackMusic.replaceChildren(b)
    } else {
      const hint = document.createElement('div')
      hint.className = 'track-hint'
      hint.textContent = 'No music yet — choose “Add music” to put a song under the video'
      this.trackMusic.replaceChildren(hint)
    }
    this.movePlayhead()
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
      const px = this.store.pxPerSec
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

  private snapTime(t: number, ignorePlayhead = false): number {
    const s = this.store
    const near = 6 / s.pxPerSec
    if (!ignorePlayhead && Math.abs(t - s.playhead) < near) return s.playhead
    return s.snap(t)
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return
    const s = this.store
    const target = e.target as HTMLElement
    const edgeEl = target.closest<HTMLElement>('[data-edge]')
    const blk = target.closest<HTMLElement>('.blk')
    const startX = e.clientX
    const base = s.project

    if (blk?.dataset.clip) {
      const id = blk.dataset.clip
      s.select({ kind: 'clip', id })
      const clip = base.clips.find((c) => c.id === id)!
      if (edgeEl) {
        const edge = edgeEl.dataset.edge as 'start' | 'end'
        const len = this.deps.sourceLength(clip)
        const origin = edge === 'start' ? clip.in : clip.out
        this.drag = (ev) => {
          const to = this.snapTime(origin + (ev.clientX - startX) / s.pxPerSec, true)
          s.edit(() => trimClip(base, id, edge, to, len), { merge: `trim:${id}:${edge}` })
        }
      } else {
        const idx0 = base.clips.findIndex((c) => c.id === id)
        const placed = layout(base.clips)
        let moved = false
        this.drag = (ev) => {
          if (!moved && Math.abs(ev.clientX - startX) < 6) return
          moved = true
          const t = this.timeAt(ev.clientX)
          let idx = placed.filter((p) => p.clip.id !== id && (p.start + p.end) / 2 < t).length
          idx = clampNum(idx, 0, base.clips.length - 1)
          if (idx !== idx0 || s.project !== base) s.edit(() => moveClip(base, id, idx), { merge: `move:${id}` })
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
        if (edgeEl?.dataset.edge === 'start') apply(clampNum(this.snapTime(o.start + dt), 0, o.end - 0.1), o.end)
        else if (edgeEl?.dataset.edge === 'end') apply(o.start, clampNum(this.snapTime(o.end + dt), o.start + 0.1, total))
        else {
          const len = o.end - o.start
          const start = clampNum(this.snapTime(o.start + dt), 0, Math.max(0, total - len))
          apply(start, start + len)
        }
      }
      // a click (no drag) also moves the playhead there, so the thing is visible
      e.preventDefault()
      return
    }

    if (blk?.dataset.music) {
      s.select({ kind: 'music', id: 'music' })
      const m = base.music!
      this.drag = (ev) => {
        const start = clampNum(this.snapTime(m.start + (ev.clientX - startX) / s.pxPerSec), 0, Math.max(0, s.duration - 0.5))
        s.edit((p) => (p.music ? { ...p, music: { ...p.music, start } } : null), { merge: 'music-start' })
      }
      e.preventDefault()
      return
    }

    // empty space: move the playhead here and let go of whatever was selected
    s.select(null)
    s.setPlaying(false)
    s.seek(this.snapTime(this.timeAt(e.clientX), true))
    this.drag = (ev) => s.seek(this.snapTime(this.timeAt(ev.clientX), true))
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
