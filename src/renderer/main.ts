import type { AudioLevels, Capabilities, RecordingStatus, Settings } from '../shared/types.ts'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  chip: $('chip'),
  banner: $('banner'),
  warning: $('warning'),
  pending: $('pending'),
  pendingName: $('pending-name'),
  idleView: $('idle-view'),
  recView: $('rec-view'),
  record: $<HTMLButtonElement>('record'),
  recordLabel: $('record-label'),
  hotkeyHint: $('hotkey-hint'),
  timer: $('timer'),
  recMeta: $('rec-meta'),
  recMeters: $('rec-meters'),
  recWarn: $('rec-warn'),
  last: $('last'),
  lastName: $('last-name'),
  settings: $('settings'),
  audioSettings: $('audio-settings'),
  screens: $('screens'),
  resolution: $<HTMLSelectElement>('resolution'),
  resHint: $('res-hint'),
  quality: $<HTMLSelectElement>('quality'),
  qualityHint: $('quality-hint'),
  encoder: $<HTMLSelectElement>('encoder'),
  cursor: $<HTMLInputElement>('cursor'),
  outdir: $('outdir'),
  systemAudio: $<HTMLInputElement>('system-audio'),
  systemVolume: $<HTMLInputElement>('system-volume'),
  systemVolumeLabel: $('system-volume-label'),
  mic: $<HTMLSelectElement>('mic'),
  micVolume: $<HTMLInputElement>('mic-volume'),
  micVolumeLabel: $('mic-volume-label'),
  noise: $<HTMLInputElement>('noise'),
  testAudio: $<HTMLButtonElement>('test-audio'),
  audioHint: $('audio-hint'),
  footer: $('footer')
}

let settings: Settings
let caps: Capabilities | null = null
let status: RecordingStatus | null = null
let testing = false

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
  if (testing && ('systemAudio' in patch || 'micDevice' in patch || 'noiseSuppression' in patch || 'systemVolume' in patch || 'micVolume' in patch)) {
    void runAudioTest(true)
  }
}

function selectedDisplay(): Capabilities['displays'][number] | undefined {
  return caps?.displays.find((d) => d.id === settings.displayId) ?? caps?.displays.find((d) => d.primary)
}

function renderScreens(): void {
  if (!caps) return
  const selected = selectedDisplay()
  el.screens.replaceChildren(
    ...caps.displays.map((d) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'screen'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(d.id === selected?.id))
      const thumb = document.createElement('div')
      thumb.className = 'thumb'
      if (d.thumbnail) {
        const img = document.createElement('img')
        img.src = d.thumbnail
        img.alt = ''
        thumb.append(img)
      }
      const name = document.createElement('span')
      name.className = 'screen-name'
      name.textContent = d.label
      const res = document.createElement('span')
      res.className = 'screen-res'
      res.textContent = `${d.width}×${d.height}`
      b.append(thumb, name, res)
      b.addEventListener('click', () => void save({ displayId: d.id }))
      return b
    })
  )
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

  el.systemAudio.checked = settings.systemAudio
  el.systemVolume.value = String(Math.round(settings.systemVolume * 100))
  el.systemVolumeLabel.textContent = `${Math.round(settings.systemVolume * 100)}%`
  el.micVolume.value = String(Math.round(settings.micVolume * 100))
  el.micVolumeLabel.textContent = `${Math.round(settings.micVolume * 100)}%`
  el.noise.checked = settings.noiseSuppression
  document.querySelectorAll<HTMLElement>('[data-for="system"]').forEach((n) => (n.hidden = !settings.systemAudio))
  document.querySelectorAll<HTMLElement>('[data-for="mic"]').forEach((n) => (n.hidden = !settings.micDevice))

  if (caps) {
    renderScreens()
    el.encoder.replaceChildren(
      option('auto', 'Auto — best available'),
      ...caps.encoders.map((e) => option(e.id, settings.quality === 'maximum' && !e.yuv444 ? `${e.label} (no 4:4:4)` : e.label))
    )
    el.encoder.value = caps.encoders.some((e) => e.id === settings.encoder) ? settings.encoder : 'auto'

    const mics = caps.microphones
    el.mic.replaceChildren(option('', 'Off'), option('default', 'Windows default microphone'), ...mics.map((m) => option(m.id, m.label)))
    const byId = settings.micDevice && (settings.micDevice === 'default' || mics.some((m) => m.id === settings.micDevice))
    const byLabel = mics.find((m) => m.label === settings.micLabel)
    el.mic.value = byId ? settings.micDevice! : byLabel ? byLabel.id : settings.micDevice ? 'default' : ''
  }
  renderHints()
}

