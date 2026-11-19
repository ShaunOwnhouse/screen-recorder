import { isFullRange, keepOnly, playablePosition, removeRange, totalDuration } from '../shared/segments.ts'
import type { EditorSource, Rect, Segment } from '../shared/types.ts'

const api = window.editor
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const stage = $('stage')
const stageMsg = $('stage-msg')
const timeline = $('timeline')
const segmentsEl = $('segments')
const selectionEl = $('selection')
const playhead = $('playhead')
const cropLayer = $('crop')
const cropBox = $('crop-box')
const cropSize = $('crop-size')
const aspectSel = $<HTMLSelectElement>('aspect')
const nameInput = $<HTMLInputElement>('name')
const busy = $('busy')
const busyTitle = $('busy-title')
const busyBar = $('busy-bar')
const busyDetail = $('busy-detail')
const busyCancel = $<HTMLButtonElement>('busy-cancel')

let src: EditorSource | null = null
let duration = 0
let keep: Segment[] = []
let history: Segment[][] = []
let sel: { a: number; b: number } | null = null
let crop: Rect | null = null
let cropOn = false
let triedProxy = false
let saving = false

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function fmt(t: number): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

function fmtBytes(b: number): string {
  return b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`
}

function frameStep(): number {
  return 1 / (src?.meta.fps || 30)
}

// ---------- timeline ----------

function timeAt(clientX: number): number {
  const r = timeline.getBoundingClientRect()
  return clamp(((clientX - r.left) / r.width) * duration, 0, duration)
}

function pct(t: number): string {
  return `${(duration ? (t / duration) * 100 : 0).toFixed(4)}%`
}

function renderTimeline(): void {
  const parts: HTMLElement[] = []
  let cursor = 0
  const add = (a: number, b: number, kind: 'kept' | 'removed'): void => {
    if (b - a <= 0) return
    const d = document.createElement('div')
    d.className = `seg ${kind}`
    d.style.left = pct(a)
    d.style.width = `${((b - a) / duration) * 100}%`
    parts.push(d)
  }
  for (const [a, b] of keep) {
    add(cursor, a, 'removed')
    add(a, b, 'kept')
    cursor = b
  }
  add(cursor, duration, 'removed')
  segmentsEl.replaceChildren(...parts)

  selectionEl.hidden = !sel
  if (sel) {
    const [a, b] = sel.a <= sel.b ? [sel.a, sel.b] : [sel.b, sel.a]
    selectionEl.style.left = pct(a)
    selectionEl.style.width = `${((b - a) / duration) * 100}%`
  }
  renderToolState()
}

function renderPlayhead(): void {
  playhead.style.left = pct(video.currentTime)
  $('time').textContent = `${fmt(video.currentTime)} / ${fmt(duration)}`
}

function renderToolState(): void {
  const hasSel = !!sel && Math.abs(sel.b - sel.a) >= 0.05
  ;($('keep-sel') as HTMLButtonElement).disabled = !hasSel
  ;($('delete-sel') as HTMLButtonElement).disabled = !hasSel
  ;($('undo') as HTMLButtonElement).disabled = !history.length
  ;($('reset') as HTMLButtonElement).disabled = isFullRange(keep, duration) && !crop
  const edited = !isFullRange(keep, duration)
  $('kept').textContent = edited ? `Final length ${fmt(totalDuration(keep))}` : ''
}

function applyEdit(next: Segment[]): void {
  if (!next.length) {
    flash('That would remove the whole recording.')
    return
  }
  history.push(keep)
  keep = next
  sel = null
  renderTimeline()
  const pos = playablePosition(keep, video.currentTime)
  video.currentTime = pos ?? keep[0][0]
}

function flash(text: string): void {
  stageMsg.textContent = text
  stageMsg.hidden = false
  setTimeout(() => (stageMsg.hidden = true), 2500)
}

let drag: { mode: 'new' | 'in' | 'out'; startX: number; startT: number } | null = null

timeline.addEventListener('pointerdown', (e) => {
  if (!duration) return
  timeline.setPointerCapture(e.pointerId)
  const edge = (e.target as HTMLElement).dataset.edge as 'in' | 'out' | undefined
  if (edge && sel) {
    if (sel.a > sel.b) sel = { a: sel.b, b: sel.a }
    drag = { mode: edge, startX: e.clientX, startT: 0 }
    return
  }
  const t = timeAt(e.clientX)
  drag = { mode: 'new', startX: e.clientX, startT: t }
  video.currentTime = t
})

timeline.addEventListener('pointermove', (e) => {
  if (!drag) return
  const t = timeAt(e.clientX)
  if (drag.mode === 'new') {
    if (Math.abs(e.clientX - drag.startX) < 4) return
    sel = { a: drag.startT, b: t }
  } else if (sel) {
    if (drag.mode === 'in') sel.a = t
    else sel.b = t
  }
  video.currentTime = t
  renderTimeline()
})

timeline.addEventListener('pointerup', (e) => {
  if (drag?.mode === 'new' && Math.abs(e.clientX - drag.startX) < 4) sel = null
  drag = null
  renderTimeline()
})

function markIn(): void {
  const t = video.currentTime
  sel = sel ? { a: t, b: Math.max(sel.a, sel.b) } : { a: t, b: duration }
  renderTimeline()
}

function markOut(): void {
  const t = video.currentTime
  sel = sel ? { a: Math.min(sel.a, sel.b), b: t } : { a: 0, b: t }
  renderTimeline()
}

function selRange(): [number, number] {
  return sel!.a <= sel!.b ? [sel!.a, sel!.b] : [sel!.b, sel!.a]
}

// ---------- playback ----------

function togglePlay(): void {
  if (video.paused) {
    const pos = playablePosition(keep, video.currentTime)
    video.currentTime = pos ?? keep[0]?.[0] ?? 0
    void video.play()
  } else video.pause()
}

function tick(): void {
  if (!video.paused && keep.length) {
    // Skip over removed parts so playback previews the final cut.
    const pos = playablePosition(keep, video.currentTime)
    if (pos === null) {
      video.pause()
      video.currentTime = keep[keep.length - 1][1]
    } else if (pos > video.currentTime + 0.02) video.currentTime = pos
  }
  renderPlayhead()
  requestAnimationFrame(tick)
}

video.addEventListener('play', () => ($('play-icon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'))
video.addEventListener('pause', () => ($('play-icon').innerHTML = '<path d="M8 5v14l11-7z"/>'))

// ---------- crop ----------

function contentRect(): { left: number; top: number; width: number; height: number } {
  const r = stage.getBoundingClientRect()
  const ar = src ? src.meta.width / src.meta.height : 16 / 9
  let width = r.width
  let height = width / ar
  if (height > r.height) {
    height = r.height
    width = height * ar
  }
  return { left: (r.width - width) / 2, top: (r.height - height) / 2, width, height }
}

function aspectRatio(): number | null {
  const v = aspectSel.value
  if (v === 'free') return null
  const [w, h] = v.split(':').map(Number)
  return w / h
}

function renderCrop(): void {
  cropLayer.hidden = !cropOn
  $('crop-toggle').setAttribute('aria-pressed', String(cropOn))
  aspectSel.hidden = !cropOn
  $('crop-reset').hidden = !cropOn
  if (!cropOn || !crop || !src) return
  const c = contentRect()
  Object.assign(cropLayer.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` })
  Object.assign(cropBox.style, {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`
  })
  const w = Math.floor((crop.width * src.meta.width) / 2) * 2
  const h = Math.floor((crop.height * src.meta.height) / 2) * 2
  cropSize.textContent = `${w} × ${h}`
  renderToolState()
}

function fitAspect(): void {
  if (!src) return
  const ratio = aspectRatio()
  if (!ratio) return
  // Largest rectangle of this shape that fits the frame, centred.
  const frameRatio = src.meta.width / src.meta.height
  let w = 1
  let h = frameRatio / ratio
  if (h > 1) {
    h = 1
    w = ratio / frameRatio
  }
  crop = { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h }
}

let cropDrag: { handle: string; x: number; y: number; start: Rect } | null = null

cropLayer.addEventListener('pointerdown', (e) => {
  if (!crop) return
  const handle = (e.target as HTMLElement).dataset.h ?? (e.target === cropBox || cropBox.contains(e.target as Node) ? 'move' : null)
  if (!handle) return
  cropLayer.setPointerCapture(e.pointerId)
  cropDrag = { handle, x: e.clientX, y: e.clientY, start: { ...crop } }
  e.preventDefault()
})

cropLayer.addEventListener('pointermove', (e) => {
  if (!cropDrag || !src) return
  const c = contentRect()
  const dx = (e.clientX - cropDrag.x) / c.width
  const dy = (e.clientY - cropDrag.y) / c.height
  const s = cropDrag.start
  const minW = 32 / c.width
  const minH = 32 / c.height
  let { x, y, width, height } = s

  if (cropDrag.handle === 'move') {
    x = clamp(s.x + dx, 0, 1 - s.width)
    y = clamp(s.y + dy, 0, 1 - s.height)
  } else {
    const h = cropDrag.handle
    if (h.includes('w')) {
      x = clamp(s.x + dx, 0, s.x + s.width - minW)
      width = s.x + s.width - x
    }
    if (h.includes('e')) width = clamp(s.width + dx, minW, 1 - s.x)
    if (h.includes('n')) {
      y = clamp(s.y + dy, 0, s.y + s.height - minH)
      height = s.y + s.height - y
    }
    if (h.includes('s')) height = clamp(s.height + dy, minH, 1 - s.y)

    const ratio = aspectRatio()
    if (ratio) {
      // Normalised units differ per axis, so convert the pixel ratio before locking.
      const rn = ratio * (src.meta.height / src.meta.width)
      if (h === 'n' || h === 's') width = height * rn
      else height = width / rn
      if (h.includes('n')) y = s.y + s.height - height
      if (h.includes('w')) x = s.x + s.width - width
      if (x < 0 || y < 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) return
    }
  }
  crop = { x, y, width, height }
  renderCrop()
})

cropLayer.addEventListener('pointerup', () => (cropDrag = null))

function setCropMode(on: boolean): void {
  cropOn = on
  if (on && !crop) {
    if (aspectRatio()) fitAspect()
    else crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }
  }
  renderCrop()
}

// ---------- saving ----------

function showBusy(title: string, detail: string, cancellable: boolean): void {
  busy.hidden = false
  busyTitle.textContent = title
  busyDetail.textContent = detail
  busyBar.style.transform = 'scaleX(0)'
  busyBar.parentElement!.classList.toggle('indeterminate', !cancellable)
  busyCancel.hidden = !cancellable
  busyCancel.textContent = 'Cancel'
}

async function save(saveAs: boolean): Promise<void> {
  if (!src || saving) return
  saving = true
  video.pause()
  const edited = !isFullRange(keep, duration) || (!!crop && cropOn)
  showBusy(
    edited ? 'Exporting your edit…' : 'Saving…',
    edited ? 'Re-encoding at the same quality as the recording.' : 'Moving the original — no re-encode, no quality loss.',
    edited
  )
  if (saveAs) busy.hidden = true

  const res = await api.save({
    segments: keep,
    crop: cropOn ? crop : null,
    fileName: nameInput.value,
    saveAs
  })
  saving = false
  if (res.ok) return // The main process closes this window.
  if (!res.error) {
    busy.hidden = true
    return
  }
  busy.hidden = false
  busyTitle.textContent = 'Could not save'
  busyDetail.textContent = res.error
  busyCancel.hidden = false
  busyCancel.textContent = 'Close'
}

api.onProgress((f) => {
  busy.hidden = false
  busyBar.parentElement!.classList.remove('indeterminate')
  busyBar.style.transform = `scaleX(${f})`
  busyDetail.textContent = `${Math.round(f * 100)}%`
})

busyCancel.addEventListener('click', () => {
  if (busyCancel.textContent === 'Close') busy.hidden = true
  else void api.cancelExport()
})

// ---------- wiring ----------

function bind(): void {
  $('play').addEventListener('click', togglePlay)
  video.addEventListener('click', togglePlay)
  $('mark-in').addEventListener('click', markIn)
  $('mark-out').addEventListener('click', markOut)
  $('keep-sel').addEventListener('click', () => sel && applyEdit(keepOnly(keep, ...selRange())))
  $('delete-sel').addEventListener('click', () => sel && applyEdit(removeRange(keep, ...selRange())))
  $('undo').addEventListener('click', () => {
    const prev = history.pop()
    if (prev) keep = prev
    renderTimeline()
  })
  $('reset').addEventListener('click', () => {
    history.push(keep)
    keep = [[0, duration]]
    sel = null
    crop = null
    setCropMode(false)
    renderTimeline()
  })
  $('crop-toggle').addEventListener('click', () => setCropMode(!cropOn))
  $('crop-reset').addEventListener('click', () => {
    crop = null
    setCropMode(false)
    renderToolState()
  })
  aspectSel.addEventListener('change', () => {
    fitAspect()
    if (!aspectRatio() && !crop) crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }
    renderCrop()
  })
  $('save').addEventListener('click', () => void save(false))
  $('save-as').addEventListener('click', () => void save(true))
  $('discard').addEventListener('click', () => void api.discard())
  window.addEventListener('resize', renderCrop)

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || saving) return
    if (e.key === ' ') {
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'i' || e.key === 'I') markIn()
    else if (e.key === 'o' || e.key === 'O') markOut()
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) applyEdit(removeRange(keep, ...selRange()))
    else if (e.key === 'Escape') {
      sel = null
      renderTimeline()
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) $('undo').click()
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      video.pause()
      const step = e.shiftKey ? 1 : frameStep()
      video.currentTime = clamp(video.currentTime + (e.key === 'ArrowLeft' ? -step : step), 0, duration)
    }
  })
}

async function loadPreview(url: string): Promise<void> {
  video.src = url
  video.load()
}

video.addEventListener('loadedmetadata', () => {
  if (!duration && Number.isFinite(video.duration) && video.duration > 0) {
    duration = video.duration
    keep = [[0, duration]]
    renderTimeline()
  }
  stageMsg.hidden = true
  renderCrop()
})

video.addEventListener('error', async () => {
  if (triedProxy) {
    stageMsg.textContent = 'Preview unavailable — you can still trim, crop and save.'
    stageMsg.hidden = false
    return
  }
  triedProxy = true
  // Chromium can't decode 4:4:4 video, so preview a lightweight copy; edits still apply to the original.
  stageMsg.textContent = 'Preparing preview…'
  stageMsg.hidden = false
  const url = await api.makeProxy()
  if (url) await loadPreview(url)
  else {
    stageMsg.textContent = 'Preview unavailable — you can still trim, crop and save.'
  }
})

function showLoadError(message: string): void {
  stageMsg.replaceChildren()
  const text = document.createElement('p')
  text.textContent = message
  const actions = document.createElement('div')
  actions.className = 'msg-actions'
  const discard = document.createElement('button')
  discard.type = 'button'
  discard.className = 'primary'
  discard.textContent = 'Discard recording'
  discard.addEventListener('click', () => void api.discard())
  const reveal = document.createElement('button')
  reveal.type = 'button'
  reveal.className = 'ghost'
  reveal.textContent = 'Show file'
  reveal.addEventListener('click', () => void api.reveal())
  actions.append(reveal, discard)
  stageMsg.append(text, actions)
  stageMsg.classList.add('interactive')
  stageMsg.hidden = false
  for (const id of ['save', 'save-as', 'play', 'mark-in', 'mark-out', 'crop-toggle']) ($(id) as HTMLButtonElement).disabled = true
  nameInput.disabled = true
}

async function init(): Promise<void> {
  bind()
  const loaded = await api.load()
  if ('error' in loaded) {
    showLoadError(loaded.error)
    return
  }
  src = loaded.source
  const m = src.meta
  duration = m.duration
  keep = [[0, duration]]
  nameInput.value = src.defaultName
  $('dest').textContent = `Saves to ${src.outputDir}`
  $('info').textContent = [
    `${m.width}×${m.height}`,
    `${m.fps} fps`,
    fmt(m.duration),
    m.yuv444 ? '4:4:4 colour' : null,
    m.hasAudio ? 'with audio' : 'no audio',
    fmtBytes(src.sizeBytes)
  ]
    .filter(Boolean)
    .join(' · ')
  await loadPreview(src.url)
  renderTimeline()
  requestAnimationFrame(tick)
}

void init()
