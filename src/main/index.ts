import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell,
  systemPreferences, Tray, type Display
} from 'electron'
import { buildRemuxArgs, type AudioInput, type RecordArgsInput } from './args.ts'
import { AudioCapture, type AudioConfig } from './audio.ts'
import { dxgiOutputs, invalidateDxgiOutputs, matchOutput } from './displays.ts'
import { EditorController } from './editor.ts'
import { buildGrabArgs, compareBar } from './barprobe.ts'
import { availableFormats } from './ffmpeg-codecs.ts'
import { migrateFromOldName } from './migrate.ts'
import { ShotReview } from './shots.ts'
import { clearShotTmp, Snapper } from './snap.ts'
import { avfoundationScreens, chooseEncoder, detectFeatures, needsBasicTuning, runFfmpeg, runFfmpegBinary } from './ffmpeg.ts'
import { macDisplayOrder } from './mac-helper.ts'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol.ts'
import { listPending, pendingDir, recoverInterrupted, removePending, resolvePending } from './pending.ts'
import { Recorder, type RecordedInfo } from './recorder.ts'
import { checkStructure } from './verify.ts'
import { getSettings, updateSettings } from './settings.ts'
import type { OverlayResult } from '../shared/api.ts'
import type { CaptureMode, Capabilities, DisplayInfo, Rect, Settings } from '../shared/types.ts'
import { acceleratorLabel } from '../shared/hotkeys.ts'
import { awayPlacement, BAR_HEIGHT, BAR_WIDTH, barPlacement, overlaps } from './placement.ts'

const RESOURCES = join(__dirname, '../../resources')
const ICON = join(RESOURCES, 'icon.png')
const PANEL_WIDTH = 460
const IS_MAC = process.platform === 'darwin'
type Attempt = Omit<RecordArgsInput, 'outputPath'>
type Page = 'index.html' | 'overlay.html' | 'editor.html' | 'shot.html' | 'audio.html' | 'countdown.html' | 'bar.html'
interface Target {
  display: Display
  /** DIP rectangle to record (the whole display, or a dragged region). */
  rect: Rect
}

registerMediaScheme()

const recorder = new Recorder()
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let hotkeyRegistered = false
let shotHotkeyRegistered = false
let quitting = false
let bar: BrowserWindow | null = null
let panelHiddenForRecording = false
let cancelSelection: (() => void) | null = null
let cancelCountdown: (() => void) | null = null
let startAborted = false
let countdownWin: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) app.quit()

