export type Quality = 'high' | 'veryhigh' | 'maximum' | 'lossless'
export type CaptureMode = 'fullscreen' | 'region'
export type Backend = 'auto' | 'ddagrab' | 'gdigrab'

export interface Settings {
  mode: CaptureMode
  /** Seconds of 3-2-1 countdown before recording starts; 0 = start immediately. */
  countdown: number
  /** null keeps the captured (native) resolution — no scaling at all. */
  outputHeight: number | null
  fps: 30 | 60
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
  yuv444: boolean
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
}

export type RecordingState = 'idle' | 'selecting' | 'countdown' | 'recording' | 'saving'

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
}

export interface SaveRequest {
  segments: Segment[]
  /** Normalised 0..1 crop of the frame, or null for the full frame. */
  crop: Rect | null
  fileName: string
  saveAs: boolean
}
