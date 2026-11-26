import { activeClips, clipBoxHeight, isFloating, isFullBox, trackById, type Clip, type Overlay, type TextOverlay } from '../../shared/project.ts'
import type { Rect } from '../../shared/types.ts'
import { boundsOf, frameFor } from './draw.ts'
import type { Player } from './player.ts'
import { clampNum, type Store } from './store.ts'

interface Els {
  stage: HTMLElement
  frame: HTMLElement
  sel: HTMLElement
  cropLayer: HTMLElement
  cropBox: HTMLElement
  cropSize: HTMLElement
  aspect: HTMLSelectElement
}

function cropRatio(v: string): number | null {
  if (v === 'free') return null
  const [w, h] = v.split(':').map(Number)
  return w && h ? w / h : null
}

const BOX_KINDS: Overlay['kind'][] = ['box', 'blur', 'spotlight', 'zoom']

/** Clicking, moving and resizing things on the video, and drawing the crop. */
export class Stage {
  private drag: ((e: PointerEvent) => void) | null = null
  private dragEnd: (() => void) | null = null

  constructor(
    private readonly store: Store,
    private readonly els: Els,
    private readonly player: Player
  ) {
    els.frame.addEventListener('pointerdown', (e) => this.down(e))
    window.addEventListener('pointermove', (e) => this.drag?.(e))
    window.addEventListener('pointerup', () => {
      this.dragEnd?.()
      this.drag = null
      this.dragEnd = null
      store.endMerge()
    })
    store.on((what) => {
      if (what === 'project' || what === 'selection' || what === 'playhead' || what === 'tool') this.render()
    })
    this.bindCrop()
    this.render()
  }

  private rect(): DOMRect {
    return this.els.frame.getBoundingClientRect()
  }

