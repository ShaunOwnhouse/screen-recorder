import type { Api, OverlayApi } from '../shared/api.ts'

declare global {
  interface Window {
    api: Api
    overlay: OverlayApi
  }
}