function loadPage(win: BrowserWindow, page: Page, query: Record<string, string> = {}): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const search = new URLSearchParams(query).toString()
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}${search ? `?${search}` : ''}`)
  else void win.loadFile(join(__dirname, '../renderer', page), { query })
}

const audio = new AudioCapture(join(__dirname, '../preload/audio.js'), (w) => loadPage(w, 'audio.html'))

const editor = new EditorController({
  preload: join(__dirname, '../preload/editor.js'),
  icon: ICON,
  load: (w) => loadPage(w, 'editor.html'),
  settings: getSettings,
  encoders: async () => (await detectFeatures()).encoders,
  formats: async () => availableFormats((await detectFeatures()).codecs).video,
  onSaved: (path) => {
    const n = new Notification({ title: 'Recording saved', body: basename(path) })
    n.on('click', () => shell.showItemInFolder(path))
    n.show()
    recorder.update({ lastFile: path })
    afterReview()
  },
  onDiscarded: () => afterReview(),
  onClosed: () => maybeQuit()
})

const shots = new ShotReview({
  preload: join(__dirname, '../preload/shot.js'),
  icon: ICON,
  load: (w) => loadPage(w, 'shot.html'),
  settings: getSettings,
  formats: async () => availableFormats((await detectFeatures()).codecs).image,
  onSaved: (path) => {
    const n = new Notification({ title: 'Screenshot saved', body: basename(path) })
    n.on('click', () => shell.showItemInFolder(path))
    n.show()
    recorder.update({ lastShot: path })
    maybeQuit()
  },
  onClosed: () => maybeQuit()
})

/** Hides this app's own windows (so they can't be in a picture of the screen); the returned function shows them again. */
function hideAppWindows(): () => void {
  const hidden = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible())
  for (const w of hidden) w.hide()
  return () => {
    for (const w of hidden) if (!w.isDestroyed()) w.showInactive()
  }
}

const snapper = new Snapper({
  settings: getSettings,
  attempts: (display) => grabAttempts(display),
  choose: (mode, frozen) => chooseTarget(mode, frozen),
  countdown: (display, seconds) => runCountdown({ display, rect: display.bounds }, seconds, 'Taking a screenshot…', true),
  hideApp: hideAppWindows,
  setBusy: (busy) => {
    recorder.update(busy ? { state: 'snapping', error: undefined } : { state: 'idle' })
    if (!busy) maybeQuit()
  },
  open: (png) => shots.open(png),
  fail: (message) => {
    recorder.update({ error: message })
    showMainWindow()
  }
})

function newestPending(): string | null {
  const [first] = listPending()
  return first ? basename(first) : null
}

function afterReview(): void {
  const next = newestPending()
  recorder.update({ pending: next })
  const file = next && resolvePending(next)
  if (file) editor.open(file)
  maybeQuit()
}

function openReview(): void {
  const file = editor.currentFile ?? (recorder.getStatus().pending && resolvePending(recorder.getStatus().pending!))
  if (file) editor.open(file)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 640,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Screen Snap',
    backgroundColor: '#101216',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  // Keeps the control panel out of every recording (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+).
  mainWindow.setContentProtection(true)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (!quitting && recorder.getStatus().state !== 'idle') {
      e.preventDefault()
      mainWindow?.hide()
      new Notification({ title: 'Still recording', body: `Stop with ${stopHint()}.` }).show()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    maybeQuit()
  })
  loadPage(mainWindow, 'index.html')
}

function showMainWindow(): void {
  if (!mainWindow) createMainWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

// The hidden audio window keeps Electron's window-all-closed from firing, so quit explicitly.
function maybeQuit(): void {
  if (!mainWindow && !editor.isOpen() && !shots.isOpen() && recorder.getStatus().state === 'idle') app.quit()
}

const label = (accelerator: string): string => acceleratorLabel(accelerator, IS_MAC)

/** "Stop with Alt+Shift+R or the tray icon" — only names a shortcut that is actually registered. */
function stopHint(): string {
  return hotkeyRegistered ? `${label(getSettings().hotkeyRecord)} or the tray icon` : 'the tray icon'
}

/**
 * (Re)registers the global shortcuts from Settings. They work in any app, so the defaults avoid the ones other
 * apps use (browsers: Ctrl+Shift+R hard refresh, Ctrl+Shift+I developer tools), and either can be changed or turned off.
 */
function applyHotkeys(): void {
  globalShortcut.unregisterAll()
  const s = getSettings()
  const register = (accelerator: string, run: () => void): boolean => {
    if (!accelerator) return false
    try {
      return globalShortcut.register(accelerator, run)
    } catch {
      return false // not a valid accelerator
    }
  }
  hotkeyRegistered = register(s.hotkeyRecord, () => void toggleRecording())
  shotHotkeyRegistered = s.hotkeyShot === s.hotkeyRecord ? false : register(s.hotkeyShot, () => void toggleScreenshot())
  updateTray()
}

function trayImage(recording: boolean): Electron.NativeImage {
  // macOS menu bar icons are 16pt "template" images that adapt to light/dark menu bars.
  if (IS_MAC) return nativeImage.createFromPath(join(RESOURCES, recording ? 'mac/trayRec.png' : 'mac/trayTemplate.png'))
  return nativeImage.createFromPath(join(RESOURCES, recording ? 'tray-rec.png' : 'tray-idle.png'))
}

function updateTray(): void {
  if (!tray) return
  const recording = recorder.getStatus().state === 'recording'
  tray.setImage(trayImage(recording))
  tray.setToolTip(recording ? 'Screen Snap — recording' : 'Screen Snap')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? 'Stop recording' : 'Start recording', click: () => void toggleRecording() },
      { label: 'Take a screenshot', click: () => void toggleScreenshot() },
      { label: 'Show window', click: showMainWindow },
      { label: 'Open recordings folder', click: () => void openOutputDir() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  tray = new Tray(trayImage(false))
  if (!IS_MAC) tray.on('click', showMainWindow)
  updateTray()
}

function displayLabel(d: Display, index: number): string {
  return d.id === screen.getPrimaryDisplay().id ? `Screen ${index + 1} (main)` : `Screen ${index + 1}`
}

function physicalSize(d: Display): { width: number; height: number } {
  return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
}

function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: displayLabel(d, i),
    ...physicalSize(d),
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId
  }))
}

async function getCapabilities(refresh = false): Promise<Capabilities> {
  if (refresh) invalidateDxgiOutputs()
  // On macOS, only read mic names once access is granted so the app doesn't prompt at launch.
  const primeMics = !IS_MAC || systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  const [features, microphones] = await Promise.all([detectFeatures(refresh), audio.listMicrophones(primeMics)])
  const displays = listDisplays()
  const formats = availableFormats(features.codecs)
  return {
    platformSupported: process.platform === 'win32' || IS_MAC || process.platform === 'linux',
    ffmpegVersion: features.version,
    ddagrab: features.ddagrab,
    displays,
    encoders: features.encoders,
    microphones,
    hotkey: hotkeyRegistered ? label(getSettings().hotkeyRecord) : null,
    shotHotkey: shotHotkeyRegistered ? label(getSettings().hotkeyShot) : null,
    videoFormats: formats.video,
    imageFormats: formats.image
  }
}

function toPhysical(rect: Rect): Rect {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, rect)
  const f = screen.getDisplayMatching(rect).scaleFactor
  return { x: Math.round(rect.x * f), y: Math.round(rect.y * f), width: Math.round(rect.width * f), height: Math.round(rect.height * f) }
}

/**
 * Like the Snipping Tool: an overlay covers every screen. In region mode the user drags an area on
 * any screen; in whole-screen mode they click the screen they want (skipped with a single screen).
 */
function chooseTarget(mode: CaptureMode, frozen?: Map<number, string>): Promise<Target | null> {
  const displays = screen.getAllDisplays()
  if (mode === 'fullscreen' && displays.length === 1) return Promise.resolve({ display: displays[0], rect: displays[0].bounds })

  return new Promise((resolve) => {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const overlays: { win: BrowserWindow; display: Display }[] = []
    let done = false

    const finish = (target: Target | null): void => {
      if (done) return
      done = true
      cancelSelection = null
      ipcMain.removeListener('overlay:done', onDone)
      for (const o of overlays) if (!o.win.isDestroyed()) o.win.destroy()
      resolve(target)
    }
    const onDone = (e: Electron.IpcMainEvent, result: OverlayResult): void => {
      const o = overlays.find((x) => x.win.webContents === e.sender)
      if (!o) return
      if (!result) return finish(null)
      if ('screen' in result) return finish({ display: o.display, rect: o.display.bounds })
      const r = result.rect
      const valid = [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 16 && r.height >= 16
      if (!valid) return finish(null)
      const b = o.display.bounds
      finish({ display: o.display, rect: { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height } })
    }
    ipcMain.on('overlay:done', onDone)
    cancelSelection = () => finish(null)

    displays.forEach((d, i) => {
      const win = new BrowserWindow({
        ...d.bounds,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        show: false,
        // macOS otherwise keeps windows below the menu bar, leaving that strip unselectable.
        enableLargerThanScreen: true,
        webPreferences: { preload: join(__dirname, '../preload/overlay.js') }
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      overlays.push({ win, display: d })
      win.on('closed', () => finish(null))
      win.once('ready-to-show', () => {
        win.setBounds(d.bounds)
        if (d.id === cursorDisplay.id) {
          win.show()
          win.focus()
        } else win.showInactive()
      })
      const size = physicalSize(d)
      loadPage(win, 'overlay.html', {
        ...(frozen?.get(d.id) ? { kind: 'shot', shot: frozen.get(d.id)! } : {}),
        mode: mode === 'fullscreen' ? 'screen' : 'region',
        label: displayLabel(d, i),
        size: `${size.width}×${size.height}`,
        active: d.id === cursorDisplay.id ? '1' : '0'
      })
    })
  })
}

/** Big 3-2-1 centred on the area being recorded. Resolves false if cancelled. */
function setCountdownNote(text: string): void {
  if (countdownWin && !countdownWin.isDestroyed()) {
    void countdownWin.webContents.executeJavaScript(
      `(() => { const n = document.getElementById('note'); if (n) { n.textContent = ${JSON.stringify(text)}; n.hidden = false } })()`
    ).catch(() => undefined)
  }
}

function runCountdown(target: Target, seconds: number, note?: string, quiet = false): Promise<boolean> {
  if (seconds <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const width = 320
    const height = 290
    const cx = target.rect.x + target.rect.width / 2
    const cy = target.rect.y + target.rect.height / 2
    const win = new BrowserWindow({
      x: Math.round(cx - width / 2),
      y: Math.round(cy - height / 2),
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false
    })
    win.setIgnoreMouseEvents(true)
    win.setContentProtection(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    countdownWin = win

    let left = seconds
    let timer: NodeJS.Timeout | null = null
    const finish = (ok: boolean): void => {
      if (timer) clearTimeout(timer)
      timer = null
      cancelCountdown = null
      if (countdownWin === win) countdownWin = null
      if (!win.isDestroyed()) win.destroy()
      resolve(ok)
    }
    cancelCountdown = () => finish(false)
    const tick = (): void => {
      if (left === 0) return finish(true)
      if (!quiet) recorder.update({ state: 'countdown', countdown: left })
      left -= 1
      timer = setTimeout(tick, 1000)
    }
    win.once('ready-to-show', () => {
      win.showInactive()
      win.setContentProtection(true) // re-apply now that the window really exists on screen
      tick()
    })
    loadPage(win, 'countdown.html', { s: String(seconds), ...(note ? { note } : {}) })
  })
}

/** Small floating timer + Stop button, excluded from the recording like the Snipping Tool's bar. */
function showBar(target: Target): void {
  closeBar()
  const place = barPlacement(target.display, target.rect, screen.getAllDisplays())
  bar = new BrowserWindow({
    x: place.x,
    y: place.y,
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    // Opaque on purpose: Windows' capture exclusion is far more dependable for ordinary windows than
    // for see-through (layered/composition-alpha) ones.
    transparent: false,
    backgroundColor: '#181b21',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  bar.setContentProtection(true)
  bar.setAlwaysOnTop(true, 'screen-saver')
  if (IS_MAC) bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const win = bar
  win.once('ready-to-show', () => {
    win.showInactive()
    // Re-apply once the window is really on screen, and again shortly after: on Windows the flag was found
    // switched off when set only at creation.
    win.setContentProtection(true)
    setTimeout(() => !win.isDestroyed() && win.setContentProtection(true), 400)
  })
  win.on('closed', () => {
    if (bar === win) bar = null
  })
  loadPage(win, 'bar.html')
}

function closeBar(): void {
  if (bar && !bar.isDestroyed()) bar.destroy()
  bar = null
}

/**
 * Does the bar show up in a screen capture of its own area? Windows' "exclude from capture" flag isn't
 * honoured everywhere (virtual displays, some capture methods, newer macOS), so rather than trust it the app
 * grabs a frame the same way the recording will and compares it with what the bar actually looks like.
 * It samples several times because a window can take a moment to appear on screen, stops (and calls
 * `onLeak`) the moment the bar is seen, and treats "couldn't tell" as a leak: hiding the bar unnecessarily
 * is harmless, showing it in a video isn't.
 */
async function barLeaksIntoCapture(
  win: BrowserWindow,
  attemptsFor: (dipRect: Rect) => Promise<Attempt[]>,
  onLeak: () => void
): Promise<boolean> {
  const note = (t: string): void => recorder.addNote(`bar check: ${t}`)
  try {
    if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    const bounds = win.getBounds()
    const attempts = (await attemptsFor(bounds)).filter(
      (a, i, all) => all.findIndex((b) => JSON.stringify([b.backend, b.dda, b.avf]) === JSON.stringify([a.backend, a.dda, a.avf])) === i
    )
    note(`bar at ${JSON.stringify(bounds)}; capture methods: ${attempts.map((a) => `${a.backend} ${JSON.stringify(a.rect)}`).join(' | ')}`)
    let decidedAny = false
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (win.isDestroyed() || startAborted) return false
      for (const attempt of attempts) {
        const { width, height } = attempt.rect
        const before = await win.webContents.capturePage()
        const grab = await runFfmpegBinary(buildGrabArgs(attempt))
        const after = await win.webContents.capturePage()
        if (!grab.ok || grab.stdout.length < width * height * 3) {
          note(`sample ${i} ${attempt.backend}: no frame (${grab.stderr.trim().split(/\r?\n/).pop() ?? ''})`)
          continue
        }
        const results = [before, after].map((img) => {
          const size = img.getSize()
          return size.width === width && size.height === height ? compareBar(img.toBitmap(), width, height, grab.stdout) : null
        })
        note(`sample ${i} ${attempt.backend}: page ${before.getSize().width}x${before.getSize().height} vs grab ${width}x${height}; ` +
          results.map((r) => (r ? `${r.compared} px compared, ${(r.matched * 100).toFixed(0)}% match` : 'size mismatch')).join(' / '))
        if (results.every((r) => r === null)) continue
        decidedAny = true
        if (results.some((r) => r?.visible)) {
          note(`the bar IS visible in the capture (sample ${i}) — hiding it`)
          onLeak()
          return true
        }
        break // this capture method worked; no need to try the others this round
      }
    }
    note(decidedAny ? 'the bar never showed up in the capture — keeping it on screen' : 'could not capture to compare — hiding the bar to be safe')
    if (!decidedAny) onLeak()
    return !decidedAny
  } catch (err) {
    note(`check failed (${(err as Error).message}) — hiding the bar to be safe`)
    onLeak()
    return true
  }
}

/** The control panel is hidden while choosing and recording so it can never end up in the video. */
function hidePanel(): void {
  if (mainWindow?.isVisible()) {
    panelHiddenForRecording = true
    mainWindow.hide()
  }
}

function restorePanel(): void {
  if (panelHiddenForRecording && mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive()
  panelHiddenForRecording = false
}

function logsDir(): string {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A fresh log file for one recording; only the newest 20 are kept. */
function newLogPath(stamp: string): string {
  const dir = logsDir()
  const old = readdirSync(dir)
    .filter((n) => /^recording .*\.log$/i.test(n))
    .map((n) => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const f of old.slice(19)) rmSync(f, { force: true })
  return join(dir, `recording ${stamp}.log`)
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

async function audioConfig(s: Settings): Promise<AudioConfig> {
  let mic: string | null = s.micEnabled ? s.micDevice : null
  if (mic && mic !== 'default') {
    // Device ids can change when a headset is re-plugged; fall back to matching by name.
    const mics = await audio.listMicrophones()
    if (!mics.some((m) => m.id === mic)) mic = mics.find((m) => m.label === s.micLabel)?.id ?? mic
  }
  return { system: s.systemAudio, systemVolume: s.systemVolume, mic, micVolume: s.micVolume, noiseSuppression: s.noiseSuppression }
}

function describeAudio(started: string[]): string {
  const names = started.map((s) => (s === 'system' ? 'computer sound' : 'mic'))
  const text = names.join(' + ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** macOS asks for Screen Recording permission once; recording can't work until it's granted. */
async function ensureMacPermissions(s: Settings): Promise<void> {
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // Asking for sources registers the app and shows the macOS prompt the first time.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      throw new Error(
        'Screen Snap needs permission to see your screen. Turn it on in System Settings › Privacy & Security › ' +
          'Screen & System Audio Recording, then quit and reopen Screen Snap.'
      )
    }
  }
  if (s.micEnabled) await systemPreferences.askForMediaAccess('microphone')
}

function windowsAttempts(base: Omit<Attempt, 'backend' | 'rect'>, s: Settings, display: Display, rect: Rect, ddagrab: boolean, outputs: Awaited<ReturnType<typeof dxgiOutputs>>): Attempt[] {
  const attempts: Attempt[] = []
  const output = ddagrab ? matchOutput(outputs, toPhysical(display.bounds)) : null
  if (output && s.backend !== 'gdigrab') {
    attempts.push({
      ...base,
      backend: 'ddagrab',
      dda: { adapter: output.adapter, output: output.output },
      rect: { x: Math.max(0, rect.x - output.left), y: Math.max(0, rect.y - output.top), width: rect.width, height: rect.height }
    })
  }
  attempts.push({ ...base, backend: 'gdigrab', rect })
  if (base.encoder !== 'libx264') attempts.push({ ...base, backend: 'gdigrab', rect, encoder: 'libx264' })
  return attempts
}

async function macAttempts(base: Omit<Attempt, 'backend' | 'rect'>, display: Display, dipRect: Rect): Promise<Attempt[]> {
  const [order, screens] = await Promise.all([macDisplayOrder(), avfoundationScreens()])
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  // Without the helper, assume FFmpeg's order: main display first, then the rest.
  const fallback = [primary, ...all.filter((d) => d.id !== primary.id)].map((d) => d.id)
  const n = Math.max(0, (order ?? fallback).indexOf(display.id))
  const device = screens.get(n) ?? `Capture screen ${n}`
  const f = display.scaleFactor
  const rect = {
    x: Math.round((dipRect.x - display.bounds.x) * f),
    y: Math.round((dipRect.y - display.bounds.y) * f),
    width: Math.round(dipRect.width * f),
    height: Math.round(dipRect.height * f)
  }
  const attempts: Attempt[] = [
    { ...base, backend: 'avfoundation', avf: { device, pixelFormat: 'bgr0' }, rect },
    { ...base, backend: 'avfoundation', avf: { device, pixelFormat: null }, rect }
  ]
  if (base.encoder !== 'libx264') attempts.push({ ...base, backend: 'avfoundation', avf: { device, pixelFormat: null }, rect, encoder: 'libx264' })
  return attempts
}

/** Capture methods for one whole screen, best first — what a screenshot uses (the same ones recording uses). */
async function grabAttempts(display: Display): Promise<Attempt[]> {
  const s = getSettings()
  const base = {
    fps: 60, outputHeight: null, quality: 'maximum' as const, encoder: 'libx264', basicTuning: false, audio: [], showCursor: false
  }
  let list: Attempt[]
  if (IS_MAC) list = await macAttempts(base, display, display.bounds)
  else if (process.platform === 'linux') {
    list = [{ ...base, backend: 'x11grab', x11Display: process.env.DISPLAY ?? ':0', rect: toPhysical(display.bounds) }]
  } else {
    const features = await detectFeatures()
    const outputs = s.backend === 'gdigrab' ? [] : await dxgiOutputs()
    list = windowsAttempts(base, s, display, toPhysical(display.bounds), features.ddagrab, outputs)
  }
  // The encoder doesn't matter for one picture, so drop the duplicates that only differ by it.
  return list.filter((a, i, all) => all.findIndex((b) => b.backend === a.backend && JSON.stringify(b.avf) === JSON.stringify(a.avf)) === i)
}

async function startRecording(): Promise<void> {
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('Recording is supported on Windows and macOS only.')
  const s = getSettings()
  startAborted = false
  recorder.update({ error: undefined, warning: undefined })
  if (IS_MAC) await ensureMacPermissions(s)

  hidePanel()
  recorder.update({ state: 'selecting' })
  const target = await chooseTarget(s.mode)
  if (!target) {
    recorder.update({ state: 'idle' })
    restorePanel()
    return
  }
  const { display, rect: dipRect } = target

  // Everything slow happens before the countdown, so recording starts right after "1".
  const [features, outputs] = await Promise.all([
    detectFeatures(),
    process.platform !== 'win32' || s.backend === 'gdigrab' ? Promise.resolve([]) : dxgiOutputs()
  ])
  const encoder = chooseEncoder(features.encoders, s.encoder, s.quality)

  let audioInputs: AudioInput[] = []
  let audioLabel: string | undefined
  let warning: string | undefined
  if (s.systemAudio || s.micEnabled) {
    try {
      const res = await audio.start(await audioConfig(s), true)
      if (res.inputs.length) {
        audioInputs = res.inputs
        audioLabel = describeAudio(res.started)
      } else await audio.stop()
      if (res.errors.length) warning = `Some audio isn't being recorded — ${res.errors.join('; ')}`
    } catch (err) {
      warning = `Recording without audio — ${(err as Error).message}`
      await audio.stop()
    }
  }

  const base = {
    fps: s.fps,
    outputHeight: s.outputHeight,
    quality: s.quality,
    encoder,
    basicTuning: needsBasicTuning(features.encoders, encoder),
    audio: audioInputs,
    showCursor: s.showCursor
  }
  const attemptsFor = async (rect: Rect): Promise<Attempt[]> =>
    IS_MAC
      ? macAttempts(base, display, rect)
      : process.platform === 'linux'
        ? [{ ...base, backend: 'x11grab' as const, x11Display: process.env.DISPLAY ?? ':0', rect: toPhysical(rect) }]
        : windowsAttempts(base, s, display, toPhysical(rect), features.ddagrab, outputs)
  const attempts = await attemptsFor(dipRect)

  showBar(target)
  recorder.update({ state: 'countdown', countdown: undefined })
  const hideNote = `Stop with ${stopHint()}. The bar hides while recording so it can't appear in your video.`
  let barMovedAway = false
  // The timer sits on the screen being recorded. The check runs while the countdown plays; if the bar ever shows
  // up in the capture it moves to the other screen (or hides, with only one screen) so it can't be in the video.
  const check =
    bar && overlaps(bar.getBounds(), target.rect, 0)
      ? barLeaksIntoCapture(bar, attemptsFor, () => {
          const away = bar ? awayPlacement(display, screen.getAllDisplays()) : null
          if (bar && away) {
            bar.setPosition(away.x, away.y)
            barMovedAway = true
            setCountdownNote('The timer is on your other screen so it can’t appear in your video.')
          } else {
            bar?.hide()
            setCountdownNote(hideNote)
          }
        })
      : Promise.resolve(false)

  const counted = await runCountdown(target, s.countdown)
  const hideBar = await check
  if (startAborted || !counted || startAborted) {
    await audio.stop()
    closeBar()
    recorder.update({ state: 'idle', countdown: undefined })
    restorePanel()
    return
  }
  if (hideBar && !barMovedAway) bar?.hide()
  // Capture starts now; FFmpeg's start-up check takes a moment before the state flips to 'recording'.
  recorder.update({ state: 'countdown', countdown: 0 })

  try {
    const stamp = timestamp()
    await recorder.start(attempts, join(pendingDir(), `Recording ${stamp}.mp4`), newLogPath(stamp))
  } catch (err) {
    await audio.stop()
    throw err
  }
  recorder.update({ audio: audioLabel, warning, countdown: undefined })
}

