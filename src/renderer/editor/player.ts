import { layout, overlayAlpha, isDrawn, zoomState, type BlurOverlay, type Clip, type PipOverlay } from '../../shared/project.ts'
import { drawCard, drawOverlay, frameFor } from './draw.ts'
import { clampNum, type Store } from './store.ts'

interface Els {
  frame: HTMLElement
  layers: HTMLElement
  pips: HTMLElement
  canvas: HTMLCanvasElement
}

interface Node {
  clip: string
  media: string
  el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  used: number
}

const MAX_VIDEO_NODES = 4

/**
 * Plays the project on the stage: the clips in order (with cross-fades), the zoom, blur and picture-in-picture, the
 * comments drawn on top, and the music. Time runs from a clock of its own and every picture or sound follows it.
 */
export class Player {
  private nodes = new Map<string, Node>()
  private pipNodes = new Map<string, { el: HTMLVideoElement | HTMLImageElement; used: number }>()
  private blurNodes = new Map<string, HTMLElement>()
  private music = new Audio()
  private last = 0
  private dirty = true
  private tickCount = 0
  /** Where the recording itself is loaded from (a smaller copy when the browser can't decode the original). */
  recordingUrl = ''
  onRecordingError: (() => void) | null = null
  private drawnKey = ''

  constructor(
    private readonly store: Store,
    private readonly els: Els
  ) {
    this.music.preload = 'auto'
    store.on(() => (this.dirty = true))
    requestAnimationFrame((t) => this.tick(t))
  }

  invalidate(): void {
    this.dirty = true
    this.drawnKey = ''
  }

  toggle(): void {
    const s = this.store
    if (s.playing) return s.setPlaying(false)
    if (s.playhead >= s.duration - 0.02) s.seek(0)
    s.setPlaying(true)
  }

  private urlFor(c: Clip): string {
    if (c.kind === 'recording') return this.recordingUrl
    return this.store.media.get(c.media)?.url ?? ''
  }

  private tick(now: number): void {
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0
    this.last = now
    const s = this.store
    if (s.playing) {
      if (!this.stalled()) {
        s.playhead = Math.min(s.duration, s.playhead + dt)
        s.emit('playhead')
      }
      if (s.playhead >= s.duration - 1e-3) {
        s.playhead = s.duration
        s.setPlaying(false)
      }
    }
    if (s.playing || this.dirty) {
      this.sync()
      this.paint()
      this.dirty = false
    }
    this.tickCount++
    requestAnimationFrame((t) => this.tick(t))
  }

  /** True while a picture that should be showing is still being loaded or found, so the clock waits for it. */
  private stalled(): boolean {
    const t = this.store.playhead
    for (const p of layout(this.store.project.clips)) {
      if (t < p.start - 1e-6 || t >= p.end - 1e-6) continue
      const n = this.nodes.get(p.clip.id)
      if (n && n.el instanceof HTMLVideoElement && !n.el.error && (n.el.seeking || n.el.readyState < 2)) return true
    }
    return false
  }

  // ---------- clips ----------

  private nodeFor(c: Clip): Node | null {
    let n = this.nodes.get(c.id)
    const url = this.urlFor(c)
    if (n && n.media !== (c.kind === 'recording' ? this.recordingUrl : c.media)) {
      this.dropNode(c.id)
      n = undefined
    }
    if (n) return n
    let el: Node['el']
    if (c.card) el = document.createElement('canvas')
    else if (c.kind === 'image') {
      if (!url) return null
      el = document.createElement('img')
      el.src = url
    } else {
      if (!url) return null
      const v = document.createElement('video')
      v.preload = 'auto'
      v.playsInline = true
      v.src = url
      v.addEventListener('error', () => c.kind === 'recording' && this.onRecordingError?.())
      el = v
    }
    el.className = 'layer'
    el.dataset.layer = c.id
    this.els.layers.prepend(el)
    n = { clip: c.id, media: c.kind === 'recording' ? this.recordingUrl : c.media, el, used: 0 }
    this.nodes.set(c.id, n)
    this.trimNodes()
    return n
  }

  private dropNode(id: string): void {
    const n = this.nodes.get(id)
    if (!n) return
    if (n.el instanceof HTMLVideoElement) {
      n.el.pause()
      n.el.removeAttribute('src')
      n.el.load()
    }
    n.el.remove()
    this.nodes.delete(id)
  }

  private trimNodes(): void {
    const videos = [...this.nodes.values()].filter((n) => n.el instanceof HTMLVideoElement).sort((a, b) => a.used - b.used)
    while (videos.length > MAX_VIDEO_NODES) {
      const old = videos.shift()!
      this.dropNode(old.clip)
    }
  }

