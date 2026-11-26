import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { EditorApi } from '../shared/api.ts'

const editor: EditorApi = {
  load: () => ipcRenderer.invoke('editor:load'),
  reveal: () => ipcRenderer.invoke('editor:reveal'),
  makeProxy: () => ipcRenderer.invoke('editor:proxy'),
  pickMedia: (kind) => ipcRenderer.invoke('editor:pick-media', kind),
  addMedia: (paths, kind) => ipcRenderer.invoke('editor:add-media', paths, kind),
  saveAsset: (spec) => ipcRenderer.invoke('editor:save-asset', spec),
  pathFor: (file) => webUtils.getPathForFile(file),
  waveform: (id, buckets) => ipcRenderer.invoke('editor:waveform', id, buckets),
  strip: (id, count) => ipcRenderer.invoke('editor:strip', id, count),
  saveBrand: (brand) => ipcRenderer.invoke('editor:save-brand', brand),
  pickFont: () => ipcRenderer.invoke('editor:pick-font'),
  fontData: (file) => ipcRenderer.invoke('editor:font-data', file),
  save: (req) => ipcRenderer.invoke('editor:save', req),
  cancelExport: () => ipcRenderer.invoke('editor:cancel'),
  discard: () => ipcRenderer.invoke('editor:discard'),
  previewFinal: (req) => ipcRenderer.invoke('editor:preview-final', req),
  finish: () => ipcRenderer.invoke('editor:finish'),
  revealPath: (path) => ipcRenderer.invoke('editor:reveal-path', path),
  onBelowScreen: (cb) => {
    const listener = (_e: IpcRendererEvent, px: number): void => cb(px)
    ipcRenderer.on('editor:below-screen', listener)
    return () => ipcRenderer.removeListener('editor:below-screen', listener)
  },
  onProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, f: number): void => cb(f)
    ipcRenderer.on('editor:progress', listener)
    return () => ipcRenderer.removeListener('editor:progress', listener)
  }
}

contextBridge.exposeInMainWorld('editor', editor)
