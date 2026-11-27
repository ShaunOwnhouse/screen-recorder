import {
  activeClips, cleanLook, envAt, clipEnd, clipPlaysOwnSound, clipVoiceParts, DISSOLVE, isDrawn, isFloating, isFullBox, isNeutralLook, layerOf, lookMatrix,
  overlayAlpha, soundOn, zoomState, trackById, type BlurOverlay, type Clip, type Sound
} from '../../shared/project.ts'
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
  /** A flat colour laid over the piece while it fades from (or to) a colour. */
  tint: HTMLElement
  used: number
}

const MAX_VIDEO_NODES = 8

/**
 * Plays the project on the stage: the clips in order (with cross-fades), the zoom, blur and picture-in-picture, the
 * comments drawn on top, and the music. Time runs from a clock of its own and every picture or sound follows it.
 */
export class Player {
  private nodes = new Map<string, Node>()
  private blurNodes = new Map<string, HTMLElement>()
  private sounds = new Map<string, HTMLAudioElement>()
  private last = 0
  private dirty = true
  private tickCount = 0
  /** Where the recording itself is loaded from (a smaller copy when the browser can't decode the original). */
  recordingUrl = ''
  onRecordingError: (() => void) | null = null
  private drawnKey = ''
  /** The colour filters (one per piece with a look), as SVG the pictures point at. */
  private lookDefs: SVGDefsElement | null = null
  private readonly lookNodes = new Map<string, SVGFEColorMatrixElement>()

  constructor(
    private readonly store: Store,
    private readonly els: Els
  ) {
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
    const s = this.store
    for (const c of activeClips(s.project, s.playhead)) {
      if (trackById(s.project, c.track)?.hidden) continue
      const n = this.nodes.get(c.id)
      if (n && n.el instanceof HTMLVideoElement && !n.el.error && (n.el.seeking || n.el.readyState < 2)) return true
    }
    return false
  }

