import { imageFormat, IMAGE_FORMATS } from '../shared/formats.ts'
import type { ImageFormat, ShotSource } from '../shared/types.ts'

const api = window.shot
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const view = $<HTMLCanvasElement>('view')
const box = $('box')
const wrap = $('wrap')
const cropLayer = $('crop')
const cropBox = $('crop-box')
const cropSize = $('crop-size')
const nameInput = $<HTMLInputElement>('name')
const formatSel = $<HTMLSelectElement>('format')
const noticeEl = $('format-notice')
const sizeSel = $<HTMLSelectElement>('size')

type Pt = [number, number]
type Op =
  | { t: 'pen'; color: string; width: number; pts: Pt[] }
  | { t: 'hl'; color: string; width: number; pts: Pt[] }
  | { t: 'arrow'; color: string; width: number; a: Pt; b: Pt }
  | { t: 'text'; color: string; size: number; at: Pt; text: string }
type Tool = 'none' | 'crop' | 'pen' | 'hl' | 'arrow' | 'text'
interface Snapshot {
  base: HTMLCanvasElement
  ops: Op[]
  edited: boolean
}

const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#111827', '#ffffff']

let src: ShotSource | null = null
let base = document.createElement('canvas')
let ops: Op[] = []
let live: Op | null = null
let undoStack: Snapshot[] = []
let redoStack: Snapshot[] = []
let edited = false
let tool: Tool = 'none'
let color = COLORS[0]
let zoom: 'fit' | 1 = 'fit'
let saving = false
type CropRect = { x: number; y: number; w: number; h: number }
let cropRect: CropRect | null = null
let textInput: HTMLInputElement | null = null

// ---------- drawing ----------

/** Line thickness scales with the picture so annotations look the same on a 1080p and a 4K capture. */
const unit = (): number => Math.max(1, base.width / 900)
const stroke = (): number => Math.round(unit() * 2.5 * Number(sizeSel.value))
const fontSize = (): number => Math.round(unit() * 12 * (1 + (Number(sizeSel.value) - 1) * 0.6)) + 6

function drawOp(ctx: CanvasRenderingContext2D, op: Op): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (op.t === 'pen' || op.t === 'hl') {
    ctx.strokeStyle = op.color
    ctx.lineWidth = op.width
    if (op.t === 'hl') {
      ctx.globalAlpha = 0.38
      ctx.lineCap = 'butt'
    }
    ctx.beginPath()
    const [first, ...rest] = op.pts
    ctx.moveTo(first[0], first[1])
    if (!rest.length) ctx.lineTo(first[0] + 0.01, first[1])
    for (const p of rest) ctx.lineTo(p[0], p[1])
    ctx.stroke()
  } else if (op.t === 'arrow') {
    const [ax, ay] = op.a
    const [bx, by] = op.b
    const len = Math.hypot(bx - ax, by - ay)
    if (len > 1) {
      const angle = Math.atan2(by - ay, bx - ax)
      const head = Math.max(14, op.width * 4.5)
      ctx.strokeStyle = op.color
      ctx.fillStyle = op.color
      ctx.lineWidth = op.width
      // Stop the shaft short of the tip so the arrow head stays sharp.
      const shaft = Math.max(0, len - head * 0.7)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax + Math.cos(angle) * shaft, ay + Math.sin(angle) * shaft)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(bx, by)
      ctx.lineTo(bx - head * Math.cos(angle - Math.PI / 7), by - head * Math.sin(angle - Math.PI / 7))
      ctx.lineTo(bx - head * Math.cos(angle + Math.PI / 7), by - head * Math.sin(angle + Math.PI / 7))
      ctx.closePath()
      ctx.fill()
    }
  } else {
    ctx.fillStyle = op.color
    ctx.font = `600 ${op.size}px "Segoe UI", system-ui, -apple-system, sans-serif`
    ctx.textBaseline = 'top'
    op.text.split('\n').forEach((line, i) => ctx.fillText(line, op.at[0], op.at[1] + i * op.size * 1.2))
  }
  ctx.restore()
}

function render(): void {
  const ctx = view.getContext('2d')!
  ctx.drawImage(base, 0, 0)
  for (const op of ops) drawOp(ctx, op)
  if (live) drawOp(ctx, live)
}

