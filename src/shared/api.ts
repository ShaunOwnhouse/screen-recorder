import type { Capabilities, RecordingStatus, Rect, Settings } from './types.ts'

export interface Api {
  getCapabilities(refresh?: boolean): Promise<Capabilities>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  chooseOutputDir(): Promise<Settings>
  toggleRecording(): Promise<void>
  getStatus(): Promise<RecordingStatus>
  openOutputDir(): Promise<void>
  showLastRecording(): Promise<void>
  playLastRecording(): Promise<void>
  onStatus(cb: (status: RecordingStatus) => void): () => void
}

export interface OverlayApi {
  done(rect: Rect | null): void
}
