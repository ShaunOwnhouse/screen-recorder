import type {
  ArrowOverlay, BoxOverlay, Overlay, SpotlightOverlay, StepOverlay, TextOverlay, TitleCard
} from '../../shared/project.ts'

/**
 * Everything the editor draws on top of the video. The same code draws the preview and the pictures that are sent to
 * FFmpeg, so what you see is what you save. Sizes are in "1080p pixels": the frame is always 1080 units tall.
 */

export const FRAME_H = 1080

export interface Frame {
  /** Width in 1080p units (height is always FRAME_H). */
  W: number
  H: number
}

export const frameFor = (aspect: number): Frame => ({ W: Math.round(FRAME_H * aspect), H: FRAME_H })

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const SANS = "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"

/** The CSS font for one of the editor's font names ('sans' is the app's own). */
export function fontFamily(name: string): string {
  return !name || name === 'sans' ? SANS : `"${name.replace(/"/g, '')}", ${SANS}`
}

let measurer: CanvasRenderingContext2D | null = null
function measure(): CanvasRenderingContext2D {
  if (!measurer) measurer = document.createElement('canvas').getContext('2d')!
  return measurer
}

/** Breaks text into lines no wider than `maxWidth` (words are never split unless one is wider than the line). */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (!line || ctx.measureText(next).width <= maxWidth) line = next
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

interface TextLayout {
  lines: string[]
  box: Box
  lineHeight: number
  padX: number
  padY: number
  font: string
}

const LINE = 1.3

function layoutText(o: TextOverlay, f: Frame): TextLayout {
  const ctx = measure()
  const font = `600 ${o.size}px ${fontFamily(o.font)}`
  ctx.font = font
  const padX = o.kind === 'text' ? o.size * 0.15 : o.size * 0.75
  const padY = o.kind === 'text' ? o.size * 0.1 : o.size * 0.55
  const width = Math.max(o.size * 2, o.w * f.W)
  const lines = wrap(ctx, o.text || ' ', width - padX * 2)
  const lineHeight = o.size * LINE
  return { lines, font, lineHeight, padX, padY, box: { x: o.x * f.W, y: o.y * f.H, w: width, h: lines.length * lineHeight + padY * 2 } }
}

/** The box an overlay takes up, for selecting and moving it (no shadow or margin). */
export function boundsOf(o: Overlay, f: Frame): Box {
  switch (o.kind) {
    case 'bubble':
    case 'note':
    case 'text': {
      const b = layoutText(o, f).box
      if (o.kind !== 'bubble') return b
      // include the pointer
      const tx = o.tx * f.W
      const ty = o.ty * f.H
      const x = Math.min(b.x, tx)
      const y = Math.min(b.y, ty)
      return { x, y, w: Math.max(b.x + b.w, tx) - x, h: Math.max(b.y + b.h, ty) - y }
    }
    case 'arrow': {
      const pad = o.width * 2 + 8
      const x = Math.min(o.x1, o.x2) * f.W - pad
      const y = Math.min(o.y1, o.y2) * f.H - pad
      return { x, y, w: Math.abs(o.x2 - o.x1) * f.W + pad * 2, h: Math.abs(o.y2 - o.y1) * f.H + pad * 2 }
    }
    case 'step':
      return { x: o.x * f.W - o.size * 0.8, y: o.y * f.H - o.size * 0.8, w: o.size * 1.6, h: o.size * 1.6 }
    case 'pip':
      return { x: o.x * f.W, y: o.y * f.H, w: o.w * f.W, h: (o.w * f.W * (o.height || 9)) / (o.width || 16) }
    default:
      return { x: o.x * f.W, y: o.y * f.H, w: o.w * f.W, h: o.h * f.H }
  }
}

/** The area an overlay's picture covers, including its shadow, kept inside the frame. */
export function drawBounds(o: Overlay, f: Frame): Box {
  if (o.kind === 'spotlight') return { x: 0, y: 0, w: f.W, h: f.H }
  const b = boundsOf(o, f)
  const pad = 36
  const x = Math.max(0, Math.floor(b.x - pad))
  const y = Math.max(0, Math.floor(b.y - pad))
  const r = Math.min(f.W, Math.ceil(b.x + b.w + pad))
  const bt = Math.min(f.H, Math.ceil(b.y + b.h + pad))
  return { x, y, w: Math.max(1, r - x), h: Math.max(1, bt - y) }
}

function shadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'rgba(0,0,0,0.38)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 4
}

