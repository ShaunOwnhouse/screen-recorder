import { IMAGE_FORMATS, VIDEO_FORMATS } from '../shared/formats.ts'
import { acceleratorFromKey, acceleratorLabel } from '../shared/hotkeys.ts'
import { updateBanner, updateLine, type UpdateStatus } from '../shared/updates.ts'
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
  footer: $('footer'),
  tabs: $('tabs'),
  tabRecord: $<HTMLButtonElement>('tab-record'),
  tabShot: $<HTMLButtonElement>('tab-shot'),
  heroRecord: $('hero-record'),
  heroShot: $('hero-shot'),
  shoot: $<HTMLButtonElement>('shoot'),
  shotLabel: $('shot-label'),
  shotHotkeyHint: $('shot-hotkey-hint'),
  shotModeHint: $('shot-mode-hint'),
  lastShot: $('last-shot'),
  lastShotName: $('last-shot-name'),
  settingsWrap: $('settings-wrap'),
  fade: $('fade'),
  jump: $('jump'),
  videoFormat: $<HTMLSelectElement>('video-format'),
  videoFormatHint: $('video-format-hint'),
  shotFormat: $<HTMLSelectElement>('shot-format'),
  shotFormatHint: $('shot-format-hint'),
  shotdir: $('shotdir'),
  shotClipboard: $<HTMLInputElement>('shot-clipboard'),
  shotCursor: $<HTMLInputElement>('shot-cursor'),
  keyRecord: $<HTMLButtonElement>('key-record'),
  keyShot: $<HTMLButtonElement>('key-shot'),
  keyHint: $('key-hint'),
  updateBanner: $('update-banner'),
  updateText: $('update-text'),
  updateAction: $<HTMLButtonElement>('update-action'),
  updateLine: $('update-line'),
  updateCheck: $<HTMLButtonElement>('update-check'),
  updateHint: $('update-hint'),
  updateAuto: $<HTMLInputElement>('update-auto'),
  appVersion: $('app-version')
}

const IS_MAC = /Mac/i.test(navigator.platform)

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
let update: UpdateStatus | null = null
let tab: 'record' | 'shot' = 'record'

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
  el.settingsWrap.hidden = !open
  el.settingsToggle.setAttribute('aria-expanded', String(open))
  prefSet('settingsOpen', open ? '1' : '0')
  if (open) requestAnimationFrame(updateScrollState)
}

function setTab(next: 'record' | 'shot'): void {
  tab = next
  prefSet('tab', next)
  renderTabs()
}

function renderTabs(): void {
  const shot = tab === 'shot'
  el.tabRecord.setAttribute('aria-selected', String(!shot))
  el.tabShot.setAttribute('aria-selected', String(shot))
  el.heroRecord.hidden = shot
  el.heroShot.hidden = !shot
  el.last.hidden = shot || !status?.lastFile
  el.lastShot.hidden = !shot || !status?.lastShot
}

/** Fade + highlighted section chip for the scrolling settings area. */
function updateScrollState(): void {
  const body = el.settingsBody
  el.fade.classList.toggle('hide', body.scrollTop + body.clientHeight >= body.scrollHeight - 6)
  const chips = [...el.jump.querySelectorAll<HTMLButtonElement>('button')]
  const line = body.scrollTop + el.jump.offsetHeight + 16
  let active = chips[0]
  for (const c of chips) {
    const g = document.getElementById(c.dataset.target ?? '')
    if (g && g.offsetTop <= line) active = c
  }
  chips.forEach((c) => c.classList.toggle('on', c === active))
}

function setupSettingsScroll(): void {
  el.settingsBody.addEventListener('scroll', updateScrollState, { passive: true })
  new ResizeObserver(updateScrollState).observe(el.settingsBody)
  el.jump.querySelectorAll<HTMLButtonElement>('button').forEach((c) =>
    c.addEventListener('click', () => {
      const g = document.getElementById(c.dataset.target ?? '')
      if (g) el.settingsBody.scrollTo({ top: g.offsetTop - el.jump.offsetHeight - 4, behavior: 'smooth' })
    })
  )
}

// ---------- shortcuts ----------

let listening: 'record' | 'shot' | null = null

function stopListening(): void {
  listening = null
  window.removeEventListener('keydown', onShortcutKey, true)
  el.keyRecord.classList.remove('listening')
  el.keyShot.classList.remove('listening')
  if (settings) renderHotkeys()
}

function listenFor(which: 'record' | 'shot'): void {
  if (listening) stopListening()
  listening = which
  const btn = which === 'record' ? el.keyRecord : el.keyShot
  btn.classList.add('listening')
  btn.textContent = 'Press the new keys…  (Esc to cancel, Backspace to turn off)'
  window.addEventListener('keydown', onShortcutKey, true)
}