function renderHints(): void {
  const d = selectedDisplay()
  el.resHint.classList.remove('warn')
  if (!d) {
    el.resHint.textContent = ''
  } else if (!settings.outputHeight) {
    el.resHint.textContent =
      settings.mode === 'region' ? 'Records the selected area at its exact pixel size.' : `Records at ${d.width}×${d.height}, exactly what's on screen.`
  } else if (settings.outputHeight > d.height) {
    el.resHint.textContent = `This screen is ${d.height}p — upscaling adds pixels, not detail. Native is sharper per byte.`
    el.resHint.classList.add('warn')
  } else {
    el.resHint.textContent = `Scaled to ${settings.outputHeight}p with high-quality Lanczos filtering.`
  }

  const hints: Record<Settings['quality'], string> = {
    veryhigh: 'Indistinguishable from the screen for most content. Plays everywhere.',
    maximum: 'Keeps full colour detail so coloured text and thin lines stay crisp. Larger files; some phones and web players can’t play 4:4:4 — use VLC or a desktop editor.',
    high: 'Great quality at roughly half the size of Very high.',
    lossless: 'Bit-for-bit identical to the screen. Very large files.'
  }
  el.qualityHint.textContent = hints[settings.quality]

  el.audioHint.textContent =
    !settings.systemAudio && !settings.micDevice
      ? 'No audio will be recorded.'
      : 'Computer sound and microphone are mixed into one track.'
}

function meter(name: string, level: number | null): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'rec-meter'
  const label = document.createElement('span')
  label.textContent = name
  const bar = document.createElement('div')
  bar.className = 'meter'
  const fill = document.createElement('span')
  fill.style.transform = `scaleX(${level ?? 0})`
  bar.append(fill)
  wrap.append(label, bar)
  return wrap
}

function renderLevels(levels: AudioLevels): void {
  for (const key of ['system', 'mic'] as const) {
    const fill = document.querySelector<HTMLElement>(`.audio-source [data-meter="${key}"] span`)
    if (fill) fill.style.transform = `scaleX(${levels[key] ?? 0})`
  }
  if (status?.state === 'recording') {
    const parts = []
    if (levels.system !== null) parts.push(meter('PC', levels.system))
    if (levels.mic !== null) parts.push(meter('Mic', levels.mic))
    el.recMeters.replaceChildren(...parts)
  }
}

function renderStatus(s: RecordingStatus): void {
  status = s
  const recording = s.state === 'recording'
  el.idleView.hidden = recording
  el.recView.hidden = !recording
  el.settings.classList.toggle('locked', s.state !== 'idle')
  el.audioSettings.classList.toggle('locked', s.state !== 'idle')
  el.record.disabled = s.state !== 'idle' || !caps?.platformSupported

  el.chip.className = `chip ${s.state === 'selecting' ? 'saving' : s.state}`
  el.chip.textContent = { idle: 'Ready', selecting: 'Select an area…', recording: 'Recording', saving: 'Finishing…' }[s.state]
  el.recordLabel.textContent =
    s.state === 'saving' ? 'Finishing recording…' : s.state === 'selecting' ? 'Drag to select an area' : 'Start recording'

  if (recording) {
    el.timer.textContent = formatTime(s.elapsed)
    el.recMeta.textContent = [s.resolution, s.encoder, s.audio ?? 'No audio', formatBytes(s.bytes)].filter(Boolean).join(' · ')
    const slow = s.speed !== null && s.elapsed > 5 && s.speed < 0.95
    el.recWarn.hidden = !(slow || s.droppedFrames > 0)
    el.recWarn.textContent = slow
      ? `Your PC is encoding slower than real time (${s.speed!.toFixed(2)}×). Try a GPU encoder, 30 fps, or "Very high" quality.`
      : `${s.droppedFrames} frames dropped.`
  } else {
    el.recMeters.replaceChildren()
  }

  el.banner.hidden = !s.error
  el.banner.textContent = s.error ?? ''
  el.warning.hidden = !s.warning
  el.warning.textContent = s.warning ?? ''

  el.pending.hidden = !s.pending
  el.pendingName.textContent = s.pending?.replace(/\.mp4$/i, '') ?? ''

  el.last.hidden = !s.lastFile
  el.lastName.textContent = s.lastFile?.split(/[\\/]/).pop() ?? ''

  if (s.state !== 'idle' && testing) {
    testing = false
    el.testAudio.textContent = 'Test'
  }
}

