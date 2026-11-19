import type { Segment } from './types.ts'

const EPS = 1e-6
const MIN_LEN = 0.05

function clean(segs: Segment[]): Segment[] {
  return segs.filter(([a, b]) => b - a >= MIN_LEN).sort((x, y) => x[0] - y[0])
}

/** Removes [a, b] from the kept segments. */
export function removeRange(keep: Segment[], a: number, b: number): Segment[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  const out: Segment[] = []
  for (const [s, e] of keep) {
    if (e <= lo + EPS || s >= hi - EPS) out.push([s, e])
    else {
      if (s < lo) out.push([s, lo])
      if (e > hi) out.push([hi, e])
    }
  }
  return clean(out)
}

/** Keeps only the parts of the kept segments that fall inside [a, b]. */
export function keepOnly(keep: Segment[], a: number, b: number): Segment[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return clean(keep.map(([s, e]): Segment => [Math.max(s, lo), Math.min(e, hi)]))
}

export function totalDuration(keep: Segment[]): number {
  return keep.reduce((sum, [s, e]) => sum + (e - s), 0)
}

/** Where playback should be at time t: t itself if kept, else the next kept start, else null (end). */
export function playablePosition(keep: Segment[], t: number): number | null {
  for (const [s, e] of keep) {
    if (t < s - EPS) return s
    if (t <= e - EPS) return t
  }
  return null
}

export function isFullRange(keep: Segment[], duration: number): boolean {
  return keep.length === 1 && keep[0][0] <= 0.01 && keep[0][1] >= duration - 0.01
}