function onShortcutKey(e: KeyboardEvent): void {
  if (!listening) return
  e.preventDefault()
  e.stopPropagation()
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
  if (e.key === 'Escape') return stopListening()
  const which = listening
  if (e.key === 'Backspace' || e.key === 'Delete') {
    stopListening()
    void save(which === 'record' ? { hotkeyRecord: '' } : { hotkeyShot: '' })
    return
  }
  const accelerator = acceleratorFromKey(e, IS_MAC)
  if (!accelerator) {
    el.keyHint.textContent = 'Use Ctrl, Alt or Shift together with a letter, number or F-key (F-keys and Print Screen also work alone).'
    return
  }
  const other = which === 'record' ? settings.hotkeyShot : settings.hotkeyRecord
  if (accelerator === other) {
    el.keyHint.textContent = 'That shortcut is already used for the other action.'
    return
  }
  stopListening()
  void save(which === 'record' ? { hotkeyRecord: accelerator } : { hotkeyShot: accelerator })
}

function renderUpdate(s: UpdateStatus): void {
  update = s
  el.appVersion.textContent = `${s.current}`
  el.updateLine.textContent = updateLine(s)
  el.updateLine.title = updateLine(s)
  el.updateCheck.disabled = s.state === 'unsupported' || s.state === 'checking' || s.state === 'downloading'
  el.updateHint.textContent =
    s.state === 'unsupported'
      ? ''
      : s.notifyOnly
        ? 'This Mac build is not code-signed yet, so updates are announced here and installed by hand.'
        : 'Updates download in the background. Your settings and recordings are kept.'
  const banner = updateBanner(s)
  el.updateBanner.hidden = !banner
  if (banner) {
    el.updateText.textContent = banner.text
    el.updateAction.hidden = !banner.action
    el.updateAction.textContent = banner.label ?? ''
    el.updateAction.dataset.action = banner.action ?? ''
  }
}

async function runUpdateAction(): Promise<void> {
  const action = el.updateAction.dataset.action
  if (action === 'restart') {
    const res = await api.installUpdate()
    if (!res.ok) {
      el.warning.hidden = false
      el.warning.textContent = res.reason ?? 'Can’t restart right now.'
    }
  } else if (action === 'download' || action === 'open') await api.downloadUpdate()
}

function renderHotkeys(): void {
  const describe = (accelerator: string, registered: string | null | undefined): { button: string; hint: string } => {
    if (!accelerator) return { button: 'Off', hint: 'Shortcut is off — turn it on in Settings › Shortcuts.' }
    const name = acceleratorLabel(accelerator, IS_MAC)
    if (!caps) return { button: name, hint: '' }
    return registered
      ? { button: name, hint: `or press ${registered} anywhere` }
      : { button: `${name}  — unavailable`, hint: 'Shortcut unavailable — another app is using it. Pick another in Settings › Shortcuts.' }
  }
  const rec = describe(settings.hotkeyRecord, caps?.hotkey)
  const snap = describe(settings.hotkeyShot, caps?.shotHotkey)
  if (listening !== 'record') el.keyRecord.textContent = rec.button
  if (listening !== 'shot') el.keyShot.textContent = snap.button
  el.hotkeyHint.textContent = rec.hint
  el.shotHotkeyHint.textContent = snap.hint
  const clash = (settings.hotkeyRecord && !caps?.hotkey && caps) || (settings.hotkeyShot && !caps?.shotHotkey && caps)
  el.keyHint.textContent = clash
    ? 'A shortcut shows “unavailable” when another app already uses those keys. Pick different ones.'
    : 'Shortcuts work in any app, so avoid keys your other apps use — browsers use Ctrl+Shift+R (refresh) and Ctrl+Shift+I (developer tools).'
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
  el.shotdir.textContent = settings.shotDir
  el.shotdir.title = settings.shotDir
  el.shotClipboard.checked = settings.shotClipboard
  el.shotCursor.checked = settings.shotCursor

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
  el.updateAuto.checked = settings.autoUpdate

  if (caps) {
    el.encoder.replaceChildren(
      option('auto', 'Auto — best available'),
      ...caps.encoders.map((e) => option(e.id, settings.quality === 'studio' && !e.yuv444 ? `${e.label} (no 4:4:4)` : e.label))
    )
    el.encoder.value = caps.encoders.some((e) => e.id === settings.encoder) ? settings.encoder : 'auto'

    el.videoFormat.replaceChildren(...VIDEO_FORMATS.filter((f) => caps!.videoFormats.includes(f.id)).map((f) => option(f.id, f.label)))
    el.videoFormat.value = settings.videoFormat
    el.shotFormat.replaceChildren(...IMAGE_FORMATS.filter((f) => caps!.imageFormats.includes(f.id)).map((f) => option(f.id, f.label)))
    el.shotFormat.value = settings.shotFormat

    const mics = caps.microphones
    el.mic.replaceChildren(option('default', 'System default microphone'), ...mics.map((m) => option(m.id, m.label)))
    const byLabel = mics.find((m) => m.label === settings.micLabel)
    el.mic.value = mics.some((m) => m.id === settings.micDevice) ? settings.micDevice : byLabel ? byLabel.id : 'default'
  }
  renderHints()
  renderHotkeys()
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

  el.shotModeHint.textContent =
    settings.shotMode === 'region'
      ? 'The screen freezes the moment you start, so menus and tooltips can be captured. Drag an area on any screen.'
      : multi
        ? 'The screen freezes when you start. Click the screen you want to capture.'
        : 'Captures your whole screen, frozen at the moment you press the button.'
  const vn = VIDEO_FORMATS.find((f) => f.id === settings.videoFormat)?.notice
  el.videoFormatHint.classList.toggle('warn', !!vn)
  el.videoFormatHint.textContent = vn ? `${vn.title} ${vn.text}` : 'You can still pick a different format for each recording when you save it.'
  const sn = IMAGE_FORMATS.find((f) => f.id === settings.shotFormat)?.notice
  el.shotFormatHint.classList.toggle('warn', !!sn)
  el.shotFormatHint.textContent = sn ? `${sn.title} ${sn.text}` : 'PNG keeps every pixel exactly as it was on your screen.'

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
  el.heroShot.querySelector('.quick')?.classList.toggle('locked', s.state !== 'idle')
  el.tabs.classList.toggle('locked', s.state !== 'idle')
  el.settingsBody.classList.toggle('locked', s.state !== 'idle')
  el.record.disabled = s.state !== 'idle' || !caps?.platformSupported
  el.shoot.disabled = s.state !== 'idle' || !caps?.platformSupported

  el.chip.className = `chip ${s.state === 'selecting' || s.state === 'snapping' ? 'saving' : s.state}`
  el.chip.textContent = {
    idle: 'Ready', selecting: 'Choose what to record…', countdown: 'Starting…', recording: 'Recording', saving: 'Finishing…',
    snapping: 'Taking screenshot…'
  }[s.state]
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

  el.lastName.textContent = s.lastFile?.split(/[\\/]/).pop() ?? ''
  el.lastShotName.textContent = s.lastShot?.split(/[\\/]/).pop() ?? ''
  renderTabs()

  if (s.state !== 'idle' && testing) {
    testing = false
    el.testAudio.textContent = 'Test'
  }
}

