import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray,
  type Display
} from 'electron'
import { detectFeatures, pickAutoEncoder } from './ffmpeg.ts'
import { Recorder } from './recorder.ts'
import { getSettings, updateSettings } from './settings.ts'
import type { Capabilities, DisplayInfo, Rect, Settings } from '../shared/types.ts'

const HOTKEY = 'CommandOrControl+Shift+R'
const RESOURCES = join(__dirname, '../../resources')

const recorder = new Recorder()
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let hotkeyRegistered = false

if (!app.requestSingleInstanceLock()) app.quit()

function loadPage(win: BrowserWindow, page: 'index.html' | 'overlay.html'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}`)
  else void win.loadFile(join(__dirname, '../renderer', page))
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 440,
    height: Math.min(960, screen.getPrimaryDisplay().workAreaSize.height - 40),
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Screen Recorder',
    backgroundColor: '#101216',
    autoHideMenuBar: true,
    icon: join(RESOURCES, 'icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  // Keeps the control panel out of every recording (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+).
  mainWindow.setContentProtection(true)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (recorder.getStatus().state === 'recording') {
      e.preventDefault()
      mainWindow?.hide()
      new Notification({ title: 'Still recording', body: `Press ${hotkeyLabel()} or use the tray icon to stop.` }).show()
    }
  })
  mainWindow.on('closed', () => (mainWindow = null))
  loadPage(mainWindow, 'index.html')
}

function showMainWindow(): void {
  if (!mainWindow) createMainWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
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

function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => {
    const width = Math.round(d.size.width * d.scaleFactor)
    const height = Math.round(d.size.height * d.scaleFactor)
    return {
      id: d.id,
      label: `Display ${i + 1} — ${width}×${height}${d.id === primaryId ? ' (main)' : ''}`,
      width,
      height,
      scaleFactor: d.scaleFactor,
      primary: d.id === primaryId
    }
  })
}

async function getCapabilities(refresh = false): Promise<Capabilities> {
  const features = await detectFeatures(refresh)
  return {
    platformSupported: process.platform === 'win32',
    ffmpegVersion: features.version,
    ddagrab: features.ddagrab,
    displays: listDisplays(),
    encoders: features.encoders,
    audioDevices: features.audioDevices,
    hotkey: hotkeyRegistered ? hotkeyLabel() : null
  }
}

function toPhysical(rect: Rect): Rect {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, rect)
  const d = screen.getDisplayMatching(rect)
  const f = d.scaleFactor
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

async function startRecording(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Recording is currently supported on Windows only.')
  const s = getSettings()
  const primary = screen.getPrimaryDisplay()
  const display = screen.getAllDisplays().find((d) => d.id === s.displayId) ?? primary

  let dipRect: Rect = display.bounds
  if (s.mode === 'region') {
    recorder.update({ state: 'selecting', error: undefined })
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
  const caps = await getCapabilities()
  const encoder = s.encoder !== 'auto' && caps.encoders.some((e) => e.id === s.encoder) ? s.encoder : pickAutoEncoder(caps.encoders)
  const base = {
    fps: s.fps,
    outputHeight: s.outputHeight,
    quality: s.quality,
    encoder,
    audioDevice: s.audioDevice && caps.audioDevices.includes(s.audioDevice) ? s.audioDevice : null,
    showCursor: s.showCursor
  }

  // Desktop Duplication (ddagrab) is far faster than GDI but only reliably addresses the main monitor.
  const attempts = []
  if (caps.ddagrab && s.backend !== 'gdigrab' && display.id === primary.id) {
    const origin = toPhysical(primary.bounds)
    attempts.push({ ...base, backend: 'ddagrab' as const, rect: { ...rect, x: rect.x - origin.x, y: rect.y - origin.y } })
  }
  attempts.push({ ...base, backend: 'gdigrab' as const, rect })
  if (encoder !== 'libx264') attempts.push({ ...base, backend: 'gdigrab' as const, rect, encoder: 'libx264' })

  mkdirSync(s.outputDir, { recursive: true })
  await recorder.start(attempts, join(s.outputDir, `Recording ${timestamp()}.mp4`))
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

recorder.on('saved', (file: string) => {
  const n = new Notification({ title: 'Recording saved', body: basename(file) })
  n.on('click', () => shell.showItemInFolder(file))
  n.show()
})

app.on('second-instance', showMainWindow)

app.on('before-quit', (e) => {
  if (recorder.getStatus().state === 'recording' || recorder.getStatus().state === 'saving') {
    e.preventDefault()
    void recorder.stop().then(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  if (recorder.getStatus().state === 'idle') app.quit()
})

app.on('will-quit', () => globalShortcut.unregisterAll())

void app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.shaunownhouse.screenrecorder')
  registerIpc()
  hotkeyRegistered = globalShortcut.register(HOTKEY, () => void toggleRecording())
  createMainWindow()
  createTray()
  void detectFeatures()
})