function drawText(ctx: CanvasRenderingContext2D, o: TextOverlay, f: Frame): void {
  const t = layoutText(o, f)
  const { box } = t
  ctx.save()
  if (o.kind !== 'text' || o.bg) {
    ctx.fillStyle = o.bg || '#ffffff'
    shadow(ctx)
    ctx.beginPath()
    const r = o.kind === 'note' ? 6 : Math.min(box.h / 2, o.size * 0.9)
    ctx.roundRect(box.x, box.y, box.w, box.h, r)
    if (o.kind === 'bubble') {
      // a pointer from the nearest edge to where it points, drawn as part of the same shape so the shadow is one piece
      const tx = o.tx * f.W
      const ty = o.ty * f.H
      const inside = tx >= box.x && tx <= box.x + box.w && ty >= box.y && ty <= box.y + box.h
      if (!inside) {
        const cx = Math.min(Math.max(tx, box.x + r + 16), box.x + box.w - r - 16)
        const cy = Math.min(Math.max(ty, box.y + r + 12), box.y + box.h - r - 12)
        const dx = tx < box.x ? box.x - tx : tx > box.x + box.w ? tx - (box.x + box.w) : 0
        const dy = ty < box.y ? box.y - ty : ty > box.y + box.h ? ty - (box.y + box.h) : 0
        const half = Math.min(15, box.h / 2 - 4)
        const pts: Array<[number, number]> =
          dx >= dy
            ? tx < box.x
              ? [[box.x + 1, cy - half], [tx, ty], [box.x + 1, cy + half]]
              : [[box.x + box.w - 1, cy - half], [tx, ty], [box.x + box.w - 1, cy + half]]
            : ty < box.y
              ? [[cx - half, box.y + 1], [tx, ty], [cx + half, box.y + 1]]
              : [[cx - half, box.y + box.h - 1], [tx, ty], [cx + half, box.y + box.h - 1]]
        // winding must match the rounded box (clockwise) for the two to merge instead of cancelling
        const cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
        const ordered = cross > 0 ? pts : [pts[2], pts[1], pts[0]]
        ctx.moveTo(ordered[0][0], ordered[0][1])
        ctx.lineTo(ordered[1][0], ordered[1][1])
        ctx.lineTo(ordered[2][0], ordered[2][1])
        ctx.closePath()
      }
    }
    ctx.fill('nonzero')
  }
  ctx.restore()

  ctx.save()
  ctx.font = t.font
  ctx.textBaseline = 'middle'
  ctx.fillStyle = o.color
  if (o.kind === 'text' && !o.bg) {
    // plain text gets a soft outline so it stays readable over any picture
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(3, o.size * 0.16)
    ctx.strokeStyle = luminance(o.color) > 0.5 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)'
  }
  t.lines.forEach((line, i) => {
    const y = box.y + t.padY + t.lineHeight * (i + 0.5)
    const w = ctx.measureText(line).width
    const x = o.align === 'center' ? box.x + (box.w - w) / 2 : box.x + t.padX
    if (o.kind === 'text' && !o.bg) ctx.strokeText(line, x, y)
    ctx.fillText(line, x, y)
  })
  ctx.restore()
}

function drawArrow(ctx: CanvasRenderingContext2D, o: ArrowOverlay, f: Frame): void {
  const x1 = o.x1 * f.W
  const y1 = o.y1 * f.H
  const x2 = o.x2 * f.W
  const y2 = o.y2 * f.H
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = o.width * 3.2 + 12
  const bx = x2 - Math.cos(angle) * head * 0.8
  const by = y2 - Math.sin(angle) * head * 0.8
  ctx.save()
  shadow(ctx)
  ctx.strokeStyle = o.color
  ctx.fillStyle = o.color
  ctx.lineWidth = o.width
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(bx, by)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - Math.cos(angle - 0.42) * head, y2 - Math.sin(angle - 0.42) * head)
  ctx.lineTo(x2 - Math.cos(angle + 0.42) * head, y2 - Math.sin(angle + 0.42) * head)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawBox(ctx: CanvasRenderingContext2D, o: BoxOverlay, f: Frame): void {
  const b = boundsOf(o, f)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(b.x, b.y, b.w, b.h, Math.min(o.radius, b.w / 2, b.h / 2))
  if (o.fill) {
    ctx.globalAlpha *= 0.28
    ctx.fillStyle = o.fill
    ctx.fill()
    ctx.globalAlpha /= 0.28
  }
  shadow(ctx)
  ctx.strokeStyle = o.color
  ctx.lineWidth = o.width
  ctx.stroke()
  ctx.restore()
}

