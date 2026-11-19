import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayApi } from '../shared/api.ts'

const overlay: OverlayApi = {
  done: (result) => ipcRenderer.send('overlay:done', result)
}

contextBridge.exposeInMainWorld('overlay', overlay)