  // ---------- pieces ----------

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
    const tint = document.createElement('div')
    tint.className = 'layer-tint'
    ;(isFloating(c) ? this.els.pips : this.els.layers).append(el, tint)
    n = { clip: c.id, media: c.kind === 'recording' ? this.recordingUrl : c.media, el, tint, used: 0 }
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
    n.tint.remove()
    this.nodes.delete(id)
  }

  private trimNodes(): void {
    const videos = [...this.nodes.values()].filter((n) => n.el instanceof HTMLVideoElement).sort((a, b) => a.used - b.used)
    while (videos.length > MAX_VIDEO_NODES) {
      const old = videos.shift()!
      this.dropNode(old.clip)
    }
  }

  /** How visible a piece is at time t because of its fades (1 = not faded at all), and the colour it fades into. */
  private fadeAt(c: Clip, t: number): { amount: number; colour: string } {
    const len = clipEnd(c) - c.start
    let amount = 1
    let colour = c.fadeIn.color
    const din = Math.min(c.fadeIn.dur, len / 2)
    const dout = Math.min(c.fadeOut.dur, len / 2)
    if (din > 0.02 && t < c.start + din) amount = clampNum((t - c.start) / din, 0, 1)
    if (dout > 0.02 && t > clipEnd(c) - dout) {
      const a = clampNum((clipEnd(c) - t) / dout, 0, 1)
      if (a < amount) {
        amount = a
        colour = c.fadeOut.color
      }
    }
    return { amount, colour }
  }

  private sync(): void {
    const s = this.store
    const p = s.project
    const t = s.playhead
    const ids = new Set(p.clips.map((c) => c.id))
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.dropNode(id)
    for (const [id, m] of [...this.lookNodes]) if (!ids.has(id)) { m.parentElement?.remove(); this.lookNodes.delete(id) }

    const seq = ++this.tickCount
    const crop = s.cropMode ? null : p.crop
    const showing = new Set(activeClips(p, t).filter((c) => !trackById(p, c.track)?.hidden).map((c) => c.id))
    for (const c of p.clips) {
      const live = showing.has(c.id)
      const ahead = !live && c.start > t && c.start - t < 1.5 && s.playing && !trackById(p, c.track)?.hidden
      if (!live && !ahead) {
        const n = this.nodes.get(c.id)
        if (n) {
          n.el.style.display = 'none'
          n.tint.style.display = 'none'
          if (n.el instanceof HTMLVideoElement && !n.el.paused) n.el.pause()
        }
        continue
      }
      const n = this.nodeFor(c)
      if (!n) continue
      n.used = seq
      const el = n.el
      const home = isFloating(c) ? this.els.pips : this.els.layers
      if (el.parentElement !== home) home.append(el, n.tint)
      const z = String(layerOf(p, c.track) * 2 + 1)
      el.style.display = live ? '' : 'none'
      el.style.zIndex = z
      const f = this.fadeAt(c, t)
      const dissolve = f.colour === DISSOLVE
      el.style.opacity = String((live && dissolve ? f.amount : 1) * envAt(c.showEnv, t - c.start))
      this.placeNode(el, n.tint, c, crop)
      this.applyLook(el, c)
      n.tint.style.zIndex = String(layerOf(p, c.track) * 2 + 2)
      n.tint.style.display = live && !dissolve && f.amount < 1 ? '' : 'none'
      if (!dissolve) {
        n.tint.style.background = f.colour
        n.tint.style.opacity = String(1 - f.amount)
      }
      if (el instanceof HTMLCanvasElement && c.card) this.drawCardNode(el, c)
      if (el instanceof HTMLVideoElement) {
        const want = clampNum(c.in + (t - c.start) * c.speed, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.01) : 1e9)
        const tolerance = s.playing ? 0.35 * Math.max(1, c.speed) : 0.5 / s.fps
        if (el.readyState > 0 || !live) {
          if (Math.abs(el.currentTime - want) > tolerance && !el.seeking) el.currentTime = want
          else if (!live && !s.playing && Math.abs(el.currentTime - c.in) > 0.05 && !el.seeking) el.currentTime = c.in
        }
        const rate = clampNum(c.speed, 0.25, 4)
        if (el.playbackRate !== rate) el.playbackRate = rate
        // sound from a track taken out of the recording, or from the camera, is played separately: this one is then off
        const track = trackById(p, c.track)
        el.muted = !clipPlaysOwnSound(p, c)
        el.volume = clampNum(c.volume * f.amount * envAt(c.volEnv, t - c.start), 0, 1)
        if (track?.muted) el.muted = true
        if (s.playing && live && el.paused && t < clipEnd(c) - 0.02) void el.play().catch(() => undefined)
        if ((!s.playing || !live) && !el.paused) el.pause()
      }
    }
    this.syncSounds(t)
  }

  /** Colour and brightness of a piece: the same colour matrix the export's filters amount to (see `lookMatrix`). */
  private applyLook(el: Node['el'], c: Clip): void {
    if (isNeutralLook(c.look)) {
      if (el.style.filter) el.style.filter = ''
      return
    }
    if (!this.lookDefs) {
      const NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('width', '0')
      svg.setAttribute('height', '0')
      svg.setAttribute('aria-hidden', 'true')
      svg.style.position = 'absolute'
      this.lookDefs = document.createElementNS(NS, 'defs')
      svg.append(this.lookDefs)
      this.els.frame.append(svg)
    }
    const id = `look-${c.id}`
    let m = this.lookNodes.get(c.id)
    if (!m) {
      const NS = 'http://www.w3.org/2000/svg'
      const f = document.createElementNS(NS, 'filter')
      f.id = id
      // the maths is done on the colours as stored (not converted to linear light first), like the export
      f.setAttribute('color-interpolation-filters', 'sRGB')
      f.setAttribute('x', '0')
      f.setAttribute('y', '0')
      f.setAttribute('width', '100%')
      f.setAttribute('height', '100%')
      m = document.createElementNS(NS, 'feColorMatrix')
      m.setAttribute('type', 'matrix')
      f.append(m)
      this.lookDefs.append(f)
      this.lookNodes.set(c.id, m)
    }
    const values = lookMatrix(cleanLook(c.look)).map((n) => n.toFixed(4)).join(' ')
    if (m.getAttribute('values') !== values) m.setAttribute('values', values)
    const want = `url(#${id})`
    if (el.style.filter !== want) el.style.filter = want
  }

  private placeNode(el: Node['el'], tint: HTMLElement, c: Clip, crop: { x: number; y: number; width: number; height: number } | null): void {
    const st = el.style
    const full = isFullBox(c.box) || !!c.card
    let rect: { left: string; top: string; width: string; height: string }
    if (full && c.kind === 'recording' && crop) {
      // the cropped part fills the frame; the rest is pushed outside it
      rect = { left: `${(-crop.x / crop.width) * 100}%`, top: `${(-crop.y / crop.height) * 100}%`, width: `${100 / crop.width}%`, height: `${100 / crop.height}%` }
      st.objectFit = 'fill'
    } else if (full) {
      rect = { left: '0', top: '0', width: '100%', height: '100%' }
      st.objectFit = c.card ? 'fill' : 'contain'
    } else {
      // a small window: the picture's own shape, or (the face camera) a square showing its middle, round or rounded
      const square = isFloating(c)
      const aspect = square ? 1 : (c.width || 16) / (c.height || 9)
      rect = { left: `${c.box.x * 100}%`, top: `${c.box.y * 100}%`, width: `${c.box.w * 100}%`, height: 'auto' }
      st.aspectRatio = String(aspect)
      st.objectFit = 'cover'
    }
    Object.assign(st, rect)
    if (full) st.aspectRatio = ''
    const floating = !full && isFloating(c)
    const radius = floating ? (c.shape === 'circle' ? '50%' : c.shape === 'rounded' ? '22%' : '0') : ''
    st.borderRadius = radius
    st.boxSizing = 'border-box'
    // a frame round the window: a thin ring for the shaped ones, an outline for a plain rectangle
    st.border = floating && c.border ? '3px solid #fff' : ''
    st.outline = !full && !floating && c.border ? '4px solid #fff' : ''
    Object.assign(tint.style, { ...rect, aspectRatio: full ? '' : String(floating ? 1 : (c.width || 16) / (c.height || 9)), borderRadius: radius })
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

  // ---------- sounds ----------

  private syncSounds(t: number): void {
    const s = this.store
    const p = s.project
    const parts = clipVoiceParts(p)
    const trackVoice = parts.some((v) => t >= v.start && t < v.start + v.length)
    const ownVoice = activeClips(p, t).some((c) => clipPlaysOwnSound(p, c) && c.volume > 0)
    const voice = trackVoice || ownVoice
    // the computer sound / microphone of the recording, played from their own files like any other sound
    const virtual: Sound[] = parts.map((v, i) => ({
      id: `track:${i}:${v.media}`, track: '', origin: 'split', media: v.media, name: '', duration: 1e9, offset: v.from, start: v.start, length: v.length, speed: v.speed,
      volume: v.volume, fadeIn: 0, fadeOut: 0, loop: false, duck: false, volEnv: v.env
    }))
    const list: Sound[] = [...p.sounds, ...virtual]
    const ids = new Set(list.map((x) => x.id))
    for (const [id, a] of this.sounds) {
      if (!ids.has(id)) {
        a.pause()
        a.removeAttribute('src')
        this.sounds.delete(id)
      }
    }
    for (const m of list) {
      const info = s.media.get(m.media)
      let a = this.sounds.get(m.id)
      if (!info || (m.track && !soundOn(p, m.track))) {
        if (a && !a.paused) a.pause()
        continue
      }
      if (!a) {
        a = new Audio()
        a.preload = 'auto'
        this.sounds.set(m.id, a)
      }
      if (a.dataset.src !== info.url) {
        a.dataset.src = info.url
        a.src = info.url
      }
      const rel = t - m.start
      const len = Math.max(0.1, m.length)
      if (rel < 0 || rel >= len) {
        if (!a.paused) a.pause()
        continue
      }
      let pos = m.offset + rel * m.speed
      if (m.loop && m.duration > 0) pos = m.offset + ((rel * m.speed) % Math.max(0.1, m.duration - m.offset))
      const fi = m.fadeIn > 0 ? clampNum(rel / m.fadeIn, 0, 1) : 1
      const fo = m.fadeOut > 0 ? clampNum((len - rel) / m.fadeOut, 0, 1) : 1
      a.volume = clampNum(m.volume * fi * fo * envAt(m.volEnv, rel) * (m.duck && voice ? 0.3 : 1), 0, 1)
      const rate = clampNum(m.speed, 0.25, 4)
      if (a.playbackRate !== rate) a.playbackRate = rate
      if (s.playing) {
        if (Math.abs(a.currentTime - pos) > 0.4 * Math.max(1, m.speed) && !a.seeking) a.currentTime = pos
        if (a.paused) void a.play().catch(() => undefined)
      } else if (!a.paused) a.pause()
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
    const top = this.store.activeNow().filter((c) => c.kind !== 'image').pop()
    const n = top ? this.nodes.get(top.id) : null
    return n && n.el instanceof HTMLVideoElement ? n.el : null
  }
}