function renderFooter(): void {
  if (!caps) return
  const gpus = caps.encoders.filter((e) => e.id !== 'libx264').length
  el.footer.textContent = `FFmpeg ${caps.ffmpegVersion} · ${gpus} hardware encoder(s)`
  renderHotkeys()
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
      const key = seg.dataset.key as 'mode' | 'fps' | 'shotMode' | 'shotDelay'
      const value = b.dataset.value ?? ''
      void save(
        key === 'fps'
          ? { fps: Number(value) as Settings['fps'] }
          : key === 'shotDelay'
            ? { shotDelay: Number(value) }
            : key === 'shotMode'
              ? { shotMode: value as Settings['shotMode'] }
              : { mode: value as Settings['mode'] }
      )
    })
  })
  el.settingsToggle.addEventListener('click', () => setSettingsOpen(el.settingsWrap.hidden))
  el.tabRecord.addEventListener('click', () => setTab('record'))
  el.tabShot.addEventListener('click', () => setTab('shot'))
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
  el.updateCheck.addEventListener('click', async () => renderUpdate(await api.checkForUpdates()))
  el.updateAction.addEventListener('click', () => void runUpdateAction())
  el.updateAuto.addEventListener('change', () => void save({ autoUpdate: el.updateAuto.checked }))
  el.videoFormat.addEventListener('change', () => void save({ videoFormat: el.videoFormat.value as Settings['videoFormat'] }))
  el.shotFormat.addEventListener('change', () => void save({ shotFormat: el.shotFormat.value as Settings['shotFormat'] }))
  el.shotClipboard.addEventListener('change', () => void save({ shotClipboard: el.shotClipboard.checked }))
  el.shotCursor.addEventListener('change', () => void save({ shotCursor: el.shotCursor.checked }))
  el.keyRecord.addEventListener('click', () => listenFor('record'))
  el.keyShot.addEventListener('click', () => listenFor('shot'))
  $('key-record-off').addEventListener('click', () => void save({ hotkeyRecord: '' }))
  $('key-shot-off').addEventListener('click', () => void save({ hotkeyShot: '' }))
  window.addEventListener('blur', () => listening && stopListening())
  el.shoot.addEventListener('click', () => void api.takeScreenshot())
  $('open-shot').addEventListener('click', () => void api.openLastShot())
  $('reveal-shot').addEventListener('click', () => void api.showLastShot())
  $('choose-shot-dir').addEventListener('click', async () => {
    const dir = await api.chooseShotDir()
    if (dir) await save({ shotDir: dir })
  })
  $('open-shot-dir').addEventListener('click', () => void api.openShotDir())
  setupSettingsScroll()
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
  tab = prefGet('tab') === 'shot' ? 'shot' : 'record'
  settings = await api.getSettings()
  renderSettings()
  api.onStatus(renderStatus)
  api.onUpdate(renderUpdate)
  renderUpdate(await api.getUpdateStatus())
  api.onLevels(renderLevels)
  api.onCapsChanged(() => void loadCapabilities(false))
  renderStatus(await api.getStatus())

  el.footer.textContent = 'Detecting screens and encoders…'
  await loadCapabilities(false)
}

void init()
