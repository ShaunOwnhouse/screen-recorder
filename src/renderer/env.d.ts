import type { Api, AudioBridgeApi, EditorApi, OverlayApi, ShotApi } from '../shared/api.ts'

declare global {
  interface Window {
    api: Api
    editor: EditorApi
    shot: ShotApi
    overlay: OverlayApi
    audioBridge: AudioBridgeApi
  }
}
