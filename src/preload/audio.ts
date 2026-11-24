import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AudioBridgeApi } from '../shared/api.ts'

type Handler = (payload: unknown) => Promise<unknown> | unknown

function handle(channel: string, fn: Handler): void {
  ipcRenderer.on(channel, async (_e: IpcRendererEvent, id: number, payload: unknown) => {
    let result: unknown
    try {
      result = await fn(payload)
    } catch (err) {
      result = { started: [], errors: [String((err as Error).message ?? err)] }
    }
    ipcRenderer.send(`${channel}:reply:${id}`, result)
  })
}

const bridge: AudioBridgeApi = {
  onStart: (fn) => handle('audio:start', fn as Handler),
  onStop: (fn) => handle('audio:stop', fn as Handler),
  onListDevices: (fn) => handle('audio:devices', fn as Handler),
  onCameraDevices: (fn) => handle('camera:devices', fn as Handler),
  onCameraOpen: (fn) => handle('camera:open', fn as Handler),
  onCameraStart: (fn) => handle('camera:start', fn as Handler),
  onCameraPause: (fn) => handle('camera:pause', fn as Handler),
  onCameraResume: (fn) => handle('camera:resume', fn as Handler),
  onCameraStop: (fn) => handle('camera:stop', fn as Handler),
  cameraChunk: (chunk) => ipcRenderer.send('camera:chunk', chunk),
  pcm: (source, chunk) => ipcRenderer.send('audio:pcm', source, chunk),
  levels: (levels) => ipcRenderer.send('audio:levels', levels)
}

contextBridge.exposeInMainWorld('audioBridge', bridge)
