import type { Rect } from '../shared/types.ts'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from a PNG's header, or null if the bytes aren't a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24 || PNG_SIGNATURE.some((b, i) => buf[i] !== b)) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * Which pixels of a captured screen picture to keep for a selection. `rect` and `bounds` are in DIPs (screen coordinates);
 * the picture is in real pixels, so each axis is scaled by the picture's own pixels-per-DIP (more reliable than the nominal
 * scale factor on odd-scaled screens). null = the whole picture (no crop needed).
 */
export function cropBox(picture: { width: number; height: number }, bounds: Rect, rect: Rect): Rect | null {
  if (rect.width >= bounds.width - 1 && rect.height >= bounds.height - 1) return null
  const fx = picture.width / bounds.width
  const fy = picture.height / bounds.height
  const x = Math.max(0, Math.round((rect.x - bounds.x) * fx))
  const y = Math.max(0, Math.round((rect.y - bounds.y) * fy))
  const width = Math.min(picture.width - x, Math.round(rect.width * fx))
  const height = Math.min(picture.height - y, Math.round(rect.height * fy))
  if (width < 1 || height < 1) throw new Error('The selected area was empty.')
  return { x, y, width, height }
}
