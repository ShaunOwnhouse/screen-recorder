export type Quality = 'high' | 'veryhigh' | 'maximum' | 'studio' | 'lossless'
export type CaptureMode = 'fullscreen' | 'region'
export type Backend = 'auto' | 'ddagrab' | 'gdigrab'
/** What a recording can be saved as. 'mp4' (H.264) is the default and the format that plays everywhere. */
export type VideoFormat = 'mp4' | 'hevc' | 'mkv' | 'mov' | 'webm' | 'gif'
/** What a screenshot can be saved as. 'png' is lossless and the default. */
export type ImageFormat = 'png' | 'webp' | 'jpeg'

export interface Settings {
  mode: CaptureMode
  /** Seconds of 3-2-1 countdown before recording starts; 0 = start immediately. */
  countdown: number
  /** null keeps the captured (native) resolution — no scaling at all. */
  outputHeight: number | null
  fps: 30 | 60 | 120
  quality: Quality
  encoder: string
  showCursor: boolean
  backend: Backend
  outputDir: string
  systemAudio: boolean
  systemVolume: number
  micEnabled: boolean
  /** A microphone deviceId, or 'default' for the Windows default microphone. */
  micDevice: string
  micLabel: string | null
  micVolume: number
  noiseSuppression: boolean
  /** Default format offered when saving a recording. */
  videoFormat: VideoFormat
  /** Screenshots: whole screen or a dragged area. */
  shotMode: CaptureMode
  /** Seconds to wait before a screenshot is taken (0 = none). */
  shotDelay: number
  shotFormat: ImageFormat
  shotDir: string
  /** Also copy the image to the clipboard as soon as it's captured. */
  shotClipboard: boolean
  shotCursor: boolean
  /** Global shortcuts (Electron accelerators); '' turns one off. */
  hotkeyRecord: string
  hotkeyShot: string
}

export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  scaleFactor: number
  primary: boolean
}

export interface EncoderInfo {
  id: string
  label: string
  /** Supports the Studio (4:4:4) tier. */
  yuv444: boolean
  /** Accepts the extra top-tier tuning (multipass, temporal AQ…). */
  tuned: boolean
}

export interface MicInfo {
  id: string
  label: string
}

export interface Capabilities {
  platformSupported: boolean
  ffmpegVersion: string
  ddagrab: boolean
  displays: DisplayInfo[]
  encoders: EncoderInfo[]
  microphones: MicInfo[]
  hotkey: string | null
  shotHotkey: string | null
  /** Formats this computer's FFmpeg can actually write. */
  videoFormats: VideoFormat[]
  imageFormats: ImageFormat[]
}

/** 'snapping' = a screenshot is being taken (waiting, choosing the area, or capturing). */
export type RecordingState = 'idle' | 'selecting' | 'countdown' | 'recording' | 'saving' | 'snapping'

export interface RecordingStatus {
  state: RecordingState
  /** Seconds left while state is 'countdown'. */
  countdown?: number
  elapsed: number
  bytes: number
  droppedFrames: number
  speed: number | null
  encoder?: string
  backend?: string
  resolution?: string
  audio?: string
  /** Basename of a finished recording waiting for the user to save or discard it. */
  pending: string | null
  lastFile?: string
  lastShot?: string
  error?: string
  warning?: string
}

export interface AudioLevels {
  system: number | null
  mic: number | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Segment = [number, number]

export interface RecordingMeta {
  width: number
  height: number
  fps: number
  duration: number
  yuv444: boolean
  hasAudio: boolean
}

export interface EditorSource {
  name: string
  url: string
  meta: RecordingMeta
  sizeBytes: number
  defaultName: string
  outputDir: string
  /** Formats this computer can write, and the one chosen as default in Settings. */
  formats: VideoFormat[]
  format: VideoFormat
}

export interface SaveRequest {
  segments: Segment[]
  /** Normalised 0..1 crop of the frame, or null for the full frame. */
  crop: Rect | null
  fileName: string
  saveAs: boolean
  /** For 4:4:4 recordings: convert to 4:2:0 so Windows' player, phones and the web can play it. */
  compatible: boolean
  format: VideoFormat
}

export interface ShotSource {
  width: number
  height: number
  defaultName: string
  outputDir: string
  format: ImageFormat
  formats: ImageFormat[]
}

export interface ShotSaveRequest {
  /** The edited (cropped / annotated) image as PNG bytes, or null to use the capture untouched. */
  png: Uint8Array | null
  fileName: string
  saveAs: boolean
  format: ImageFormat
}

export interface ShotCopyRequest {
  png: Uint8Array | null
}
