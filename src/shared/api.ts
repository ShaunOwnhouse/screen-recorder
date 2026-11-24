import type { UpdateStatus } from './updates.ts'
import type {
  AudioLevels, Capabilities, EditorSource, MicInfo, RecordingStatus, Rect, SaveRequest, Settings, ShotCopyRequest,
  ShotSaveRequest, ShotSource
} from './types.ts'

export interface Api {
  getCapabilities(refresh?: boolean): Promise<Capabilities>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  chooseOutputDir(): Promise<Settings>
  /** Opens the folder picker for screenshots; resolves with the chosen folder, or null if cancelled. */
  chooseShotDir(): Promise<string | null>
  openShotDir(): Promise<void>
  toggleRecording(): Promise<void>
  /** Pauses a recording, or picks it up again from the same point if it is paused. */
  togglePause(): Promise<void>
  /** Starts a screenshot (or cancels one that is waiting for you to pick an area). */
  takeScreenshot(): Promise<void>
  getStatus(): Promise<RecordingStatus>
  openOutputDir(): Promise<void>
  openLogs(): Promise<void>
  showLastRecording(): Promise<void>
  playLastRecording(): Promise<void>
  showLastShot(): Promise<void>
  openLastShot(): Promise<void>
  openReview(): Promise<void>
  testAudio(on: boolean): Promise<string[]>
  fitHeight(height: number): Promise<void>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  /** Downloads a found update (when automatic downloading is off) or, on a build that can't self-update, opens the download page. */
  downloadUpdate(): Promise<void>
  /** Restarts to finish an update that has been downloaded. ok=false with a reason when it isn't a good moment (recording, screenshot being edited). */
  installUpdate(): Promise<{ ok: boolean; reason?: string }>
  onUpdate(cb: (status: UpdateStatus) => void): () => void
  onStatus(cb: (status: RecordingStatus) => void): () => void
  onLevels(cb: (levels: AudioLevels) => void): () => void
  onCapsChanged(cb: () => void): () => void
}

export type EditorLoad = { source: EditorSource } | { error: string }

export interface EditorApi {
  load(): Promise<EditorLoad>
  reveal(): Promise<void>
  makeProxy(): Promise<string>
  save(req: SaveRequest): Promise<{ ok: boolean; path?: string; error?: string }>
  cancelExport(): Promise<void>
  discard(): Promise<boolean>
  onProgress(cb: (fraction: number) => void): () => void
}

export type ShotLoad = { source: ShotSource } | { error: string }

export interface ShotApi {
  load(): Promise<ShotLoad>
  /** The captured picture as PNG bytes. */
  bytes(): Promise<Uint8Array>
  save(req: ShotSaveRequest): Promise<{ ok: boolean; path?: string; error?: string }>
  copy(req: ShotCopyRequest): Promise<boolean>
  discard(edited: boolean): Promise<boolean>
  setDirty(dirty: boolean): void
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
