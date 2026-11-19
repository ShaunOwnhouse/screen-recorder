import type {
  AudioLevels, Capabilities, EditorSource, MicInfo, RecordingStatus, Rect, SaveRequest, Settings
} from './types.ts'

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
  openReview(): Promise<void>
  testAudio(on: boolean): Promise<string[]>
  fitHeight(height: number): Promise<void>
  onStatus(cb: (status: RecordingStatus) => void): () => void
  onLevels(cb: (levels: AudioLevels) => void): () => void
  onCapsChanged(cb: () => void): () => void
}

export interface EditorApi {
  load(): Promise<EditorSource | null>
  makeProxy(): Promise<string>
  save(req: SaveRequest): Promise<{ ok: boolean; path?: string; error?: string }>
  cancelExport(): Promise<void>
  discard(): Promise<boolean>
  onProgress(cb: (fraction: number) => void): () => void
}

/** What the user picked on one screen's overlay: an area (region mode), the whole screen, or nothing. */
export type OverlayResult = { rect: Rect } | { screen: true } | null

export interface OverlayApi {
  done(result: OverlayResult): void
}

export interface AudioConfigPayload {
  system: boolean
  systemVolume: number
  mic: string | null
  micVolume: number
  noiseSuppression: boolean
}

export interface AudioBridgeApi {
  onStart(fn: (cfg: AudioConfigPayload) => Promise<{ started: string[]; errors: string[] }>): void
  onStop(fn: () => Promise<void>): void
  onListDevices(fn: (opts?: { prime?: boolean }) => Promise<MicInfo[]>): void
  pcm(chunk: Float32Array): void
  levels(levels: AudioLevels): void
}
