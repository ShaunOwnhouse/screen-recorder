/**
 * Lining the camera up with the screen recording by listening: both were recorded with the same microphone, so the
 * loudness of one, shifted by the right amount, matches the loudness of the other.
 */

/** How loud the signal is over time: the average size of the samples in each block. */
export function envelope(samples: Float32Array, block: number): Float32Array {
  const n = Math.floor(samples.length / block)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * block; j < (i + 1) * block; j++) sum += Math.abs(samples[j])
    out[i] = sum / block
  }
  return out
}

export interface Match {
  /** b[i + lag] lines up with a[i]. */
  lag: number
  /** −1 … 1: how well they match at that lag. */
  score: number
  /** How far the best match stands above the best match anywhere else (0 = no better than elsewhere). */
  strength: number
}

/** Finds the shift (in steps, within ±maxLag of `around`) at which b best matches a. Null if either has no real sound. */
export function bestLag(a: Float32Array, b: Float32Array, maxLag: number, around = 0): Match | null {
  const energy = (x: Float32Array): number => x.reduce((s, v) => s + v * v, 0)
  if (a.length < 20 || b.length < 20 || energy(a) < 1e-9 || energy(b) < 1e-9) return null
  const scores: Array<{ lag: number; score: number }> = []
  let best = { lag: around, score: -2 }
  for (let lag = around - maxLag; lag <= around + maxLag; lag++) {
    // the stretch where both exist
    const from = Math.max(0, -lag)
    const to = Math.min(a.length, b.length - lag)
    const n = to - from
    if (n < 20) continue
    let ma = 0
    let mb = 0
    for (let i = from; i < to; i++) {
      ma += a[i]
      mb += b[i + lag]
    }
    ma /= n
    mb /= n
    let ab = 0
    let aa = 0
    let bb = 0
    for (let i = from; i < to; i++) {
      const x = a[i] - ma
      const y = b[i + lag] - mb
      ab += x * y
      aa += x * x
      bb += y * y
    }
    const score = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
    scores.push({ lag, score })
    if (score > best.score) best = { lag, score }
  }
  if (!scores.length) return null
  // a real match is a sharp peak: compare it with the best score that is not just its own neighbours
  const away = scores.filter((x) => Math.abs(x.lag - best.lag) > 6).reduce((m, x) => Math.max(m, x.score), -1)
  return { lag: best.lag, score: best.score, strength: best.score - away }
}
