import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EditorApi } from '../shared/api.ts'

const editor: EditorApi = {
  load: () => ipcRenderer.invoke('editor:load'),
  reveal: () => ipcRenderer.invoke('editor:reveal'),
  makeProxy: () => ipcRenderer.invoke('editor:proxy'),
  save: (req) => ipcRenderer.invoke('editor:save', req),
  cancelExport: () => ipcRenderer.invoke('editor:cancel'),
  discard: () => ipcRenderer.invoke('editor:discard'),
  onProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, f: number): void => cb(f)
    ipcRenderer.on('editor:progress', listener)
    return () => ipcRenderer.removeListener('editor:progress', listener)
  }
}

contextBridge.exposeInMainWorld('editor', editor)