  /** Overlays the playhead is in, topmost first. */
  private hit(fx: number, fy: number): Overlay | null {
    const s = this.store
    const f = frameFor(s.aspect)
    const t = s.playhead
    for (const o of [...s.project.overlays].reverse()) {
      if (t < o.start || t >= o.end) continue
      const b = boundsOf(o, f)
      const x = fx * f.W
      const y = fy * f.H
      const pad = 6
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
        if (o.kind === 'spotlight') continue // its hole can be picked from the timeline; a click inside it should just play
        return o
      }
    }
    return null
  }

  /** Pieces shown as small windows over the picture at the playhead, front first (the others fill the whole picture, so a click on them just plays). */
  private hitClip(fx: number, fy: number, floating: boolean): Clip | null {
    const s = this.store
    const list = activeClips(s.project, s.playhead).filter(
      (c) => !isFullBox(c.box) && !c.card && isFloating(c) === floating && !trackById(s.project, c.track)?.hidden && !trackById(s.project, c.track)?.locked
    )
    for (const c of list.reverse()) {
      const h = clipBoxHeight(c, s.aspect)
      if (fx >= c.box.x && fx <= c.box.x + c.box.w && fy >= c.box.y && fy <= c.box.y + h) return c
    }
    return null
  }

  private startMoveClip(c: Clip, e: PointerEvent): void {
    const s = this.store
    const r = this.rect()
    const x0 = e.clientX
    const y0 = e.clientY
    const h = clipBoxHeight(c, s.aspect)
    this.drag = (ev) => {
      s.patchClip(
        c.id,
        { box: { ...c.box, x: clampNum(c.box.x + (ev.clientX - x0) / r.width, 0, 1 - c.box.w), y: clampNum(c.box.y + (ev.clientY - y0) / r.height, 0, Math.max(0, 1 - h)) } },
        `clipbox:${c.id}`
      )
    }
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.store.cropMode) return
    const target = e.target as HTMLElement
    if (target.closest('[data-grab]')) return // the selection box handles it
    const r = this.rect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    // round / rounded / square windows (the face camera) sit on top of everything, so they are picked first
    const top = this.hitClip(fx, fy, true)
    if (top) {
      this.store.select({ kind: 'clip', id: top.id })
      this.startMoveClip(top, e)
      e.preventDefault()
      return
    }
    const o = this.hit(fx, fy)
    if (o) {
      this.store.select({ kind: 'overlay', id: o.id })
      this.startMove(o, e)
      e.preventDefault()
      return
    }
    const win = this.hitClip(fx, fy, false)
    if (win) {
      this.store.select({ kind: 'clip', id: win.id })
      this.startMoveClip(win, e)
      e.preventDefault()
      return
    }
    // a plain click on the picture plays or pauses it
    this.store.select(null)
    const startX = e.clientX
    const startY = e.clientY
    this.dragEnd = () => undefined
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointerup', up)
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) this.player.toggle()
    }
    window.addEventListener('pointerup', up)
  }

  private startMove(o: Overlay, e: PointerEvent): void {
    const s = this.store
    const r = this.rect()
    const x0 = e.clientX
    const y0 = e.clientY
    const orig = JSON.parse(JSON.stringify(o)) as Record<string, number>
    this.drag = (ev) => {
      const dx = (ev.clientX - x0) / r.width
      const dy = (ev.clientY - y0) / r.height
      s.patchOverlay(o.id, this.moved(o, orig, dx, dy), `move:${o.id}`)
    }
  }

  private moved(o: Overlay, orig: Record<string, number>, dx: number, dy: number): Record<string, number> {
    const f = frameFor(this.store.aspect)
    if (o.kind === 'arrow') return { x1: clampNum(orig.x1 + dx, 0, 1), y1: clampNum(orig.y1 + dy, 0, 1), x2: clampNum(orig.x2 + dx, 0, 1), y2: clampNum(orig.y2 + dy, 0, 1) }
    const b = boundsOf(o, f)
    const w = o.kind === 'step' ? 0 : (o as { w?: number }).w ?? b.w / f.W
    const patch: Record<string, number> = {
      x: clampNum(orig.x + dx, o.kind === 'step' ? 0 : -0.1, o.kind === 'step' ? 1 : 1 - Math.min(0.9, w) + 0.1),
      y: clampNum(orig.y + dy, o.kind === 'step' ? 0 : -0.05, 1)
    }
    if (o.kind === 'bubble') {
      patch.tx = orig.tx + dx
      patch.ty = orig.ty + dy
    }
    return patch
  }

  // ---------- selection box ----------

  /** The selection box for a piece shown as a small window: drag it to move it, the corner to resize it. */
  private renderClipSelection(): boolean {
    const s = this.store
    const c = s.selectedClip
    const host = this.els.sel
    if (!c || isFullBox(c.box) || c.card || s.cropMode) return false
    const t = s.playhead
    if (!activeClips(s.project, t).some((x) => x.id === c.id)) return false
    const h = clipBoxHeight(c, s.aspect)
    host.hidden = false
    host.replaceChildren()
    host.className = 'sel-box k-camera'
    Object.assign(host.style, { left: `${c.box.x * 100}%`, top: `${c.box.y * 100}%`, width: `${c.box.w * 100}%`, height: `${h * 100}%` })
    const g = document.createElement('i')
    g.className = 'h h-se'
    g.dataset.grab = '1'
    g.style.cursor = 'nwse-resize'
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const r = this.rect()
      const x0 = e.clientX
      const w0 = c.box.w
      this.drag = (ev) => s.patchClip(c.id, { box: { ...c.box, w: clampNum(w0 + (ev.clientX - x0) / r.width, 0.08, Math.max(0.1, 1 - c.box.x)) } }, `clipsize:${c.id}`)
    })
    host.append(g)
    return true
  }

  render(): void {
    const s = this.store
    const o = s.selectedOverlay
    const host = this.els.sel
    this.renderCrop()
    if (!o && this.renderClipSelection()) return
    if (!o || s.cropMode || s.playhead < o.start - 1e-6 || s.playhead >= o.end + 1e-6) {
      host.hidden = true
      return
    }
    const f = frameFor(s.aspect)
    const b = boundsOf(o, f)
    host.hidden = false
    host.replaceChildren()
    Object.assign(host.style, { left: `${(b.x / f.W) * 100}%`, top: `${(b.y / f.H) * 100}%`, width: `${(b.w / f.W) * 100}%`, height: `${(b.h / f.H) * 100}%` })
    host.className = `sel-box k-${o.kind}`

    const grip = (cls: string, cursor: string, run: (dx: number, dy: number, orig: Record<string, number>) => Record<string, number>): HTMLElement => {
      const g = document.createElement('i')
      g.className = cls
      g.dataset.grab = '1'
      g.style.cursor = cursor
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const r = this.rect()
        const x0 = e.clientX
        const y0 = e.clientY
        const orig = JSON.parse(JSON.stringify(o)) as Record<string, number>
        this.drag = (ev) => s.patchOverlay(o.id, run((ev.clientX - x0) / r.width, (ev.clientY - y0) / r.height, orig), `size:${o.id}`)
      })
      return g
    }

    if (o.kind === 'arrow') {
      // the two ends are dots; the line itself drags both
      const dot = (which: 1 | 2): HTMLElement => {
        const d = grip('dot', 'move', (dx, dy, orig) => ({ [`x${which}`]: clampNum(orig[`x${which}`] + dx, 0, 1), [`y${which}`]: clampNum(orig[`y${which}`] + dy, 0, 1) }))
        d.style.left = `${((o[`x${which}`] * f.W - b.x) / b.w) * 100}%`
        d.style.top = `${((o[`y${which}`] * f.H - b.y) / b.h) * 100}%`
        return d
      }
      host.append(dot(1), dot(2))
    } else if (o.kind === 'bubble' || o.kind === 'note' || o.kind === 'text') {
      const t = o as TextOverlay
      const tb = boundsOf({ ...t, kind: t.kind === 'bubble' ? 'note' : t.kind } as Overlay, f)
      // width handle on the right edge of the text box (not the pointer)
      const e = grip('edge-e', 'ew-resize', (dx, _dy, orig) => ({ w: clampNum(orig.w + dx, 0.08, Math.max(0.1, 1 - orig.x)) }))
      e.style.left = `${((tb.x + tb.w - b.x) / b.w) * 100}%`
      e.style.top = `${((tb.y + tb.h / 2 - b.y) / b.h) * 100}%`
      host.append(e)
      if (t.kind === 'bubble') {
        const tip = grip('dot tip', 'move', (dx, dy, orig) => ({ tx: clampNum(orig.tx + dx, 0, 1), ty: clampNum(orig.ty + dy, 0, 1) }))
        tip.style.left = `${((t.tx * f.W - b.x) / b.w) * 100}%`
        tip.style.top = `${((t.ty * f.H - b.y) / b.h) * 100}%`
        host.append(tip)
      }
    } else if (BOX_KINDS.includes(o.kind)) {
      for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const cursor = h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
        const g = grip(`h h-${h}`, cursor, (dx, dy, orig) => {
          let { x, y, w, h: hh } = orig
          const right = x + w
          const bottom = y + hh
          if (h.includes('w')) {
            x = clampNum(x + dx, 0, right - 0.03)
            w = right - x
          }
          if (h.includes('e')) w = clampNum(w + dx, 0.03, 1 - x)
          if (h.includes('n')) {
            y = clampNum(y + dy, 0, bottom - 0.03)
            hh = bottom - y
          }
          if (h.includes('s')) hh = clampNum(hh + dy, 0.03, 1 - y)
          return { x, y, w, h: hh }
        })
        host.append(g)
      }
    }
  }

  // ---------- crop ----------

  private aspectRatio(): number | null {
    return cropRatio(this.els.aspect.value)
  }

  private renderCrop(): void {
    const s = this.store
    const { cropLayer, cropBox, cropSize } = this.els
    cropLayer.hidden = !s.cropMode
    if (!s.cropMode) return
    const c = s.project.crop
    if (!c) {
      cropBox.hidden = true
      cropSize.textContent = ''
      return
    }
    cropBox.hidden = false
    Object.assign(cropBox.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` })
    const w = Math.floor((c.width * s.recording.width) / 2) * 2
    const h = Math.floor((c.height * s.recording.height) / 2) * 2
    cropSize.textContent = `${w} × ${h}`
  }

  private setCrop(c: Rect | null, merge = 'crop'): void {
    this.store.edit((p) => ({ ...p, crop: c }), { merge })
  }

  /** The biggest crop of this shape that fits the picture, in the middle. */
  fitAspect(): void {
    const s = this.store
    const ratio = this.aspectRatio()
    if (!ratio) {
      if (!s.project.crop) this.setCrop({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 })
      return
    }
    const frameRatio = s.recording.width / s.recording.height
    let w = 1
    let h = frameRatio / ratio
    if (h > 1) {
      h = 1
      w = ratio / frameRatio
    }
    this.setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h }, 'crop-fit')
  }

  private bindCrop(): void {
    const { cropLayer, cropBox } = this.els
    cropLayer.addEventListener('pointerdown', (e) => {
      const s = this.store
      const crop = s.project.crop
      if (!crop) return
      const handle = (e.target as HTMLElement).dataset.h ?? (cropBox.contains(e.target as Node) ? 'move' : null)
      if (!handle) return
      e.preventDefault()
      const r = this.rect()
      const x0 = e.clientX
      const y0 = e.clientY
      const start = { ...crop }
      this.drag = (ev) => {
        const dx = (ev.clientX - x0) / r.width
        const dy = (ev.clientY - y0) / r.height
        const minW = 32 / r.width
        const minH = 32 / r.height
        let { x, y, width, height } = start
        if (handle === 'move') {
          x = clampNum(start.x + dx, 0, 1 - start.width)
          y = clampNum(start.y + dy, 0, 1 - start.height)
        } else {
          if (handle.includes('w')) {
            x = clampNum(start.x + dx, 0, start.x + start.width - minW)
            width = start.x + start.width - x
          }
          if (handle.includes('e')) width = clampNum(start.width + dx, minW, 1 - start.x)
          if (handle.includes('n')) {
            y = clampNum(start.y + dy, 0, start.y + start.height - minH)
            height = start.y + start.height - y
          }
          if (handle.includes('s')) height = clampNum(start.height + dy, minH, 1 - start.y)
          const ratio = this.aspectRatio()
          if (ratio) {
            // the shape is locked, so convert the pixel ratio to the 0–1 units of each side
            const rn = ratio * (s.recording.height / s.recording.width)
            if (handle === 'n' || handle === 's') width = height * rn
            else height = width / rn
            if (handle.includes('n')) y = start.y + start.height - height
            if (handle.includes('w')) x = start.x + start.width - width
            if (x < 0 || y < 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) return
          }
        }
        this.setCrop({ x, y, width, height })
      }
    })
  }
}
