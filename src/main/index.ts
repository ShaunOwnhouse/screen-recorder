import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray,
  type Display
} from 'electron'
import { buildRemuxArgs, type RecordArgsInput } from './args.ts'
import { AudioCapture, type AudioConfig } from './audio.ts'
import { dxgiOutputs, invalidateDxgiOutputs, matchOutput } from './displays.ts'
import { EditorController } from './editor.ts'
import { chooseEncoder, detectFeatures, runFfmpeg } from './ffmpeg.ts'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol.ts'
import { listPending, pendingDir, recoverInterrupted, resolvePending } from './pending.ts'
import { Recorder } from './recorder.ts'
import { getSettings, updateSettings } from './settings.ts'
import type { Capabilities, DisplayInfo, Rect, Settings } from '../shared/types.ts'

const HOTKEY = 'CommandOrControl+Shift+R'
const RESOURCES = join(__dirname, '../../resources')
const ICON = join(RESOURCES, 'icon.png')
type Page = 'index.html' | 'overlay.html' | 'editor.html' | 'audio.html'

registerMediaScheme()

const recorder = new Recorder()
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let hotkeyRegistered = false
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()

function loadPage(win: BrowserWindow, page: Page): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}`)
  else void win.loadFile(join(__dirname, '../renderer', page))
}

const audio = new AudioCapture(join(__dirname, '../preload/audio.js'), (w) => loadPage(w, 'audio.html'))

const editor = new EditorController({
  preload: join(__dirname, '../preload/editor.js'),
  icon: ICON,
  load: (w) => loadPage(w, 'editor.html'),
  settings: getSettings,
  encoders: async () => (await detectFeatures()).encoders,
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
    width: 460,
    height: Math.min(1000, screen.getPrimaryDisplay().workAreaSize.height - 40),
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Screen Recorder',
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
      new Notification({ title: 'Still recording', body: `Press ${hotkeyLabel()} or use the tray icon to stop.` }).show()
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
  if (!mainWindow && !editor.isOpen() && recorder.getStatus().state === 'idle') app.quit()
}

function hotkeyLabel(): string {
  return HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
}

function updateTray(): void {
  if (!tray) return
  const recording = recorder.getStatus().state === 'recording'
  tray.setImage(nativeImage.createFromPath(join(RESOURCES, recording ? 'tray-rec.png' : 'tray-idle.png')))
  tray.setToolTip(recording ? 'Screen Recorder — recording' : 'Screen Recorder')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? 'Stop recording' : 'Start recording', accelerator: HOTKEY, click: () => void toggleRecording() },
      { label: 'Show window', click: showMainWindow },
      { label: 'Open recordings folder', click: () => void openOutputDir() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(join(RESOURCES, 'tray-idle.png')))
  tray.on('click', showMainWindow)
  updateTray()
}

async function screenThumbnails(): Promise<Map<string, string>> {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    return new Map(sources.map((s) => [s.display_id, s.thumbnail.toDataURL()]))
  } catch {
    return new Map()
  }
}

async function listDisplays(): Promise<DisplayInfo[]> {
  const thumbs = await screenThumbnails()
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => {
    const width = Math.round(d.size.width * d.scaleFactor)
    const height = Math.round(d.size.height * d.scaleFactor)
    return {
      id: d.id,
      label: d.id === primaryId ? `Screen ${i + 1} (main)` : `Screen ${i + 1}`,
      width,
      height,
      scaleFactor: d.scaleFactor,
      primary: d.id === primaryId,
      thumbnail: thumbs.get(String(d.id)) ?? null
    }
  })
}

async function getCapabilities(refresh = false): Promise<Capabilities> {
  if (refresh) invalidateDxgiOutputs()
  const [features, displays, microphones] = await Promise.all([detectFeatures(refresh), listDisplays(), audio.listMicrophones()])
  return {
    platformSupported: process.platform === 'win32',
    ffmpegVersion: features.version,
    ddagrab: features.ddagrab,
    displays,
    encoders: features.encoders,
    microphones,
    hotkey: hotkeyRegistered ? hotkeyLabel() : null
  }
}

function toPhysical(rect: Rect): Rect {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, rect)
  const f = screen.getDisplayMatching(rect).scaleFactor
  return { x: Math.round(rect.x * f), y: Math.round(rect.y * f), width: Math.round(rect.width * f), height: Math.round(rect.height * f) }
}

function selectRegion(display: Display): Promise<Rect | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      ...display.bounds,
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
      webPreferences: { preload: join(__dirname, '../preload/overlay.js') }
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    let done = false
    const finish = (rect: Rect | null): void => {
      if (done) return
      done = true
      ipcMain.removeListener('overlay:done', onDone)
      if (!win.isDestroyed()) win.close()
      resolve(rect)
    }
    const onDone = (e: Electron.IpcMainEvent, rect: Rect | null): void => {
      if (e.sender !== win.webContents) return
      const valid = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 16 && rect.height >= 16
      finish(valid ? rect : null)
    }
    ipcMain.on('overlay:done', onDone)
    win.on('closed', () => finish(null))
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds)
      win.show()
      win.focus()
    })
    loadPage(win, 'overlay.html')
  })
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

async function audioConfig(s: Settings): Promise<AudioConfig> {
  let mic = s.micDevice
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

async function startRecording(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Recording is currently supported on Windows only.')
  const s = getSettings()
  const primary = screen.getPrimaryDisplay()
  const display = screen.getAllDisplays().find((d) => d.id === s.displayId) ?? primary
  recorder.update({ error: undefined, warning: undefined })

  let dipRect: Rect = display.bounds
  if (s.mode === 'region') {
    recorder.update({ state: 'selecting', error: undefined, warning: undefined })
    const sel = await selectRegion(display)
    if (!sel) {
      recorder.update({ state: 'idle' })
      return
    }
    dipRect = { x: display.bounds.x + sel.x, y: display.bounds.y + sel.y, width: sel.width, height: sel.height }
    // Give the compositor a moment to remove the overlay before the first frame is grabbed.
    await new Promise((r) => setTimeout(r, 250))
  }

  const rect = toPhysical(dipRect)
  const [features, outputs] = await Promise.all([detectFeatures(), s.backend === 'gdigrab' ? Promise.resolve([]) : dxgiOutputs()])
  const encoder = chooseEncoder(features.encoders, s.encoder, s.quality)

  let audioInput: string | null = null
  let audioLabel: string | undefined
  let warning: string | undefined
  if (s.systemAudio || s.micDevice) {
    try {
      const res = await audio.start(await audioConfig(s), true)
      if (res.started.length) {
        audioInput = res.pipePath
        audioLabel = describeAudio(res.started)
      } else await audio.stop()
      if (res.errors.length) warning = `Some audio isn't being recorded — ${res.errors.join('; ')}`
    } catch (err) {
      warning = `Recording without audio — ${(err as Error).message}`
      await audio.stop()
    }
  }

  const base = { fps: s.fps, outputHeight: s.outputHeight, quality: s.quality, encoder, audioInput, showCursor: s.showCursor }
  const attempts: Omit<RecordArgsInput, 'outputPath'>[] = []
  const output = features.ddagrab ? matchOutput(outputs, toPhysical(display.bounds)) : null
  if (output && s.backend !== 'gdigrab') {
    attempts.push({
      ...base,
      backend: 'ddagrab',
      dda: { adapter: output.adapter, output: output.output },
      rect: { x: Math.max(0, rect.x - output.left), y: Math.max(0, rect.y - output.top), width: rect.width, height: rect.height }
    })
  }
  attempts.push({ ...base, backend: 'gdigrab', rect })
  if (encoder !== 'libx264') attempts.push({ ...base, backend: 'gdigrab', rect, encoder: 'libx264' })

  try {
    await recorder.start(attempts, join(pendingDir(), `Recording ${timestamp()}.mp4`))
  } catch (err) {
    await audio.stop()
    throw err
  }
  recorder.update({ audio: audioLabel, warning })
}

