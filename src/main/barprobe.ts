import type { RecordArgsInput } from './args.ts'

/** The bar's background colour (see bar.html); everything that differs from it is "structure". */
const BG = [24, 27, 33]

export interface ProbeResult {
  /** True when the bar's own pixels show up in the screen capture. */
  visible: boolean
  /** How many of the bar's distinctive pixels (text, dot, border) were compared. */
  compared: number
  /** Fraction of those that matched the capture. */
  matched: number
}

/**
 * Compares what the bar renders (BGRA, from capturePage) with what a screen capture of the same
 * screen area contains (RGB24). If the bar is hidden from capture, the capture shows the desktop and
 * the distinctive pixels won't match; if it leaks, they match almost exactly.
 */
export function compareBar(bar: Uint8Array, width: number, height: number, grab: Uint8Array): ProbeResult {
  if (bar.length < width * height * 4 || grab.length < width * height * 3) return { visible: true, compared: 0, matched: 0 }
  let compared = 0
  let same = 0
  for (let p = 0; p < width * height; p++) {
    const b = bar[p * 4]
    const g = bar[p * 4 + 1]
    const r = bar[p * 4 + 2]
    if (Math.abs(r - BG[0]) <= 20 && Math.abs(g - BG[1]) <= 20 && Math.abs(b - BG[2]) <= 20) continue
    compared++
    if (Math.abs(r - grab[p * 3]) <= 14 && Math.abs(g - grab[p * 3 + 1]) <= 14 && Math.abs(b - grab[p * 3 + 2]) <= 14) same++
  }
  // Too little to judge: assume it leaks, because hiding the bar unnecessarily is harmless.
  if (compared < 40) return { visible: true, compared, matched: 0 }
  const matched = same / compared
  return { visible: matched >= 0.8, compared, matched }
}

/** FFmpeg arguments that grab ONE frame of a screen area (raw RGB24 on stdout), the way recording captures it. */
export function buildGrabArgs(o: Pick<RecordArgsInput, 'backend' | 'dda' | 'avf' | 'x11Display' | 'rect'>): string[] {
  const { x, y, width: w, height: h } = o.rect
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  const tail = ['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
  switch (o.backend) {
    case 'ddagrab':
      if (!o.dda) throw new Error('ddagrab needs an adapter/output target')
      return [
        ...head, '-init_hw_device', `d3d11va=dda:${o.dda.adapter}`, '-filter_hw_device', 'dda',
        '-filter_complex', `ddagrab=output_idx=${o.dda.output}:framerate=10:draw_mouse=0:offset_x=${x}:offset_y=${y}:video_size=${w}x${h},hwdownload,format=bgra,format=rgb24[v]`,
        '-map', '[v]', ...tail
      ]
    case 'avfoundation':
      if (!o.avf) throw new Error('avfoundation needs a screen device')
      return [
        ...head, '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '10',
        ...(o.avf.pixelFormat ? ['-pixel_format', o.avf.pixelFormat] : []), '-i', `${o.avf.device}:none`,
        '-vf', `crop=${w}:${h}:${x}:${y}`, ...tail
      ]
    case 'x11grab':
      return [
        ...head, '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '10', '-video_size', `${w}x${h}`,
        '-i', `${o.x11Display ?? ':0'}+${x},${y}`, ...tail
      ]
    default:
      return [
        ...head, '-f', 'gdigrab', '-draw_mouse', '0', '-framerate', '10', '-offset_x', String(x), '-offset_y', String(y),
        '-video_size', `${w}x${h}`, '-i', 'desktop', ...tail
      ]
  }
}

/**
 * FFmpeg arguments that grab ONE frame of a screen area as a lossless PNG on stdout (screenshots). Same capture
 * methods as recording, so a screenshot has exactly the pixels a recording would.
 */
export function buildShotArgs(o: Pick<RecordArgsInput, 'backend' | 'dda' | 'avf' | 'x11Display' | 'rect'>, cursor: boolean): string[] {
  const { x, y, width: w, height: h } = o.rect
  const mouse = cursor ? '1' : '0'
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  const tail = ['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-pix_fmt', 'rgb24', '-']
  switch (o.backend) {
    case 'ddagrab':
      if (!o.dda) throw new Error('ddagrab needs an adapter/output target')
      return [
        ...head, '-init_hw_device', `d3d11va=dda:${o.dda.adapter}`, '-filter_hw_device', 'dda',
        '-filter_complex', `ddagrab=output_idx=${o.dda.output}:framerate=10:draw_mouse=${mouse}:offset_x=${x}:offset_y=${y}:video_size=${w}x${h},hwdownload,format=bgra,format=rgb24[v]`,
        '-map', '[v]', ...tail
      ]
    case 'avfoundation':
      if (!o.avf) throw new Error('avfoundation needs a screen device')
      return [
        ...head, '-f', 'avfoundation', '-capture_cursor', mouse, '-framerate', '10',
        ...(o.avf.pixelFormat ? ['-pixel_format', o.avf.pixelFormat] : []), '-i', `${o.avf.device}:none`,
        // The device can hand over a blank first frame; take the second.
        '-vf', `crop=${w}:${h}:${x}:${y},select=gte(n\\,1)`, '-fps_mode', 'vfr', ...tail
      ]
    case 'x11grab':
      return [
        ...head, '-f', 'x11grab', '-draw_mouse', mouse, '-framerate', '10', '-video_size', `${w}x${h}`,
        '-i', `${o.x11Display ?? ':0'}+${x},${y}`, ...tail
      ]
    default:
      return [
        ...head, '-f', 'gdigrab', '-draw_mouse', mouse, '-framerate', '10', '-offset_x', String(x), '-offset_y', String(y),
        '-video_size', `${w}x${h}`, '-i', 'desktop', ...tail
      ]
  }
}