async function toggleRecording(): Promise<void> {
  const { state } = recorder.getStatus()
  if (state === 'recording') return recorder.stop()
  if (state === 'countdown') {
    startAborted = true // also covers the moment before the countdown window exists
    return cancelCountdown?.()
  }
  if (state === 'selecting') return cancelSelection?.()
  if (state !== 'idle') return
  try {
    await startRecording()
  } catch (err) {
    void audio.stop()
    closeBar()
    panelHiddenForRecording = false
    recorder.update({ state: 'idle', countdown: undefined, error: (err as Error).message })
    showMainWindow()
  }
}

/** Starts a screenshot, or cancels one that is still waiting (countdown / choosing the area). */
async function toggleScreenshot(): Promise<void> {
  if (snapper.busy) {
    cancelCountdown?.()
    cancelSelection?.()
    return
  }
  if (recorder.getStatus().state !== 'idle') return
  if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    try {
      await ensureMacPermissions({ ...getSettings(), micEnabled: false })
    } catch (err) {
      recorder.update({ error: (err as Error).message })
      showMainWindow()
      return
    }
  }
  recorder.update({ error: undefined })
  await snapper.run()
}

async function openOutputDir(): Promise<void> {
  const dir = getSettings().outputDir
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
}

function registerIpc(): void {
  ipcMain.handle('caps:get', (_e, refresh?: boolean) => getCapabilities(Boolean(refresh)))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    if (IS_MAC && patch.micEnabled && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      if (await systemPreferences.askForMediaAccess('microphone')) mainWindow?.webContents.send('caps:changed')
    }
    const updated = updateSettings(patch)
    if ('hotkeyRecord' in patch || 'hotkeyShot' in patch) {
      applyHotkeys()
      mainWindow?.webContents.send('caps:changed')
    }
    return updated
  })
  ipcMain.handle('settings:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: getSettings().outputDir,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? getSettings() : updateSettings({ outputDir: res.filePaths[0] })
  })
  ipcMain.handle('settings:chooseShotDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { defaultPath: getSettings().shotDir, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('shell:openShotDir', async () => {
    const dir = getSettings().shotDir
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle('rec:toggle', () => toggleRecording())
  ipcMain.handle('shot:take', () => toggleScreenshot())
  ipcMain.handle('rec:status', () => recorder.getStatus())
  ipcMain.handle('rec:review', () => openReview())
  ipcMain.handle('window:fit', (e, height: number) => {
    if (!mainWindow || e.sender !== mainWindow.webContents || !Number.isFinite(height)) return
    // Grow/shrink with the content (e.g. when Settings opens), but never past the screen.
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    mainWindow.setContentSize(PANEL_WIDTH, Math.round(Math.min(Math.max(height, 320), area.height - 40)))
  })
  ipcMain.handle('audio:test', async (_e, on: boolean) => {
    if (recorder.getStatus().state !== 'idle') return []
    if (!on) {
      await audio.stop()
      return []
    }
    const res = await audio.start(await audioConfig(getSettings()), false)
    return res.errors
  })
  ipcMain.handle('shell:openDir', () => openOutputDir())
  ipcMain.handle('shell:openLogs', () => shell.openPath(logsDir()))
  ipcMain.handle('shell:showLast', () => {
    const f = recorder.getStatus().lastFile
    if (f) shell.showItemInFolder(f)
  })
  ipcMain.handle('shell:showLastShot', () => {
    const f = recorder.getStatus().lastShot
    if (f) shell.showItemInFolder(f)
  })
  ipcMain.handle('shell:openLastShot', async () => {
    const f = recorder.getStatus().lastShot
    if (f) await shell.openPath(f)
  })
  ipcMain.handle('shell:playLast', async () => {
    const f = recorder.getStatus().lastFile
    if (f) await shell.openPath(f)
  })
}

