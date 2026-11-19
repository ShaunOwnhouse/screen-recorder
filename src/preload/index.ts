import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api.ts'
import type { RecordingStatus } from '../shared/types.ts'

const api: Api = {
  getCapabilities: (refresh = false) => ipcRenderer.invoke('caps:get', refresh),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseOutputDir: () => ipcRenderer.invoke('settings:chooseDir'),
  toggleRecording: () => ipcRenderer.invoke('rec:toggle'),
  getStatus: () => ipcRenderer.invoke('rec:status'),
  openOutputDir: () => ipcRenderer.invoke('shell:openDir'),
  showLastRecording: () => ipcRenderer.invoke('shell:showLast'),
  playLastRecording: () => ipcRenderer.invoke('shell:playLast'),
  onStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, s: RecordingStatus): void => cb(s)
    ipcRenderer.on('rec:status', listener)
    return () => ipcRenderer.removeListener('rec:status', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
