import { contextBridge, ipcRenderer } from 'electron'
import type { ShotApi } from '../shared/api.ts'

const shot: ShotApi = {
  load: () => ipcRenderer.invoke('shot:load'),
  bytes: () => ipcRenderer.invoke('shot:bytes'),
  save: (req) => ipcRenderer.invoke('shot:save', req),
  copy: (req) => ipcRenderer.invoke('shot:copy', req),
  discard: (edited) => ipcRenderer.invoke('shot:discard', edited),
  setDirty: (dirty) => ipcRenderer.send('shot:dirty', dirty)
}

contextBridge.exposeInMainWorld('shot', shot)
