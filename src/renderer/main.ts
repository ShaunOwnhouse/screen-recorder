import type { AudioLevels, Capabilities, RecordingStatus, Settings } from '../shared/types.ts'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  app: $('app'),
  chip: $('chip'),
  banner: $('banner'),
  bannerWrap: $('banner-wrap'),
  warning: $('warning'),
  pending: $('pending'),
  pendingName: $('pending-name'),
  idleView: $('idle-view'),
  recView: $('rec-view'),
  quick: $('quick'),
  record: $<HTMLButtonElement>('record'),
  recordLabel: $('record-label'),
  hotkeyHint: $('hotkey-hint'),
  timer: $('timer'),
  recMeta: $('rec-meta'),
  recMeters: $('rec-meters'),
  recWarn: $('rec-warn'),
  last: $('last'),
  lastName: $('last-name'),
  settingsToggle: $<HTMLButtonElement>('settings-toggle'),
  settingsBody: $('settings-body'),
  settingsSummary: $('settings-summary'),
  modeHint: $('mode-hint'),
  countdown: $<HTMLSelectElement>('countdown'),
  pillSystem: $<HTMLButtonElement>('pill-system'),
  pillMic: $<HTMLButtonElement>('pill-mic'),
  resolution: $<HTMLSelectElement>('resolution'),
  resHint: $('res-hint'),
  quality: $<HTMLSelectElement>('quality'),
  qualityHint: $('quality-hint'),
  fpsHint: $('fps-hint'),
  encoder: $<HTMLSelectElement>('encoder'),
  cursor: $<HTMLInputElement>('cursor'),
  outdir: $('outdir'),
  systemSource: $('system-source'),
  systemState: $('system-state'),
  systemVolume: $<HTMLInputElement>('system-volume'),
  systemVolumeLabel: $('system-volume-label'),
  micSource: $('mic-source'),
  micState: $('mic-state'),
  mic: $<HTMLSelectElement>('mic'),
  micVolume: $<HTMLInputElement>('mic-volume'),
  micVolumeLabel: $('mic-volume-label'),
  noise: $<HTMLInputElement>('noise'),
  testAudio: $<HTMLButtonElement>('test-audio'),
  audioHint: $('audio-hint'),
  footer: $('footer')
}

const QUALITY_SHORT: Record<Settings['quality'], string> = {
  maximum: 'Maximum',
  veryhigh: 'Very high',
  high: 'High',
  studio: 'Studio 4:4:4',
  lossless: 'Lossless'
}

let settings: Settings
let caps: Capabilities | null = null
let status: RecordingStatus | null = null
let testing = false

function prefGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function prefSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Preference only; nothing to do.
  }
}

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

const AUDIO_KEYS: (keyof Settings)[] = ['systemAudio', 'micEnabled', 'micDevice', 'noiseSuppression', 'systemVolume', 'micVolume']

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await api.setSettings(patch)
  renderSettings()
  if (testing && AUDIO_KEYS.some((k) => k in patch)) void runAudioTest(true)
}

function setSettingsOpen(open: boolean): void {
  el.settingsBody.hidden = !open
  el.settingsToggle.setAttribute('aria-expanded', String(open))
  prefSet('settingsOpen', open ? '1' : '0')
}

/** Tallest connected screen, for the "upscaling adds no detail" hint. */
function largestDisplayHeight(): number | null {
  return caps?.displays.length ? Math.max(...caps.displays.map((d) => d.height)) : null
}

function renderSummary(): void {
  const res = settings.outputHeight ? `${settings.outputHeight}p` : 'Native'
  el.settingsSummary.textContent = [res, `${settings.fps} fps`, QUALITY_SHORT[settings.quality]].join(' · ')
}

