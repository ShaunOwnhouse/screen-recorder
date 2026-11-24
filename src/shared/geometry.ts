import type { Rect } from './types.ts'

/** yuv420p needs even dimensions. */
export function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/** Converts a normalised crop into even, in-bounds source pixels (null if it covers the whole frame). */
export function cropToPixels(crop: Rect | null, width: number, height: number): Rect | null {
  if (!crop) return null
  const evenOffset = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)
  const x = evenOffset(Math.round(crop.x * width))
  const y = evenOffset(Math.round(crop.y * height))
  const w = Math.min(even(Math.round(crop.width * width)), even(width - x))
  const h = Math.min(even(Math.round(crop.height * height)), even(height - y))
  if (w >= even(width) && h >= even(height)) return null
  return { x, y, width: w, height: h }
}

/** The size of the finished video: the recording (cropped, if asked), made even. */
export function outputSize(width: number, height: number, crop: Rect | null): { width: number; height: number } {
  const c = cropToPixels(crop, width, height)
  return c ? { width: c.width, height: c.height } : { width: even(width), height: even(height) }
}