function renderFooter(): void {
  if (!caps) return
  const gpus = caps.encoders.filter((e) => e.id !== 'libx264').length
  el.footer.textContent = `FFmpeg ${caps.ffmpegVersion} · ${caps.ddagrab ? 'Desktop Duplication capture' : 'GDI capture'} · ${gpus} GPU encoder(s)`
  el.hotkeyHint.textContent = caps.hotkey ? `or press ${caps.hotkey} anywhere` : 'Global hotkey unavailable (in use by another app)'
  if (!caps.platformSupported) {
    el.banner.hidden = false
    el.banner.textContent = 'Recording is supported on Windows only.'
  }
}

async function runAudioTest(on: boolean): Promise<void> {
  testing = on
  el.testAudio.textContent = on ? 'Stop test' : 'Test'
  const errors = await api.testAudio(on)
  el.warning.hidden = !errors.length
  el.warning.textContent = errors.length ? errors.join(' · ') : ''
  if (!on) renderLevels({ system: 0, mic: 0 })
}

async function loadCapabilities(refresh: boolean): Promise<void> {
  caps = await api.getCapabilities(refresh)
  renderSettings()
  renderFooter()
  if (status) renderStatus(status)
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
  el.resolution.addEventListener('change', () =>
    void save({ outputHeight: el.resolution.value === 'native' ? null : Number(el.resolution.value) })
  )
  el.quality.addEventListener('change', () => void save({ quality: el.quality.value as Settings['quality'] }))
  el.encoder.addEventListener('change', () => void save({ encoder: el.encoder.value }))
  el.cursor.addEventListener('change', () => void save({ showCursor: el.cursor.checked }))
  el.systemAudio.addEventListener('change', () => void save({ systemAudio: el.systemAudio.checked }))
  el.systemVolume.addEventListener('input', () => (el.systemVolumeLabel.textContent = `${el.systemVolume.value}%`))
  el.systemVolume.addEventListener('change', () => void save({ systemVolume: Number(el.systemVolume.value) / 100 }))
  el.micVolume.addEventListener('input', () => (el.micVolumeLabel.textContent = `${el.micVolume.value}%`))
  el.micVolume.addEventListener('change', () => void save({ micVolume: Number(el.micVolume.value) / 100 }))
  el.noise.addEventListener('change', () => void save({ noiseSuppression: el.noise.checked }))
  el.mic.addEventListener('change', () => {
    const id = el.mic.value || null
    const label = caps?.microphones.find((m) => m.id === id)?.label ?? null
    void save({ micDevice: id, micLabel: label })
  })
  el.testAudio.addEventListener('click', () => void runAudioTest(!testing))
  $('refresh-screens').addEventListener('click', () => void loadCapabilities(true))
  $('choose-dir').addEventListener('click', async () => {
    settings = await api.chooseOutputDir()
    renderSettings()
  })
  $('open-dir').addEventListener('click', () => void api.openOutputDir())
  $('play').addEventListener('click', () => void api.playLastRecording())
  $('reveal').addEventListener('click', () => void api.showLastRecording())
  $('review').addEventListener('click', () => void api.openReview())
  el.record.addEventListener('click', () => void api.toggleRecording())
  $('stop').addEventListener('click', () => void api.toggleRecording())
}

async function init(): Promise<void> {
  bind()
  settings = await api.getSettings()
  renderSettings()
  api.onStatus(renderStatus)
  api.onLevels(renderLevels)
  api.onCapsChanged(() => void loadCapabilities(false))
  renderStatus(await api.getStatus())

  el.footer.textContent = 'Detecting screens and GPU encoders…'
  await loadCapabilities(false)
}

void init()