async function toggleRecording(): Promise<void> {
  const { state } = recorder.getStatus()
  if (state === 'recording') return recorder.stop()
  if (state !== 'idle') return
  try {
    await startRecording()
  } catch (err) {
    recorder.update({ state: 'idle', error: (err as Error).message })
    showMainWindow()
  }
}

async function openOutputDir(): Promise<void> {
  const dir = getSettings().outputDir
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
}

function registerIpc(): void {
  ipcMain.handle('caps:get', (_e, refresh?: boolean) => getCapabilities(Boolean(refresh)))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => updateSettings(patch))
  ipcMain.handle('settings:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: getSettings().outputDir,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? getSettings() : updateSettings({ outputDir: res.filePaths[0] })
  })
  ipcMain.handle('rec:toggle', () => toggleRecording())
  ipcMain.handle('rec:status', () => recorder.getStatus())
  ipcMain.handle('rec:review', () => openReview())
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
  ipcMain.handle('shell:showLast', () => {
    const f = recorder.getStatus().lastFile
    if (f) shell.showItemInFolder(f)
  })
  ipcMain.handle('shell:playLast', async () => {
    const f = recorder.getStatus().lastFile
    if (f) await shell.openPath(f)
  })
}

recorder.on('status', (status) => {
  mainWindow?.webContents.send('rec:status', status)
  updateTray()
})

recorder.on('recorded', (file: string) => {
  void audio.stop()
  recorder.update({ pending: basename(file) })
  // Don't yank the editor away from a recording the user is already reviewing; it opens next.
  if (!editor.isOpen()) editor.open(file)
})

audio.on('levels', (levels) => mainWindow?.webContents.send('audio:levels', levels))

app.on('second-instance', showMainWindow)

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
  if (process.platform === 'win32') app.setAppUserModelId('com.shaunownhouse.screenrecorder')
  handleMediaProtocol()
  registerIpc()
  hotkeyRegistered = globalShortcut.register(HOTKEY, () => void toggleRecording())
  const notifyDisplays = (): void => {
    invalidateDxgiOutputs()
    mainWindow?.webContents.send('caps:changed')
  }
  screen.on('display-added', notifyDisplays)
  screen.on('display-removed', notifyDisplays)
  screen.on('display-metrics-changed', notifyDisplays)

  await recoverInterrupted(async (i, o) => (await runFfmpeg(buildRemuxArgs(i, o), 10 * 60 * 1000)).ok)
  recorder.update({ pending: newestPending() })
  createMainWindow()
  createTray()
  void detectFeatures()
  void dxgiOutputs()
})