/** The picture with every annotation burned in, at the capture's real pixel size. */
function flatten(): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = base.width
  out.height = base.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(base, 0, 0)
  for (const op of ops) drawOp(ctx, op)
  return out
}

// ---------- layout ----------

function cssScale(): number {
  if (zoom === 1) return 1
  // Leave the padding around the picture (see .shot-wrap) free for the crop handles.
  const w = wrap.clientWidth - 38
  const h = wrap.clientHeight - 38
  return Math.min(1, w / base.width, h / base.height)
}

function layout(): void {
  const s = cssScale()
  view.style.width = `${Math.round(base.width * s)}px`
  view.style.height = `${Math.round(base.height * s)}px`
  $('zoom-fit').setAttribute('aria-pressed', String(zoom === 'fit'))
  $('zoom-100').setAttribute('aria-pressed', String(zoom === 1))
  renderCropBox()
}

function applyBase(next: HTMLCanvasElement): void {
  base = next
  view.width = base.width
  view.height = base.height
  layout()
  render()
  $('info').textContent = `${base.width} × ${base.height} px · exact screen pixels${edited ? ' · edited' : ''}`
}

new ResizeObserver(layout).observe(wrap)

// ---------- history ----------

function pushUndo(): void {
  undoStack.push({ base, ops: ops.slice(), edited })
  if (undoStack.length > 30) undoStack.shift()
  redoStack = []
}

function touched(): void {
  edited = true
  api.setDirty(true)
  updateButtons()
  $('info').textContent = `${base.width} × ${base.height} px · exact screen pixels · edited`
}

function restore(s: Snapshot): void {
  ops = s.ops.slice()
  edited = s.edited
  api.setDirty(edited)
  if (s.base !== base) applyBase(s.base)
  else render()
  updateButtons()
}

function undo(): void {
  const prev = undoStack.pop()
  if (!prev) return
  redoStack.push({ base, ops: ops.slice(), edited })
  restore(prev)
}

function redo(): void {
  const next = redoStack.pop()
  if (!next) return
  undoStack.push({ base, ops: ops.slice(), edited })
  restore(next)
}

function updateButtons(): void {
  ;($('undo') as HTMLButtonElement).disabled = !undoStack.length
  ;($('redo') as HTMLButtonElement).disabled = !redoStack.length
}

// ---------- tools ----------

function setTool(next: Tool): void {
  commitText()
  if (tool === 'crop' && next !== 'crop') cropRect = null
  tool = tool === next ? 'none' : next
  if (tool === 'crop') cropRect = { x: 0, y: 0, w: base.width, h: base.height }
  document.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)))
  $('t-crop').setAttribute('aria-pressed', String(tool === 'crop'))
  // Hidden but still taking up room, so the toolbar doesn't grow and shove the picture around when cropping starts.
  $('crop-actions').classList.toggle('ghosted', tool !== 'crop')
  cropLayer.hidden = tool !== 'crop'
  view.classList.toggle('draw', tool === 'pen' || tool === 'hl' || tool === 'arrow')
  view.classList.toggle('text', tool === 'text')
  renderCropBox()
}

const toImage = (e: PointerEvent): Pt => {
  const r = view.getBoundingClientRect()
  return [((e.clientX - r.left) * view.width) / r.width, ((e.clientY - r.top) * view.height) / r.height]
}

view.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || tool === 'none' || tool === 'crop') return
  const p = toImage(e)
  if (tool === 'text') {
    startText(p)
    e.preventDefault()
    return
  }
  view.setPointerCapture(e.pointerId)
  live =
    tool === 'arrow'
      ? { t: 'arrow', color, width: stroke(), a: p, b: p }
      : tool === 'hl'
        ? { t: 'hl', color, width: stroke() * 5, pts: [p] }
        : { t: 'pen', color, width: stroke(), pts: [p] }
  render()
})

view.addEventListener('pointermove', (e) => {
  if (!live) return
  const p = toImage(e)
  if (live.t === 'arrow') live.b = p
  else if (live.t === 'pen' || live.t === 'hl') live.pts.push(p)
  render()
})

const finishStroke = (): void => {
  if (!live) return
  pushUndo()
  ops.push(live)
  live = null
  touched()
  render()
}
view.addEventListener('pointerup', finishStroke)
view.addEventListener('pointercancel', finishStroke)

