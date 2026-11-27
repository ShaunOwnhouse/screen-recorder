import { addCameraClip, isDrawn, isPlain, newProject, pruneMissing, SPEEDS, type Clip, type Overlay } from '../shared/project.ts'
import { videoFormat, VIDEO_FORMATS } from '../shared/formats.ts'
import type { DrawnPicture, EditorSource, VideoFormat } from '../shared/types.ts'
import { Actions } from './editor/actions.ts'
import { loadBrandFonts } from './editor/brand.ts'
import { frameFor, renderCardPicture, renderOverlayPicture } from './editor/draw.ts'
import { initLayout } from './editor/layout.ts'
import { Panels } from './editor/panels.ts'
import { Player } from './editor/player.ts'
import { Stage } from './editor/stage.ts'
import { clampNum, fmtTime, Store } from './editor/store.ts'
import { Timeline } from './editor/timeline.ts'

const api = window.editor
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const stage = $('stage')
const frame = $('frame')
const stageMsg = $('stage-msg')
const nameInput = $<HTMLInputElement>('name')
/** Writes the edit to disk now (set once the editor has loaded). */
let persistNow: () => Promise<void> = async () => undefined
const compat = $<HTMLInputElement>('compat')
const formatSel = $<HTMLSelectElement>('format')
const speedSel = $<HTMLSelectElement>('speed')
const noticeEl = $('format-notice')
const busy = $('busy')
const busyTitle = $('busy-title')
const busyBar = $('busy-bar')
const busyDetail = $('busy-detail')
const busyCancel = $<HTMLButtonElement>('busy-cancel')

let src: EditorSource
let store: Store
let player: Player
let actions: Actions
let timeline: Timeline
let triedProxy = false
let saving = false
let lastSaved = ''

