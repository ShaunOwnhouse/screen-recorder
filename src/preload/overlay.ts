import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayApi } from '../shared/api.ts'

const overlay: OverlayApi = {
  done: (rect) => ipcRenderer.send('overlay:done', rect)
}

contextBridge.exposeInMainWorld('overlay', overlay)