// Text: type straight onto the picture.
function startText(at: Pt): void {
  commitText()
  const s = cssScale()
  const size = fontSize()
  const input = document.createElement('input')
  input.className = 'text-input'
  input.style.left = `${at[0] * s}px`
  input.style.top = `${at[1] * s}px`
  input.style.fontSize = `${size * s}px`
  input.style.color = color
  input.dataset.x = String(at[0])
  input.dataset.y = String(at[1])
  input.dataset.size = String(size)
  input.dataset.color = color
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') commitText()
    else if (e.key === 'Escape') {
      input.remove()
      textInput = null
    }
  })
  input.addEventListener('blur', () => commitText())
  box.append(input)
  textInput = input
  input.focus()
}

function commitText(): void {
  const input = textInput
  if (!input) return
  textInput = null
  const text = input.value.trim()
  input.remove()
  if (!text) return
  pushUndo()
  ops.push({
    t: 'text', color: input.dataset.color!, size: Number(input.dataset.size), at: [Number(input.dataset.x), Number(input.dataset.y)], text
  })
  touched()
  render()
}

// ---------- crop ----------

function renderCropBox(): void {
  if (tool !== 'crop' || !cropRect) return
  Object.assign(cropBox.style, {
    left: `${(cropRect.x / base.width) * 100}%`,
    top: `${(cropRect.y / base.height) * 100}%`,
    width: `${(cropRect.w / base.width) * 100}%`,
    height: `${(cropRect.h / base.height) * 100}%`
  })
  cropSize.textContent = `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)}`
}

let cropDrag: { handle: string; x: number; y: number; start: CropRect } | null = null

cropLayer.addEventListener('pointerdown', (e) => {
  if (!cropRect) return
  const target = e.target as HTMLElement
  const handle = target.dataset.h ?? (cropBox.contains(target) ? 'move' : null)
  if (!handle) return
  cropLayer.setPointerCapture(e.pointerId)
  cropDrag = { handle, x: e.clientX, y: e.clientY, start: { ...cropRect } }
  e.preventDefault()
})

cropLayer.addEventListener('pointermove', (e) => {
  if (!cropDrag || !cropRect) return
  const r = view.getBoundingClientRect()
  const dx = ((e.clientX - cropDrag.x) * base.width) / r.width
  const dy = ((e.clientY - cropDrag.y) * base.height) / r.height
  const s = cropDrag.start
  const min = 8
  let { x, y, w, h } = s
  if (cropDrag.handle === 'move') {
    x = Math.min(Math.max(0, s.x + dx), base.width - s.w)
    y = Math.min(Math.max(0, s.y + dy), base.height - s.h)
  } else {
    const hd = cropDrag.handle
    if (hd.includes('w')) {
      const nx = Math.min(Math.max(0, s.x + dx), s.x + s.w - min)
      w = s.w + (s.x - nx)
      x = nx
    }
    if (hd.includes('e')) w = Math.min(Math.max(min, s.w + dx), base.width - s.x)
    if (hd.includes('n')) {
      const ny = Math.min(Math.max(0, s.y + dy), s.y + s.h - min)
      h = s.h + (s.y - ny)
      y = ny
    }
    if (hd.includes('s')) h = Math.min(Math.max(min, s.h + dy), base.height - s.y)
  }
  cropRect = { x, y, w, h }
  renderCropBox()
})
cropLayer.addEventListener('pointerup', () => (cropDrag = null))

function applyCrop(): void {
  if (!cropRect) return
  const x = Math.round(cropRect.x)
  const y = Math.round(cropRect.y)
  const w = Math.max(1, Math.min(Math.round(cropRect.w), base.width - x))
  const h = Math.max(1, Math.min(Math.round(cropRect.h), base.height - y))
  const flat = flatten()
  if (w === base.width && h === base.height) return setTool('crop')
  pushUndo()
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  out.getContext('2d')!.drawImage(flat, x, y, w, h, 0, 0, w, h)
  ops = []
  setTool('crop')
  edited = true
  api.setDirty(true)
  applyBase(out)
  updateButtons()
}

// ---------- saving ----------

