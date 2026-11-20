import type { ImageFormat, VideoFormat } from '../shared/types.ts'

/** Software encoders the extra save formats need. */
export interface FfmpegCodecs {
  x265: boolean
  vp9: boolean
  opus: boolean
  webp: boolean
}

/** Which save formats this FFmpeg build can write. MP4 (H.264), MKV, MOV, PNG and JPEG need nothing special. */
export function availableFormats(codecs: FfmpegCodecs): { video: VideoFormat[]; image: ImageFormat[] } {
  const video: VideoFormat[] = ['mp4']
  if (codecs.x265) video.push('hevc')
  video.push('mkv', 'mov')
  if (codecs.vp9 && codecs.opus) video.push('webm')
  video.push('gif')
  return { video, image: codecs.webp ? ['png', 'webp', 'jpeg'] : ['png', 'jpeg'] }
}