recorder.on('status', (status) => {
  mainWindow?.webContents.send('rec:status', status)
  if (bar && !bar.isDestroyed()) bar.webContents.send('rec:status', status)
  updateTray()
})

recorder.on('recorded', async (file: string, info: RecordedInfo) => {
  void audio.stop()
  closeBar()
  restorePanel()
  // Never open the review window on a recording that doesn't play — say what went wrong instead.
  if (!info.ok) {
    removePending(file)
    const reason = lastLine(info.stderr)
    recorder.update({
      pending: newestPending(),
      error: `The recording failed: ${info.reason ?? 'no video was captured.'}${reason ? `\nFFmpeg said: ${reason}` : ''}\nFull details: ${info.log}`
    })
    showMainWindow()
    return
  }
  recorder.update({ pending: basename(file) })
  // Don't yank the editor away from a recording the user is already reviewing; it opens next.
  if (!editor.isOpen()) editor.open(file)
})

audio.on('levels', (levels) => mainWindow?.webContents.send('audio:levels', levels))

app.on('second-instance', showMainWindow)
app.on('activate', showMainWindow)

app.on('before-quit', (e) => {
  quitting = true
  const { state } = recorder.getStatus()
  if (state === 'recording' || state === 'saving') {
    e.preventDefault()
    void recorder.stop().then(() => app.quit())
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

void app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.shaunownhouse.screensnap')
  migrateFromOldName()
  clearShotTmp()
  handleMediaProtocol()
  registerIpc()
  applyHotkeys()
  const notifyDisplays = (): void => {
    invalidateDxgiOutputs()
    mainWindow?.webContents.send('caps:changed')
  }
  screen.on('display-added', notifyDisplays)
  screen.on('display-removed', notifyDisplays)
  screen.on('display-metrics-changed', notifyDisplays)

  await recoverInterrupted(async (i, o) => (await runFfmpeg(buildRemuxArgs(i, o), 10 * 60 * 1000)).ok)
  // Recordings left over from earlier versions that can't be opened would only get in the way.
  for (const f of listPending()) if (!(await checkStructure(f)).ok) removePending(f)
  recorder.update({ pending: newestPending() })
  createMainWindow()
  createTray()
  void detectFeatures()
  void dxgiOutputs()
})
