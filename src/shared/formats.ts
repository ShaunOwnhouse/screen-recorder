import type { ImageFormat, VideoFormat } from './types.ts'

export type NoticeLevel = 'info' | 'warn' | 'bad'

export interface Notice {
  level: NoticeLevel
  title: string
  text: string
}

export interface FormatInfo<Id extends string> {
  id: Id
  /** Text in the format picker. */
  label: string
  /** File extension (no dot). */
  ext: string
  /** Shown in the format list under the label. */
  blurb: string
  /** Shown when this format is picked. null for the recommended default. */
  notice: Notice | null
}

export const DEFAULT_VIDEO_FORMAT: VideoFormat = 'mp4'
export const DEFAULT_IMAGE_FORMAT: ImageFormat = 'png'

export const VIDEO_FORMATS: FormatInfo<VideoFormat>[] = [
  {
    id: 'mp4',
    label: 'MP4 · H.264 — plays everywhere (recommended)',
    ext: 'mp4',
    blurb: 'Windows Media Player, phones, WhatsApp and browsers. Saved exactly as recorded — no re-encode, no quality loss.',
    notice: null
  },
  {
    id: 'hevc',
    label: 'MP4 · H.265 (HEVC) — smaller files',
    ext: 'mp4',
    blurb: 'Files roughly a third to half smaller. Windows Media Player needs an add-on; older phones and browsers can’t play it.',
    notice: {
      level: 'warn',
      title: 'Converting makes a new copy.',
      text: 'It takes longer, can lower quality slightly, and some players and phones won’t open H.265 (Windows Media Player needs a free or paid add-on). If you’re not sure, keep MP4 · H.264.'
    }
  },
  {
    id: 'mkv',
    label: 'MKV · H.264 — for VLC & editors',
    ext: 'mkv',
    blurb: 'Same video in a different wrapper. VLC and editors open it; Windows Media Player and most phones don’t.',
    notice: {
      level: 'warn',
      title: 'Heads-up: MKV may not open everywhere.',
      text: 'Windows Media Player and most phones can’t play MKV files. If you haven’t edited the recording, it isn’t re-encoded, so quality stays exactly the same — only the file type changes. If you’re not sure, keep MP4.'
    }
  },
  {
    id: 'mov',
    label: 'MOV · H.264 — for Apple & editors',
    ext: 'mov',
    blurb: 'Same video in an Apple/editor-friendly wrapper. Fine on Mac and iPhone; Windows Media Player may not open it.',
    notice: {
      level: 'warn',
      title: 'Heads-up: MOV may not open everywhere.',
      text: 'It works on Macs, iPhones and video editors, but Windows Media Player and some Android phones may not play it. If you haven’t edited the recording, it isn’t re-encoded, so quality stays exactly the same. If you’re not sure, keep MP4.'
    }
  },
  {
    id: 'webm',
    label: 'WebM · VP9 — for websites',
    ext: 'webm',
    blurb: 'For websites. Windows Media Player and iPhone Photos don’t open it. Converted, so it takes longer.',
    notice: {
      level: 'warn',
      title: 'Converting makes a new copy.',
      text: 'WebM is meant for websites. It takes noticeably longer to save, can lower quality slightly, and Windows Media Player and iPhones usually can’t open it. If you’re not sure, keep MP4.'
    }
  },
  {
    id: 'gif',
    label: 'GIF — short silent loop (big quality drop)',
    ext: 'gif',
    blurb: 'Short silent loops only: 256 colours, 15 frames a second, no sound, and large files.',
    notice: {
      level: 'bad',
      title: 'GIF loses a lot.',
      text: 'No sound, only 256 colours, 15 frames a second, a smaller picture (up to 1280 px wide) and big files. Use it only for short clips you’ll share as a looping picture.'
    }
  }
]

export const IMAGE_FORMATS: FormatInfo<ImageFormat>[] = [
  {
    id: 'png',
    label: 'PNG — lossless, exact pixels (recommended)',
    ext: 'png',
    blurb: 'Keeps every pixel exactly as it was on your screen. Opens everywhere.',
    notice: null
  },
  {
    id: 'webp',
    label: 'WebP — lossless, smaller than PNG',
    ext: 'webp',
    blurb: 'Also keeps every pixel, in a smaller file. Some older apps and websites can’t open WebP.',
    notice: {
      level: 'warn',
      title: 'Heads-up: WebP may not open everywhere.',
      text: 'It keeps every pixel exactly, with smaller files than PNG, but some older apps, chat tools and websites can’t open WebP. If you’re not sure, keep PNG.'
    }
  },
  {
    id: 'jpeg',
    label: 'JPEG — smaller, slightly lossy',
    ext: 'jpg',
    blurb: 'Smaller files, but throws away some detail. Saved at maximum quality.',
    notice: {
      level: 'warn',
      title: 'JPEG is lossy.',
      text: 'It throws away some detail — text and sharp edges can look slightly fuzzy — even at the maximum quality this app uses. If you’re not sure, keep PNG.'
    }
  }
]

export const videoFormat = (id: VideoFormat): FormatInfo<VideoFormat> => VIDEO_FORMATS.find((f) => f.id === id) ?? VIDEO_FORMATS[0]
export const imageFormat = (id: ImageFormat): FormatInfo<ImageFormat> => IMAGE_FORMATS.find((f) => f.id === id) ?? IMAGE_FORMATS[0]

/** The notice for a recording format: nothing for the default. */
export const videoNotice = (id: VideoFormat): Notice | null => videoFormat(id).notice
export const imageNotice = (id: ImageFormat): Notice | null => imageFormat(id).notice
