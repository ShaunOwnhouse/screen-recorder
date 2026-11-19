import type { Api, AudioBridgeApi, EditorApi, OverlayApi } from '../shared/api.ts'

declare global {
  interface Window {
    api: Api
    editor: EditorApi
    overlay: OverlayApi
    audioBridge: AudioBridgeApi
  }
}