  private sync(): void {
    const s = this.store
    const p = s.project
    const t = s.playhead
    const placed = layout(p.clips)
    const ids = new Set(p.clips.map((c) => c.id))
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.dropNode(id)

    const seq = ++this.tickCount
    const crop = s.cropMode ? null : p.crop
    let any = false
    placed.forEach((pl, i) => {
      const c = pl.clip
      const showing = t >= pl.start - 1e-6 && t < pl.end - 1e-6
      const ahead = pl.start > t && pl.start - t < 1.5 && s.playing
      const lastClip = i === placed.length - 1 && t >= pl.end - 1e-6
      if (!showing && !ahead && !lastClip) {
        const n = this.nodes.get(c.id)
        if (n) {
          n.el.style.display = 'none'
          if (n.el instanceof HTMLVideoElement && !n.el.paused) n.el.pause()
        }
        return
      }
      const n = this.nodeFor(c)
      if (!n) return
      n.used = seq
      if (showing || lastClip) any = true
      const el = n.el
      el.style.display = showing || lastClip ? '' : 'none'
      el.style.zIndex = String(i + 1)
      const fadeIn = pl.overlap > 0 && t < pl.start + pl.overlap ? clampNum((t - pl.start) / pl.overlap, 0, 1) : 1
      el.style.opacity = String(fadeIn)
      this.placeNode(el, c, crop)
      if (el instanceof HTMLCanvasElement && c.card) this.drawCardNode(el, c)
      if (el instanceof HTMLVideoElement) {
        const want = clampNum(c.in + (t - pl.start), 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.01) : 1e9)
        const live = showing || lastClip
        const tolerance = s.playing ? 0.35 : 0.5 / s.fps
        if (el.readyState > 0 || !live) {
          if (Math.abs(el.currentTime - want) > tolerance && !el.seeking) el.currentTime = want
          else if (!live && !s.playing && Math.abs(el.currentTime - c.in) > 0.05 && !el.seeking) el.currentTime = c.in
        }
        el.volume = clampNum(c.volume, 0, 1)
        if (s.playing && live && el.paused && t < pl.end - 0.02) void el.play().catch(() => undefined)
        if ((!s.playing || !live) && !el.paused) el.pause()
      }
    })
    if (!any) for (const n of this.nodes.values()) n.el.style.display = 'none'
    this.syncMusic(t)
    this.syncPips(t)
  }

  private placeNode(el: Node['el'], c: Clip, crop: { x: number; y: number; width: number; height: number } | null): void {
    const st = el.style
    if (c.kind === 'recording' && crop) {
      // the cropped part fills the frame; the rest is pushed outside it
      st.width = `${100 / crop.width}%`
      st.height = `${100 / crop.height}%`
      st.left = `${(-crop.x / crop.width) * 100}%`
      st.top = `${(-crop.y / crop.height) * 100}%`
      st.objectFit = 'fill'
    } else {
      st.width = '100%'
      st.height = '100%'
      st.left = '0'
      st.top = '0'
      st.objectFit = c.card ? 'fill' : 'contain'
    }
  }

  private drawCardNode(cv: HTMLCanvasElement, c: Clip): void {
    const key = JSON.stringify(c.card) + this.els.frame.clientWidth + 'x' + this.els.frame.clientHeight
    if (cv.dataset.key === key) return
    cv.dataset.key = key
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(2, Math.round(this.els.frame.clientWidth * dpr))
    const h = Math.max(2, Math.round(this.els.frame.clientHeight * dpr))
    cv.width = w
    cv.height = h
    const f = frameFor(this.store.aspect)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(w / f.W, 0, 0, h / f.H, 0, 0)
    drawCard(ctx, c.card!, f)
  }

  // ---------- music ----------

  private syncMusic(t: number): void {
    const s = this.store
    const m = s.project.music
    const info = m ? s.media.get(m.media) : null
    const a = this.music
    if (!m || !info) {
      if (!a.paused) a.pause()
      return
    }
    if (a.dataset.src !== info.url) {
      a.dataset.src = info.url
      a.src = info.url
    }
    const rel = t - m.start
    const room = Math.max(0.1, s.duration - m.start)
    const len = m.loop ? room : Math.min(room, Math.max(0.1, m.duration - m.offset))
    const active = rel >= 0 && rel < len
    if (!active) {
      if (!a.paused) a.pause()
      return
    }
    let pos = m.offset + rel
    if (m.loop && m.duration > 0) pos = pos % m.duration
    const fi = m.fadeIn > 0 ? clampNum(rel / m.fadeIn, 0, 1) : 1
    const fo = m.fadeOut > 0 ? clampNum((len - rel) / m.fadeOut, 0, 1) : 1
    const placed = s.placedNow()
    const voice = !!placed && placed.clip.kind !== 'image' && placed.clip.hasAudio && placed.clip.volume > 0
    a.volume = clampNum(m.volume * fi * fo * (m.duck && voice ? 0.3 : 1), 0, 1)
    if (s.playing) {
      if (Math.abs(a.currentTime - pos) > 0.4 && !a.seeking) a.currentTime = pos
      if (a.paused) void a.play().catch(() => undefined)
    } else if (!a.paused) a.pause()
  }

  // ---------- picture-in-picture ----------

  private syncPips(t: number): void {
    const s = this.store
    const active = s.project.overlays.filter((o): o is PipOverlay => o.kind === 'pip' && t >= o.start && t < o.end)
    const seq = this.tickCount
    for (const o of active) {
      let n = this.pipNodes.get(o.id)
      const info = s.media.get(o.media)
      if (!info) continue
      if (!n) {
        const el = info.kind === 'image' ? document.createElement('img') : document.createElement('video')
        el.className = 'pip'
        if (el instanceof HTMLVideoElement) el.playsInline = true
        el.src = info.url
        this.els.pips.append(el)
        n = { el, used: seq }
        this.pipNodes.set(o.id, n)
      }
      n.used = seq
      const f = frameFor(s.aspect)
      const hh = (o.w * f.W * (o.height || 9)) / (o.width || 16) / f.H
      Object.assign(n.el.style, { display: '', left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${hh * 100}%`, opacity: String(overlayAlpha(o, t)) })
      if (n.el instanceof HTMLVideoElement) {
        const want = o.in + (t - o.start)
        if (Math.abs(n.el.currentTime - want) > (s.playing ? 0.35 : 0.05) && !n.el.seeking) n.el.currentTime = Math.max(0, want)
        n.el.volume = clampNum(o.volume, 0, 1)
        if (s.playing && n.el.paused) void n.el.play().catch(() => undefined)
        if (!s.playing && !n.el.paused) n.el.pause()
      }
    }
    for (const [id, n] of this.pipNodes) {
      if (n.used === seq) continue
      if (n.el instanceof HTMLVideoElement && !n.el.paused) n.el.pause()
      n.el.style.display = 'none'
      if (!s.project.overlays.some((o) => o.id === id)) {
        n.el.remove()
        this.pipNodes.delete(id)
      }
    }
  }

  // ---------- painting ----------

  private paint(): void {
    const s = this.store
    const t = s.playhead
    const { frame, canvas, layers } = this.els
    const w = frame.clientWidth
    const h = frame.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.round(w * dpr)
    const ch = Math.round(h * dpr)
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const f = frameFor(s.aspect)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    ctx.setTransform(cw / f.W, 0, 0, ch / f.H, 0, 0)
    for (const o of s.project.overlays) if (isDrawn(o)) drawOverlay(ctx, o, f, overlayAlpha(o, t))

    // zoom: the pictures (and blur) move together; comments stay where they are
    const picked = s.selectedOverlay
    const editingArea = !!picked && (picked.kind === 'zoom' || picked.kind === 'blur')
    const z = editingArea ? { z: 1, cx: 0.5, cy: 0.5 } : zoomState(s.project.overlays, t)
    layers.style.transformOrigin = '0 0'
    layers.style.transform = z.z > 1.0001 ? `scale(${z.z}) translate(${-(z.cx - 0.5 / z.z) * w}px, ${-(z.cy - 0.5 / z.z) * h}px)` : ''

    // blur and pixelate boxes show a frosted version of what is behind them
    const blurs = s.project.overlays.filter((o): o is BlurOverlay => o.kind === 'blur')
    const live = new Set<string>()
    for (const o of blurs) {
      let d = this.blurNodes.get(o.id)
      if (!d) {
        d = document.createElement('div')
        d.className = 'blur-box'
        layers.append(d)
        this.blurNodes.set(o.id, d)
      }
      live.add(o.id)
      const on = t >= o.start && t < o.end
      const px = (h / 1080) * (o.mode === 'pixelate' ? 5 : 3) * o.strength
      Object.assign(d.style, {
        display: on ? '' : 'none', left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%`,
        backdropFilter: `blur(${px.toFixed(1)}px)`, zIndex: '999'
      })
      d.dataset.mode = o.mode
    }
    for (const [id, d] of this.blurNodes) {
      if (live.has(id)) continue
      d.remove()
      this.blurNodes.delete(id)
    }
  }

  /** The picture on the stage right now as a data URL, for the E2E tests and thumbnails. */
  get activeVideo(): HTMLVideoElement | null {
    const p = this.store.placedNow()
    const n = p ? this.nodes.get(p.clip.id) : null
    return n && n.el instanceof HTMLVideoElement ? n.el : null
  }
}