function fmtBytes(b: number): string {
  return b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`
}

function note(text: string): void {
  stageMsg.textContent = text
  stageMsg.hidden = false
  setTimeout(() => (stageMsg.hidden = true), 2600)
}

// ---------- the stage ----------

/** Sizes the picture to the shape of the finished video, as big as fits. */
function layoutFrame(): void {
  const r = stage.getBoundingClientRect()
  const maxW = Math.max(40, r.width - 28)
  const maxH = Math.max(40, r.height - 28)
  const aspect = store.aspect
  let w = maxW
  let h = w / aspect
  if (h > maxH) {
    h = maxH
    w = h * aspect
  }
  frame.style.width = `${Math.floor(w)}px`
  frame.style.height = `${Math.floor(h)}px`
  player.invalidate()
}

function updatePlayIcon(): void {
  $('play-icon').innerHTML = store.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'
}

function updateTools(): void {
  ;($('undo') as HTMLButtonElement).disabled = !store.canUndo
  ;($('redo') as HTMLButtonElement).disabled = !store.canRedo
  const sel = store.selection
  ;($('delete-sel') as HTMLButtonElement).disabled = !sel
  ;($('duplicate-sel') as HTMLButtonElement).disabled = !sel
  ;($('split') as HTMLButtonElement).disabled = !store.project.clips.some((c, i, all) => {
    void c
    void i
    void all
    return true
  })
  $('time').textContent = `${fmtTime(store.playhead)} / ${fmtTime(store.duration)}`
}

// ---------- saving ----------

const currentFormat = (): VideoFormat => formatSel.value as VideoFormat
/** HEVC, WebM and GIF are always made fresh; MKV / MOV are re-wraps when nothing was edited. */
const alwaysConverts = (f: VideoFormat): boolean => f === 'hevc' || f === 'webm' || f === 'gif'

function showBusy(title: string, detail: string, cancellable: boolean): void {
  busy.hidden = false
  busyTitle.textContent = title
  busyDetail.textContent = detail
  busyBar.style.transform = 'scaleX(0)'
  busyBar.parentElement!.classList.toggle('indeterminate', !cancellable)
  busyCancel.hidden = !cancellable
  busyCancel.textContent = 'Cancel'
}

function renderFormat(): void {
  const f = videoFormat(currentFormat())
  $('ext').textContent = `.${f.ext}`
  const n = f.notice
  noticeEl.hidden = !n
  if (n) {
    noticeEl.className = `notice ${n.level === 'warn' ? '' : n.level}`.trim()
    $('notice-title').textContent = n.title
    $('notice-text').textContent = n.text
  }
  // The 4:4:4 → 4:2:0 choice only matters when the file stays H.264; the other formats are always 4:2:0.
  $('compat-row').hidden = !src.meta.yuv444 || alwaysConverts(currentFormat())
}

/** The pictures FFmpeg needs: every comment, arrow and so on, and every title card, drawn at the size of the finished video. */
async function drawPictures(): Promise<DrawnPicture[]> {
  const { width, height } = store.outputSize
  const f = frameFor(width / height)
  const fonts = new Set<string>()
  for (const o of store.project.overlays) if ('font' in o && o.font) fonts.add(o.font)
  for (const c of store.project.clips) if (c.card) fonts.add(c.card.font)
  for (const name of fonts) if (name !== 'sans') await document.fonts.load(`16px "${name}"`).catch(() => undefined)
  const out: DrawnPicture[] = []
  for (const o of store.project.overlays.filter(isDrawn)) {
    const p = await renderOverlayPicture(o as Overlay, f, height)
    out.push({ key: o.id, ...p })
  }
  for (const c of store.project.clips as Clip[]) {
    if (!c.card) continue
    out.push({ key: `card:${c.id}`, x: 0, y: 0, width, height, png: await renderCardPicture(c.card, f, width, height) })
  }
  return out
}

/** Makes a small, quick copy of the finished video and plays it, so the speed, the sound and every edit can be checked before saving. */
async function previewFinal(): Promise<void> {
  if (!src || saving) return
  saving = true
  store.setPlaying(false)
  await persistNow()
  showBusy('Making a preview…', 'Putting everything together at a small size so you can watch the finished video.', true)
  let res: { ok: boolean; url?: string; duration?: number; error?: string }
  try {
    res = await api.previewFinal({ project: store.project, pictures: await drawPictures() })
  } catch (err) {
    res = { ok: false, error: (err as Error).message }
  }
  saving = false
  if (res.ok && res.url) {
    busy.hidden = true
    const v = $<HTMLVideoElement>('pv-video')
    v.src = res.url
    $('pv').hidden = false
    void v.play().catch(() => undefined)
    return
  }
  if (!res.error) {
    busy.hidden = true
    return
  }
  busyTitle.textContent = 'Could not make the preview'
  busyDetail.textContent = res.error
  busyCancel.hidden = false
  busyCancel.textContent = 'Close'
}

function closePreview(): void {
  const v = $<HTMLVideoElement>('pv-video')
  v.pause()
  v.removeAttribute('src')
  v.load()
  $('pv').hidden = true
}

async function save(saveAs: boolean): Promise<void> {
  if (!src || saving) return
  saving = true
  store.setPlaying(false)
  const format = currentFormat()
  const plain = isPlain(store.project, src.meta.duration)
  const converting = alwaysConverts(format)
  const edited = !plain || converting || (compat.checked && !!src.meta.yuv444)
  showBusy(
    converting ? `Converting to ${videoFormat(format).ext.toUpperCase()}…` : !plain ? 'Making your video…' : format === 'mp4' ? 'Saving…' : 'Saving a copy…',
    converting
      ? 'Making a new copy in this format — this can take a while for long recordings.'
      : !plain
        ? 'Putting your edits together at the same quality as the recording.'
        : format === 'mp4'
          ? 'Saving a copy of the original — no re-encode, no quality loss.'
          : 'Re-wrapping the video — no re-encode, no quality loss.',
    edited
  )
  if (saveAs) busy.hidden = true

  let res: { ok: boolean; path?: string; error?: string }
  try {
    const pictures = plain ? [] : await drawPictures()
    res = await api.save({ project: store.project, pictures, fileName: nameInput.value, saveAs, compatible: compat.checked, format })
  } catch (err) {
    res = { ok: false, error: (err as Error).message }
  }
  saving = false
  if (res.ok) {
    // The window stays open: the recording is kept until the person chooses Finish, so a mistake can still be put right.
    busy.hidden = true
    $('saved').hidden = false
    $('saved-path').textContent = res.path ?? ''
    $('saved-path').title = res.path ?? ''
    lastSaved = res.path ?? ''
    return
  }
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

function typing(e: Event): boolean {
  const t = e.target
  return t instanceof HTMLInputElement ? !['range', 'checkbox', 'color', 'button'].includes(t.type) : t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

function bindKeys(panels: { refresh: () => void }): void {
  window.addEventListener('keydown', (e) => {
    if (saving || !store) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (typing(e)) return
      e.preventDefault()
      store.undo()
      panels.refresh()
      return
    }
    if (mod && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
      if (typing(e)) return
      e.preventDefault()
      store.redo()
      panels.refresh()
      return
    }
    if (mod && (e.key === 'd' || e.key === 'D')) {
      if (typing(e)) return
      e.preventDefault()
      actions.duplicate()
      return
    }
    if (typing(e) || mod) return
    if (e.key === ' ') {
      e.preventDefault()
      player.toggle()
    } else if (e.key === 's' || e.key === 'S') actions.split()
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      actions.deleteSelected()
    } else if (e.key === 'Escape') store.select(null)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      store.setPlaying(false)
      const step = e.shiftKey ? 1 : 1 / store.fps
      store.seek(store.snap(store.playhead + (e.key === 'ArrowLeft' ? -step : step)))
    } else if (e.key === '+' || e.key === '=') timeline.setZoom(store.pxPerSec * 1.25)
    else if (e.key === '-') timeline.setZoom(store.pxPerSec / 1.25)
  })
}

function bindDrops(): void {
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    document.body.classList.add('dropzone-on')
  })
  window.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('dropzone-on')
  })
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    document.body.classList.remove('dropzone-on')
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathFor(f)).filter(Boolean)
    if (paths.length) await actions.addAny(await api.addMedia(paths, 'any'))
  })
}

async function loadProxy(): Promise<void> {
  if (triedProxy) {
    note('Preview unavailable — you can still edit and save.')
    return
  }
  triedProxy = true
  // Chromium can't decode 4:4:4 video, so preview a lightweight copy; edits still apply to the original.
  stageMsg.textContent = 'Preparing preview…'
  stageMsg.hidden = false
  const url = await api.makeProxy()
  stageMsg.hidden = true
  if (url) {
    player.recordingUrl = url
    store.media.set('recording', { ...store.media.get('recording')!, url })
    player.invalidate()
  } else note('Preview unavailable — you can still edit and save.')
}

function showLoadError(message: string): void {
  stageMsg.replaceChildren()
  const text = document.createElement('p')
  text.textContent = message
  const actionsEl = document.createElement('div')
  actionsEl.className = 'msg-actions'
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
  actionsEl.append(reveal, discard)
  stageMsg.append(text, actionsEl)
  stageMsg.classList.add('interactive')
  stageMsg.hidden = false
  for (const id of ['save', 'save-as', 'play', 'split', 'freeze', 'delete-sel', 'undo', 'redo', 'add-media-bar', 'add-music-bar', 'duplicate-sel', 'preview-final']) ($(id) as HTMLButtonElement).disabled = true
  nameInput.disabled = true
}

async function init(): Promise<void> {
  const loaded = await api.load()
  if ('error' in loaded) {
    showLoadError(loaded.error)
    return
  }
  src = loaded.source
  const m = src.meta
  let initial = newProject({ duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio, tracks: src.tracks })
  // a recording opened again: the edit as it was left (pieces whose file has gone missing are dropped)
  const have = new Set<string>([...(src.saved?.media ?? []).map((x) => x.id), ...(src.camera ? [src.camera.info.id] : []), ...src.trackFiles.map((x) => x.id)])
  const reopened = src.saved ? pruneMissing(src.saved.project, have) : null
  if (reopened && reopened.clips.length) initial = reopened
  // the camera recording is a piece of its own, on its own track in front of the screen
  else if (src.camera) {
    const c = src.camera.info
    const added = addCameraClip(initial, { media: c.id, name: 'Face camera', duration: c.duration, width: c.width, height: c.height, hasAudio: c.hasAudio }, src.camera.offset, m.width / m.height)
    if (added) initial = added.project
  }
  store = new Store(initial, m, src.brand)
  store.cameraOffset = src.camera?.offset ?? 0
  if (src.camera) store.media.set(src.camera.info.id, src.camera.info)
  for (const t of src.trackFiles) store.media.set(t.id, t)
  for (const x of src.saved?.media ?? []) store.media.set(x.id, x)
  store.media.set('recording', { id: 'recording', name: 'Recording', kind: 'video', duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio, url: src.url })
  void loadBrandFonts(src.brand)

  // The edit is written next to the recording as the person works, so the recording can be opened again later exactly as it was left.
  let persistTimer = 0
  persistNow = async (): Promise<void> => {
    window.clearTimeout(persistTimer)
    await api.saveProject({ project: store.project, fileName: nameInput.value }).catch(() => false)
  }
  const persistSoon = (): void => {
    window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(() => void persistNow(), 1200)
  }
  store.on((what) => {
    if (what === 'project' || what === 'media') persistSoon()
  })
  nameInput.addEventListener('input', persistSoon)
  void persistNow()

  player = new Player(store, { frame, layers: $('layers'), pips: $('pips'), canvas: $<HTMLCanvasElement>('overlay-canvas') })
  player.recordingUrl = src.url
  player.onRecordingError = () => void loadProxy()

  actions = new Actions(store)
  actions.onNote = note

  timeline = new Timeline(store, $('timeline'), {
    strip: (id) => api.strip(id, 60),
    wave: (id) => api.waveform(id, 700),
    sourceLength: (c) => (c.kind === 'recording' ? m.duration : c.kind === 'image' ? null : (store.media.get(c.media)?.duration ?? null)),
    setTrack: (id, patch) => actions.setTrack(id, patch),
    addVideoTrack: () => actions.newVideoTrack(),
    addAudioTrack: () => actions.newAudioTrack(),
    removeTrack: (id) => actions.deleteTrack(id)
  })
  actions.onReveal = (t) => timeline.reveal(t)

  const aspect = document.createElement('select')
  aspect.id = 'aspect'
  aspect.setAttribute('aria-label', 'Crop shape')
  for (const [v, l] of [['free', 'Free'], ['16:9', '16:9'], ['9:16', '9:16 (vertical)'], ['1:1', '1:1'], ['4:3', '4:3']]) aspect.add(new Option(l, v))
  const stg = new Stage(store, { stage, frame, sel: $('sel'), cropLayer: $('crop'), cropBox: $('crop-box'), cropSize: $('crop-size'), aspect }, player)
  aspect.addEventListener('change', () => stg.fitAspect())
  const panels = new Panels(store, actions, { rail: $('rail'), drawer: $('drawer'), props: $('props') }, { fit: () => stg.fitAspect(), select: aspect })
  // entering the crop tool starts a crop if there isn't one
  store.on((what) => {
    if (what === 'tool' && store.cropMode && !store.project.crop) stg.fitAspect()
  })
  bindKeys({ refresh: () => store.emit('selection') })
  void panels

  store.on((what) => {
    if (what === 'play') updatePlayIcon()
    if (what === 'project' || what === 'tool') layoutFrame()
    if (what === 'selection') {
      // picking a comment on the timeline brings the playhead to where it is shown
      const o = store.selectedOverlay
      if (o && (store.playhead < o.start || store.playhead >= o.end)) store.seek(Math.min(o.end - 0.05, o.start + 0.05))
    }
    updateTools()
  })
  window.addEventListener('resize', layoutFrame)
  new ResizeObserver(layoutFrame).observe(stage)
  const refitTimeline = initLayout(layoutFrame)
  store.on((what) => {
    if (what === 'project') requestAnimationFrame(refitTimeline)
  })
  requestAnimationFrame(refitTimeline)
  window.editor.onBelowScreen((px) => {
    document.querySelector<HTMLElement>('.editor')!.style.setProperty('--below', `${px}px`)
    layoutFrame()
  })

  $('play').addEventListener('click', () => player.toggle())
  $('split').addEventListener('click', () => actions.split())
  $('freeze').addEventListener('click', () => void actions.freeze())
  $('delete-sel').addEventListener('click', () => actions.deleteSelected())
  $('undo').addEventListener('click', () => {
    store.undo()
    store.emit('selection')
  })
  $('redo').addEventListener('click', () => {
    store.redo()
    store.emit('selection')
  })
  $('add-media-bar').addEventListener('click', () => void actions.addAny())
  $('add-music-bar').addEventListener('click', () => void actions.addMusic())
  $('duplicate-sel').addEventListener('click', () => actions.duplicate())
  const zoom = $<HTMLInputElement>('tl-zoom')
  zoom.addEventListener('input', () => timeline.setZoom(6 * Math.pow(400 / 6, Number(zoom.value) / 100)))
  zoom.value = String(Math.round((Math.log(store.pxPerSec / 6) / Math.log(400 / 6)) * 100))
  $('preview-final').addEventListener('click', () => void previewFinal())
  $('pv-close').addEventListener('click', closePreview)
  $('pv-save').addEventListener('click', () => {
    closePreview()
    $('saved').hidden = true
    void save(false)
  })
  $('saved-show').addEventListener('click', () => void api.revealPath(lastSaved))
  $('saved-keep').addEventListener('click', () => ($('saved').hidden = true))
  $('saved-finish').addEventListener('click', () => void persistNow().then(() => api.finish()))
  $('save').addEventListener('click', () => {
    $('saved').hidden = true
    void save(false)
  })
  $('save-as').addEventListener('click', () => {
    $('saved').hidden = true
    void save(true)
  })
  $('discard').addEventListener('click', () => void api.discard())
  bindDrops()

  nameInput.value = src.saved?.fileName || src.defaultName
  formatSel.replaceChildren(
    ...VIDEO_FORMATS.filter((f) => src.formats.includes(f.id)).map((f) => {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      return o
    })
  )
  formatSel.value = src.format
  speedSel.replaceChildren(
    ...SPEEDS.map((v) => new Option(v === 1 ? '1× (as recorded)' : v < 1 ? `${v}× (slower)` : `${v}× (faster)`, String(v)))
  )
  speedSel.value = '1'
  speedSel.addEventListener('change', () => {
    const v = Number(speedSel.value)
    store.edit((p) => (p.speed === v ? null : { ...p, speed: v }))
    note(v === 1 ? 'The saved video plays at the normal speed.' : `The saved video will play at ${v}× speed (this preview stays at normal speed). It will be ${fmtTime(store.duration / v)} long.`)
  })
  store.on((what) => {
    if (what === 'project') speedSel.value = String(store.project.speed)
  })
  formatSel.addEventListener('change', renderFormat)
  $('use-default').addEventListener('click', () => {
    formatSel.value = 'mp4'
    renderFormat()
  })
  renderFormat()
  $('dest').textContent = `Saves to ${src.outputDir}`
  $('info').textContent = [
    `${m.width}×${m.height}`, `${m.fps} fps`, fmtTime(m.duration), m.yuv444 ? '4:4:4 colour' : null, m.hasAudio ? 'with audio' : 'no audio', fmtBytes(src.sizeBytes)
  ].filter(Boolean).join(' · ')

  layoutFrame()
  updateTools()
  updatePlayIcon()
  store.emit('tool')
  clampNum(0, 0, 1)
  ;(window as unknown as { __editor: unknown }).__editor = { store, player, actions }
}

void init()