function drawStep(ctx: CanvasRenderingContext2D, o: StepOverlay, f: Frame): void {
  const r = o.size * 0.8
  const cx = o.x * f.W
  const cy = o.y * f.H
  ctx.save()
  shadow(ctx)
  ctx.fillStyle = o.color
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.fillStyle = luminance(o.color) > 0.6 ? '#111827' : '#ffffff'
  ctx.font = `700 ${o.size}px ${SANS}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(o.n), cx, cy + o.size * 0.04)
  ctx.restore()
}

function drawSpotlight(ctx: CanvasRenderingContext2D, o: SpotlightOverlay, f: Frame): void {
  const b = boundsOf(o, f)
  ctx.save()
  ctx.fillStyle = `rgba(0,0,0,${Math.min(0.95, Math.max(0, o.dim))})`
  ctx.beginPath()
  ctx.rect(0, 0, f.W, f.H)
  if (o.shape === 'ellipse') ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(b.x, b.y, b.w, b.h, 10)
  ctx.fill('evenodd')
  ctx.restore()
}

/** Draws one overlay (comments, arrows, boxes, steps, spotlight). Blur, zoom and picture-in-picture are done by the player and FFmpeg. */
export function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay, f: Frame, alpha: number): void {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  switch (o.kind) {
    case 'bubble':
    case 'note':
    case 'text':
      drawText(ctx, o, f)
      break
    case 'arrow':
      drawArrow(ctx, o, f)
      break
    case 'box':
      drawBox(ctx, o, f)
      break
    case 'step':
      drawStep(ctx, o, f)
      break
    case 'spotlight':
      drawSpotlight(ctx, o, f)
      break
    default:
      break
  }
  ctx.restore()
}

/** A title card: a coloured (or gradient) page with a title and a line underneath. */
export function drawCard(ctx: CanvasRenderingContext2D, card: TitleCard, f: Frame): void {
  const g = ctx.createLinearGradient(0, 0, 0, f.H)
  g.addColorStop(0, card.bg[0])
  g.addColorStop(1, card.bg[1])
  ctx.fillStyle = g
  ctx.fillRect(0, 0, f.W, f.H)
  const family = fontFamily(card.font)
  const maxWidth = f.W * 0.8
  const titleSize = 104
  const subSize = 48
  ctx.fillStyle = card.color
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 ${titleSize}px ${family}`
  const title = wrap(ctx, card.title || ' ', maxWidth)
  ctx.font = `400 ${subSize}px ${family}`
  const sub = card.subtitle ? wrap(ctx, card.subtitle, maxWidth) : []
  const titleH = title.length * titleSize * 1.15
  const subH = sub.length * subSize * 1.35
  const total = titleH + (sub.length ? 28 + subH : 0)
  let y = (f.H - total) / 2 + titleSize * 0.85
  const place = (line: string): number => {
    const w = ctx.measureText(line).width
    return card.align === 'center' ? (f.W - w) / 2 : f.W * 0.1
  }
  ctx.font = `700 ${titleSize}px ${family}`
  for (const line of title) {
    ctx.fillText(line, place(line), y)
    y += titleSize * 1.15
  }
  y += 28 - titleSize * 0.15 + subSize * 0.2
  ctx.font = `400 ${subSize}px ${family}`
  ctx.globalAlpha = 0.85
  for (const line of sub) {
    ctx.fillText(line, place(line), y)
    y += subSize * 1.35
  }
  ctx.globalAlpha = 1
}

/** 0 (dark) – 1 (light) for a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 1
  const n = parseInt(m[1], 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

/** An overlay drawn on its own, at the size of the finished video, for FFmpeg. */
export async function renderOverlayPicture(
  o: Overlay, f: Frame, outH: number
): Promise<{ x: number; y: number; width: number; height: number; png: Uint8Array }> {
  const scale = outH / FRAME_H
  const b = drawBounds(o, f)
  const x = Math.round(b.x * scale)
  const y = Math.round(b.y * scale)
  const width = Math.max(1, Math.round(b.w * scale))
  const height = Math.max(1, Math.round(b.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.scale(width / b.w, height / b.h)
  ctx.translate(-b.x, -b.y)
  drawOverlay(ctx, o, f, 1)
  return { x, y, width, height, png: await canvasPng(canvas) }
}

export async function renderCardPicture(card: TitleCard, f: Frame, outW: number, outH: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')!
  ctx.scale(outW / f.W, outH / f.H)
  drawCard(ctx, card, f)
  return canvasPng(canvas)
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (blob) => (blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error('Could not draw a picture for the video.'))), 'image/png')
  )
}