function renderSettings(): void {
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    const current = String(settings[seg.dataset.key as keyof Settings])
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === current)))
  })
  el.resolution.value = settings.outputHeight ? String(settings.outputHeight) : 'native'
  el.quality.value = settings.quality
  el.countdown.value = String(settings.countdown)
  el.cursor.checked = settings.showCursor
  el.outdir.textContent = settings.outputDir
  el.outdir.title = settings.outputDir

  el.pillSystem.setAttribute('aria-pressed', String(settings.systemAudio))
  el.pillMic.setAttribute('aria-pressed', String(settings.micEnabled))
  el.systemSource.classList.toggle('off', !settings.systemAudio)
  el.micSource.classList.toggle('off', !settings.micEnabled)
  el.systemState.textContent = settings.systemAudio ? '' : '(off)'
  el.micState.textContent = settings.micEnabled ? '' : '(off)'
  el.systemVolume.value = String(Math.round(settings.systemVolume * 100))
  el.systemVolumeLabel.textContent = `${Math.round(settings.systemVolume * 100)}%`
  el.micVolume.value = String(Math.round(settings.micVolume * 100))
  el.micVolumeLabel.textContent = `${Math.round(settings.micVolume * 100)}%`
  el.noise.checked = settings.noiseSuppression

  if (caps) {
    el.encoder.replaceChildren(
      option('auto', 'Auto — best available'),
      ...caps.encoders.map((e) => option(e.id, settings.quality === 'studio' && !e.yuv444 ? `${e.label} (no 4:4:4)` : e.label))
    )
    el.encoder.value = caps.encoders.some((e) => e.id === settings.encoder) ? settings.encoder : 'auto'

    const mics = caps.microphones
    el.mic.replaceChildren(option('default', 'System default microphone'), ...mics.map((m) => option(m.id, m.label)))
    const byLabel = mics.find((m) => m.label === settings.micLabel)
    el.mic.value = mics.some((m) => m.id === settings.micDevice) ? settings.micDevice : byLabel ? byLabel.id : 'default'
  }
  renderHints()
  renderSummary()
}

