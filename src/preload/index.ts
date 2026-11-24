import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api.ts'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  getCapabilities: (refresh = false) => ipcRenderer.invoke('caps:get', refresh),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseOutputDir: () => ipcRenderer.invoke('settings:chooseDir'),
  chooseShotDir: () => ipcRenderer.invoke('settings:chooseShotDir'),
  openShotDir: () => ipcRenderer.invoke('shell:openShotDir'),
  toggleRecording: () => ipcRenderer.invoke('rec:toggle'),
  togglePause: () => ipcRenderer.invoke('rec:pause'),
  takeScreenshot: () => ipcRenderer.invoke('shot:take'),
  getStatus: () => ipcRenderer.invoke('rec:status'),
  openOutputDir: () => ipcRenderer.invoke('shell:openDir'),
  openLogs: () => ipcRenderer.invoke('shell:openLogs'),
  showLastRecording: () => ipcRenderer.invoke('shell:showLast'),
  playLastRecording: () => ipcRenderer.invoke('shell:playLast'),
  showLastShot: () => ipcRenderer.invoke('shell:showLastShot'),
  openLastShot: () => ipcRenderer.invoke('shell:openLastShot'),
  openReview: () => ipcRenderer.invoke('rec:review'),
  testAudio: (on) => ipcRenderer.invoke('audio:test', on),
  listCameras: () => ipcRenderer.invoke('camera:list'),
  fitHeight: (height) => ipcRenderer.invoke('window:fit', height),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => subscribe('update:status', cb),
  onStatus: (cb) => subscribe('rec:status', cb),
  onLevels: (cb) => subscribe('audio:levels', cb),
  onCapsChanged: (cb) => subscribe('caps:changed', () => cb())
}

contextBridge.exposeInMainWorld('api', api)
