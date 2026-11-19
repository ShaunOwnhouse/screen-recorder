import type { Capabilities, RecordingStatus, Settings } from '../shared/types.ts'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  chip: $('chip'),
  banner: $('banner'),
  idleView: $('idle-view'),
  recView: $('rec-view'),
  record: $<HTMLButtonElement>('record'),
  recordLabel: $('record-label'),
  hotkeyHint: $('hotkey-hint'),
  stop: $<HTMLButtonElement>('stop'),
  timer: $('timer'),
  recMeta: $('rec-meta'),
  recWarn: $('rec-warn'),
  last: $('last'),
  lastName: $('last-name'),
  settings: $('settings'),
  display: $<HTMLSelectElement>('display'),
  resolution: $<HTMLSelectElement>('resolution'),
  resHint: $('res-hint'),
  quality: $<HTMLSelectElement>('quality'),
  encoder: $<HTMLSelectElement>('encoder'),
  audio: $<HTMLSelectElement>('audio'),
  cursor: $<HTMLInputElement>('cursor'),
  outdir: $('outdir'),
  footer: $('footer')
}

let settings: Settings
let caps: Capabilities | null = null

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await api.setSettings(patch)
  renderSettings()
}

function selectedDisplay(): Capabilities['displays'][number] | undefined {
  return caps?.displays.find((d) => d.id === settings.displayId) ?? caps?.displays.find((d) => d.primary)
}

function renderSettings(): void {
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    const current = String(settings[seg.dataset.key as keyof Settings])
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === current)))
  })
  el.resolution.value = settings.outputHeight ? String(settings.outputHeight) : 'native'
  el.quality.value = settings.quality
  el.cursor.checked = settings.showCursor
  el.outdir.textContent = settings.outputDir
  el.outdir.title = settings.outputDir

  if (caps) {
    el.display.replaceChildren(...caps.displays.map((d) => option(String(d.id), d.label)))
    el.display.value = String(selectedDisplay()?.id ?? '')

    el.encoder.replaceChildren(option('auto', 'Auto — best available'), ...caps.encoders.map((e) => option(e.id, e.label)))
    el.encoder.value = caps.encoders.some((e) => e.id === settings.encoder) ? settings.encoder : 'auto'

    el.audio.replaceChildren(option('', 'No audio'), ...caps.audioDevices.map((d) => option(d, d)))
    el.audio.value = settings.audioDevice && caps.audioDevices.includes(settings.audioDevice) ? settings.audioDevice : ''
  }
  renderResolutionHint()
}

function renderResolutionHint(): void {
  const d = selectedDisplay()
  el.resHint.classList.remove('warn')
  if (!d) {
    el.resHint.textContent = ''
  } else if (!settings.outputHeight) {
    el.resHint.textContent =
      settings.mode === 'region' ? 'Records the selected area at its exact pixel size.' : `Records at ${d.width}×${d.height}, exactly what's on screen.`
  } else if (settings.outputHeight > d.height) {
    el.resHint.textContent = `Your display is ${d.height}p — upscaling adds pixels, not detail. Native is sharper per byte.`
    el.resHint.classList.add('warn')
  } else {
    el.resHint.textContent = `Scaled to ${settings.outputHeight}p with high-quality Lanczos filtering.`
  }
}

function renderStatus(s: RecordingStatus): void {
  const recording = s.state === 'recording'
  el.idleView.hidden = recording
  el.recView.hidden = !recording
  el.settings.classList.toggle('locked', s.state !== 'idle')
  el.record.disabled = s.state !== 'idle' || !caps?.platformSupported

  el.chip.className = `chip ${s.state === 'selecting' ? 'saving' : s.state}`
  el.chip.textContent = { idle: 'Ready', selecting: 'Select an area…', recording: 'Recording', saving: 'Saving…' }[s.state]
  el.recordLabel.textContent = s.state === 'saving' ? 'Saving recording…' : s.state === 'selecting' ? 'Drag to select an area' : 'Start recording'

  if (recording) {
    el.timer.textContent = formatTime(s.elapsed)
    el.recMeta.textContent = [s.resolution, s.encoder, s.backend, formatBytes(s.bytes)].filter(Boolean).join(' · ')
    const slow = s.speed !== null && s.elapsed > 5 && s.speed < 0.95
    el.recWarn.hidden = !(slow || s.droppedFrames > 0)
    el.recWarn.textContent = slow
      ? `Your PC is encoding slower than real time (${s.speed!.toFixed(2)}×). Try a GPU encoder, 30 fps, or "High" quality.`
      : `${s.droppedFrames} frames dropped.`
  }

  el.banner.hidden = !s.error
  el.banner.textContent = s.error ?? ''

  el.last.hidden = !s.lastFile
  el.lastName.textContent = s.lastFile?.split(/[\\/]/).pop() ?? ''
}

function renderFooter(): void {
  if (!caps) return
  el.footer.textContent = `FFmpeg ${caps.ffmpegVersion} · ${caps.ddagrab ? 'Desktop Duplication capture' : 'GDI capture'} · ${caps.encoders.length - 1} GPU encoder(s)`
  el.hotkeyHint.textContent = caps.hotkey ? `or press ${caps.hotkey} anywhere` : 'Global hotkey unavailable (in use by another app)'
  if (!caps.platformSupported) {
    el.banner.hidden = false
    el.banner.textContent = 'Recording is supported on Windows only.'
  }
}

function bind(): void {
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button')
      if (!b) return
      const key = seg.dataset.key as 'mode' | 'fps'
      void save(key === 'fps' ? { fps: Number(b.dataset.value) as 30 | 60 } : { mode: b.dataset.value as Settings['mode'] })
    })
  })
  el.display.addEventListener('change', () => void save({ displayId: Number(el.display.value) }))
  el.resolution.addEventListener('change', () =>
    void save({ outputHeight: el.resolution.value === 'native' ? null : Number(el.resolution.value) })
  )
  el.quality.addEventListener('change', () => void save({ quality: el.quality.value as Settings['quality'] }))
  el.encoder.addEventListener('change', () => void save({ encoder: el.encoder.value }))
  el.audio.addEventListener('change', () => void save({ audioDevice: el.audio.value || null }))
  el.cursor.addEventListener('change', () => void save({ showCursor: el.cursor.checked }))
  $('choose-dir').addEventListener('click', async () => {
    settings = await api.chooseOutputDir()
    renderSettings()
  })
  $('open-dir').addEventListener('click', () => void api.openOutputDir())
  $('play').addEventListener('click', () => void api.playLastRecording())
  $('reveal').addEventListener('click', () => void api.showLastRecording())
  el.record.addEventListener('click', () => void api.toggleRecording())
  el.stop.addEventListener('click', () => void api.toggleRecording())
}

async function init(): Promise<void> {
  bind()
  settings = await api.getSettings()
  renderSettings()
  api.onStatus(renderStatus)
  renderStatus(await api.getStatus())

  el.footer.textContent = 'Detecting GPU encoders…'
  caps = await api.getCapabilities()
  renderSettings()
  renderFooter()
  renderStatus(await api.getStatus())
}

void init()