function toast(text: string, bad = false): void {
  const el = $('toast')
  el.textContent = text
  el.className = `toast${bad ? ' bad' : ''}`
  el.hidden = false
  setTimeout(() => (el.hidden = true), bad ? 5000 : 1800)
}

async function currentPng(): Promise<Uint8Array | null> {
  commitText()
  if (!edited) return null
  const blob = await new Promise<Blob | null>((resolve) => flatten().toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

async function save(saveAs: boolean): Promise<void> {
  if (!src || saving) return
  saving = true
  try {
    const res = await api.save({ png: await currentPng(), fileName: nameInput.value, saveAs, format: formatSel.value as ImageFormat })
    if (!res.ok && res.error) toast(`Could not save: ${res.error}`, true)
  } finally {
    saving = false
  }
}

async function copy(): Promise<void> {
  const ok = await api.copy({ png: await currentPng() })
  toast(ok ? 'Copied to the clipboard' : 'Could not copy', !ok)
}

function renderFormat(): void {
  const id = formatSel.value as ImageFormat
  const f = imageFormat(id)
  $('ext').textContent = `.${f.ext}`
  const n = f.notice
  noticeEl.className = `notice ${n ? (n.level === 'warn' ? '' : n.level) : 'info'}`.trim()
  $('notice-title').textContent = n ? n.title : ''
  $('notice-text').textContent = n
    ? n.text
    : 'Saving as PNG keeps every pixel exactly as it was on your screen. Copy puts the same full-quality image on the clipboard to paste into chat, email or documents — without saving a file.'
  $('use-default').hidden = !n
  ;(noticeEl.querySelector('.ic') as HTMLElement).textContent = n ? '⚠' : 'ℹ'
}

// ---------- wiring ----------

function bind(): void {
  $('t-crop').addEventListener('click', () => setTool('crop'))
  document.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)))
  $('crop-apply').addEventListener('click', applyCrop)
  $('crop-cancel').addEventListener('click', () => setTool('crop'))
  $('zoom-fit').addEventListener('click', () => ((zoom = 'fit'), layout()))
  $('zoom-100').addEventListener('click', () => ((zoom = 1), layout()))
  $('undo').addEventListener('click', undo)
  $('redo').addEventListener('click', redo)
  $('copy').addEventListener('click', () => void copy())
  $('save').addEventListener('click', () => void save(false))
  $('save-as').addEventListener('click', () => void save(true))
  $('discard').addEventListener('click', () => void api.discard(edited))
  $('use-default').addEventListener('click', () => {
    formatSel.value = 'png'
    renderFormat()
  })
  formatSel.addEventListener('change', renderFormat)

  const swatches = $('swatches')
  for (const c of COLORS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.style.background = c
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-label', c)
    b.setAttribute('aria-checked', String(c === color))
    b.addEventListener('click', () => {
      color = c
      swatches.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
    })
    swatches.append(b)
  }

  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT'
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save(false)
    } else if (mod && e.key.toLowerCase() === 'c' && !typing) {
      e.preventDefault()
      void copy()
    } else if (tool === 'crop' && e.key === 'Enter' && !typing) applyCrop()
    else if (tool === 'crop' && e.key === 'Escape') setTool('crop')
  })
}

function showLoadError(message: string): void {
  const msg = $('stage-msg')
  msg.textContent = message
  msg.hidden = false
  for (const id of ['save', 'save-as', 'copy']) ($(id) as HTMLButtonElement).disabled = true
}

async function init(): Promise<void> {
  bind()
  const loaded = await api.load()
  if ('error' in loaded) return showLoadError(loaded.error)
  src = loaded.source
  nameInput.value = src.defaultName
  formatSel.replaceChildren(
    ...IMAGE_FORMATS.filter((f) => src!.formats.includes(f.id)).map((f) => {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      return o
    })
  )
  formatSel.value = src.format
  renderFormat()
  $('dest').textContent = `Saves to ${src.outputDir}`

  const bytes = await api.bytes()
  if (!bytes.byteLength) return showLoadError('This screenshot is no longer available.')
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const first = document.createElement('canvas')
  first.width = bmp.width
  first.height = bmp.height
  first.getContext('2d')!.drawImage(bmp, 0, 0)
  applyBase(first)
  document.body.dataset.ready = '1'
}

void init()
