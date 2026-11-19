export type Quality = 'high' | 'veryhigh' | 'lossless'
export type CaptureMode = 'fullscreen' | 'region'
export type Backend = 'auto' | 'ddagrab' | 'gdigrab'

export interface Settings {
  displayId: number | null
  mode: CaptureMode
  /** null keeps the captured (native) resolution — no scaling at all. */
  outputHeight: number | null
  fps: 30 | 60
  quality: Quality
  encoder: string
  audioDevice: string | null
  showCursor: boolean
  backend: Backend
  outputDir: string
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
}

export interface Capabilities {
  platformSupported: boolean
  ffmpegVersion: string
  ddagrab: boolean
  displays: DisplayInfo[]
  encoders: EncoderInfo[]
  audioDevices: string[]
  hotkey: string | null
}

export type RecordingState = 'idle' | 'selecting' | 'recording' | 'saving'

export interface RecordingStatus {
  state: RecordingState
  elapsed: number
  bytes: number
  droppedFrames: number
  speed: number | null
  encoder?: string
  backend?: string
  resolution?: string
  lastFile?: string
  error?: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
