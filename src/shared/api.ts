import type { UpdateStatus } from './updates.ts'
import type {
  AudioLevels, Brand, BrandFont, CameraInfo, Capabilities, EditorSource, MediaInfo, MicInfo, PreviewRequest, RecordingStatus, Rect, SaveRequest, Settings, ShotCopyRequest,
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
  /** The cameras on this computer (opens the camera for a moment so they can be named). */
  listCameras(): Promise<CameraInfo[]>
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

export interface AssetSave {
  /** 'recording', 'camera' or the id of an added file. */
  media: string
  from: number
  to: number
  what: 'video' | 'audio'
  name: string
}

export type EditorLoad = { source: EditorSource } | { error: string }

export interface EditorApi {
  load(): Promise<EditorLoad>
  reveal(): Promise<void>
  makeProxy(): Promise<string>
  /** Opens the file picker: videos and pictures ('clip'), audio files ('music'), or everything at once ('any'). Many files can be chosen. */
  pickMedia(kind: 'clip' | 'music' | 'any'): Promise<MediaInfo[]>
  /** Adds files that were dropped onto the window. */
  addMedia(paths: string[], kind: 'clip' | 'music' | 'any'): Promise<MediaInfo[]>
  /** Saves one piece (a stretch of a file: its picture alone or its sound alone) as a file of its own. */
  saveAsset(spec: AssetSave): Promise<{ path?: string; error?: string }>
  /** The real location of a dropped file. */
  pathFor(file: File): string
  /** Loudness along an audio (or video) file, 0–1 per bucket, for drawing a waveform. */
  waveform(id: string, buckets: number): Promise<number[]>
  /** A row of small pictures across a video, as a data URL ('' if it has none). */
  strip(id: string, count: number): Promise<string>
  saveBrand(brand: Brand): Promise<Brand>
  pickFont(): Promise<BrandFont | null>
  fontData(file: string): Promise<Uint8Array>
  save(req: SaveRequest): Promise<{ ok: boolean; path?: string; error?: string }>
  cancelExport(): Promise<void>
  discard(): Promise<boolean>
  /** Makes a small, quick version of the finished video (speed, music, everything) so it can be watched before saving. */
  previewFinal(req: PreviewRequest): Promise<{ ok: boolean; url?: string; duration?: number; error?: string }>
  /** Done with this recording: the videos saved from it stay, the recording itself is removed. */
  finish(): Promise<boolean>
  /** Shows a video saved from this recording in its folder. */
  revealPath(path: string): Promise<void>
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

export interface CameraOpenPayload {
  /** 'default' for the system's first camera. */
  device: string
  /** Also record this microphone with the camera (used to line the camera up with the screen), or null. */
  mic: string | null
}

export interface CameraOpenResult {
  ok: boolean
  error?: string
  width?: number
  height?: number
  hasAudio?: boolean
}

export interface AudioBridgeApi {
  onCameraDevices(fn: () => Promise<CameraInfo[]>): void
  onCameraOpen(fn: (p: CameraOpenPayload) => Promise<CameraOpenResult>): void
  onCameraStart(fn: () => Promise<{ startedAt: number }>): void
  onCameraPause(fn: () => Promise<void>): void
  onCameraResume(fn: () => Promise<void>): void
  onCameraStop(fn: () => Promise<void>): void
  cameraChunk(chunk: Uint8Array): void
  onStart(fn: (cfg: AudioConfigPayload) => Promise<{ started: string[]; errors: string[] }>): void
  onStop(fn: () => Promise<void>): void
  onListDevices(fn: (opts?: { prime?: boolean }) => Promise<MicInfo[]>): void
  pcm(source: 'system' | 'mic', chunk: Float32Array): void
  levels(levels: AudioLevels): void
}