function renderHints(): void {
  const multi = (caps?.displays.length ?? 1) > 1
  el.modeHint.textContent =
    settings.mode === 'region'
      ? 'You’ll drag the area to record — on any screen.'
      : multi
        ? 'You’ll click the screen to record when you start.'
        : 'Records your whole screen.'

  const tallest = largestDisplayHeight()
  el.resHint.classList.remove('warn')
  if (!settings.outputHeight) {
    el.resHint.textContent = 'Records the exact pixels of the screen or area you pick.'
  } else if (tallest && settings.outputHeight > tallest) {
    el.resHint.textContent = `Your screens are ${tallest}p — upscaling adds pixels, not detail. Native is sharper per byte.`
    el.resHint.classList.add('warn')
  } else {
    el.resHint.textContent = `Scaled to ${settings.outputHeight}p with high-quality Lanczos filtering.`
  }

  const hints: Record<Settings['quality'], string> = {
    maximum:
      'Near-lossless H.264 with the encoder’s slowest, best settings. Plays in Windows Media Player, on phones, WhatsApp and the web.',
    veryhigh: 'Indistinguishable from the screen for most content, at about two-thirds the size of Maximum. Plays everywhere.',
    high: 'Great quality at roughly half the size of Very high. Plays everywhere.',
    studio:
      'Full 4:4:4 colour for colour-critical work. Won’t play in Windows Media Player, phones or most websites — use VLC or a video editor.',
    lossless: 'Bit-for-bit identical to the screen. Very large files; VLC or editors only.'
  }
  el.qualityHint.textContent = hints[settings.quality]
  el.fpsHint.textContent =
    settings.fps === 120 ? 'Smoothest motion — only worth it on a 120 Hz+ screen; files are about twice as big as 60 fps.' : ''

  el.audioHint.textContent =
    !settings.systemAudio && !settings.micEnabled
      ? 'No audio will be recorded. Turn sources on with the buttons under the record button.'
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
  el.quick.hidden = recording
  el.quick.classList.toggle('locked', s.state !== 'idle')
  el.settingsBody.classList.toggle('locked', s.state !== 'idle')
  el.record.disabled = s.state !== 'idle' || !caps?.platformSupported

  el.chip.className = `chip ${s.state === 'selecting' ? 'saving' : s.state}`
  el.chip.textContent = { idle: 'Ready', selecting: 'Choose what to record…', countdown: 'Starting…', recording: 'Recording', saving: 'Finishing…' }[s.state]
  el.recordLabel.textContent =
    s.state === 'saving' ? 'Finishing recording…' : s.state === 'selecting' ? 'Choose what to record' : 'Start recording'

  if (recording) {
    el.timer.textContent = formatTime(s.elapsed)
    el.recMeta.textContent = [s.resolution, s.encoder, s.audio ?? 'No audio', formatBytes(s.bytes)].filter(Boolean).join(' · ')
    const slow = s.speed !== null && s.elapsed > 5 && s.speed < 0.95
    el.recWarn.hidden = !(slow || s.droppedFrames > 0)
    el.recWarn.textContent = slow
      ? `Your computer is encoding slower than real time (${s.speed!.toFixed(2)}×). Try a GPU encoder, a lower frame rate, or "Very high" quality.`
      : `${s.droppedFrames} frames dropped.`
  } else {
    el.recMeters.replaceChildren()
  }

  el.bannerWrap.hidden = !s.error
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
  el.footer.textContent = `FFmpeg ${caps.ffmpegVersion} · ${gpus} hardware encoder(s)`
  el.hotkeyHint.textContent = caps.hotkey ? `or press ${caps.hotkey} anywhere` : 'Global hotkey unavailable (in use by another app)'
  if (!caps.platformSupported) {
    el.bannerWrap.hidden = false
    el.banner.textContent = 'Recording is supported on Windows and macOS only.'
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
      void save(key === 'fps' ? { fps: Number(b.dataset.value) as Settings['fps'] } : { mode: b.dataset.value as Settings['mode'] })
    })
  })
  el.settingsToggle.addEventListener('click', () => setSettingsOpen(el.settingsBody.hidden))
  el.pillSystem.addEventListener('click', () => void save({ systemAudio: !settings.systemAudio }))
  el.pillMic.addEventListener('click', () => void save({ micEnabled: !settings.micEnabled }))
  el.resolution.addEventListener('change', () =>
    void save({ outputHeight: el.resolution.value === 'native' ? null : Number(el.resolution.value) })
  )
  el.quality.addEventListener('change', () => void save({ quality: el.quality.value as Settings['quality'] }))
  el.encoder.addEventListener('change', () => void save({ encoder: el.encoder.value }))
  el.cursor.addEventListener('change', () => void save({ showCursor: el.cursor.checked }))
  el.systemVolume.addEventListener('input', () => (el.systemVolumeLabel.textContent = `${el.systemVolume.value}%`))
  el.systemVolume.addEventListener('change', () => void save({ systemVolume: Number(el.systemVolume.value) / 100 }))
  el.micVolume.addEventListener('input', () => (el.micVolumeLabel.textContent = `${el.micVolume.value}%`))
  el.micVolume.addEventListener('change', () => void save({ micVolume: Number(el.micVolume.value) / 100 }))
  el.noise.addEventListener('change', () => void save({ noiseSuppression: el.noise.checked }))
  el.mic.addEventListener('change', () => {
    const id = el.mic.value
    const label = caps?.microphones.find((m) => m.id === id)?.label ?? null
    void save({ micDevice: id, micLabel: label, micEnabled: true })
  })
  el.testAudio.addEventListener('click', () => void runAudioTest(!testing))
  el.countdown.addEventListener('change', () => void save({ countdown: Number(el.countdown.value) }))
  $('choose-dir').addEventListener('click', async () => {
    settings = await api.chooseOutputDir()
    renderSettings()
  })
  $('open-dir').addEventListener('click', () => void api.openOutputDir())
  $('open-logs').addEventListener('click', () => void api.openLogs())
  $('play').addEventListener('click', () => void api.playLastRecording())
  $('reveal').addEventListener('click', () => void api.showLastRecording())
  $('review').addEventListener('click', () => void api.openReview())
  el.record.addEventListener('click', () => void api.toggleRecording())
  $('stop').addEventListener('click', () => void api.toggleRecording())

  // Size the window to its content, so it's compact with Settings closed and grows when opened.
  let last = 0
  new ResizeObserver(() => {
    const h = Math.ceil(el.app.getBoundingClientRect().height)
    if (h !== last) {
      last = h
      void api.fitHeight(h)
    }
  }).observe(el.app)
}

async function init(): Promise<void> {
  bind()
  setSettingsOpen(prefGet('settingsOpen') === '1')
  settings = await api.getSettings()
  renderSettings()
  api.onStatus(renderStatus)
  api.onLevels(renderLevels)
  api.onCapsChanged(() => void loadCapabilities(false))
  renderStatus(await api.getStatus())

  el.footer.textContent = 'Detecting screens and encoders…'
  await loadCapabilities(false)
}

void init()
