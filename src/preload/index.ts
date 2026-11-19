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
  toggleRecording: () => ipcRenderer.invoke('rec:toggle'),
  getStatus: () => ipcRenderer.invoke('rec:status'),
  openOutputDir: () => ipcRenderer.invoke('shell:openDir'),
  openLogs: () => ipcRenderer.invoke('shell:openLogs'),
  showLastRecording: () => ipcRenderer.invoke('shell:showLast'),
  playLastRecording: () => ipcRenderer.invoke('shell:playLast'),
  openReview: () => ipcRenderer.invoke('rec:review'),
  testAudio: (on) => ipcRenderer.invoke('audio:test', on),
  fitHeight: (height) => ipcRenderer.invoke('window:fit', height),
  onStatus: (cb) => subscribe('rec:status', cb),
  onLevels: (cb) => subscribe('audio:levels', cb),
  onCapsChanged: (cb) => subscribe('caps:changed', () => cb())
}

contextBridge.exposeInMainWorld('api', api)
