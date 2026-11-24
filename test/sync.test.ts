import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestLag, envelope } from '../src/shared/sync.ts'

/** Speech-like bursts: a few seconds of sound, gaps, repeated with a fixed random pattern. */
function speech(seconds: number, rate: number, seed = 7): Float32Array {
  let x = seed
  const rnd = (): number => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const out = new Float32Array(Math.floor(seconds * rate))
  let t = 0
  while (t < out.length) {
    const talk = Math.floor((0.2 + rnd() * 0.9) * rate)
    const gap = Math.floor((0.15 + rnd() * 0.6) * rate)
    const level = 0.1 + rnd() * 0.5
    for (let i = 0; i < talk && t + i < out.length; i++) out[t + i] = level * (rnd() * 2 - 1)
    t += talk + gap
  }
  return out
}

test('the envelope follows how loud each moment is', () => {
  const s = new Float32Array(1000)
  s.fill(0.5, 0, 500)
  const e = envelope(s, 100)
  assert.equal(e.length, 10)
  assert.ok(e[0] > 0.45 && e[9] === 0)
})

test('a camera that started 0.37 s after the screen is found to within 20 ms', () => {
  const rate = 8000
  const screen = speech(30, rate)
  const shiftSamples = Math.round(0.37 * rate)
  // the camera heard the same thing, but its recording began 0.37 s later, so its sound is the screen's sound moved earlier
  const camera = new Float32Array(screen.length - shiftSamples)
  for (let i = 0; i < camera.length; i++) camera[i] = screen[i + shiftSamples] * 0.8 + (Math.random() - 0.5) * 0.02
  const step = 80 // 10 ms
  const m = bestLag(envelope(screen, step), envelope(camera, step), 250)!
  // camera[i] = screen[i + shift]  →  b[i + lag] ≈ a[i] with lag = −shift
  assert.ok(Math.abs(m.lag * 0.01 - -0.37) <= 0.02, `${m.lag * 0.01}`)
  assert.ok(m.strength > 0.15 && m.score > 0.8, JSON.stringify(m))
})

test('a camera that started earlier gives a positive lag, and silence gives no answer', () => {
  const rate = 8000
  const screen = speech(20, rate, 3)
  const lead = Math.round(1.2 * rate)
  const camera = new Float32Array(screen.length + lead)
  for (let i = 0; i < screen.length; i++) camera[i + lead] = screen[i]
  const m = bestLag(envelope(screen, 80), envelope(camera, 80), 300)!
  assert.ok(Math.abs(m.lag * 0.01 - 1.2) <= 0.02)
  assert.equal(bestLag(envelope(new Float32Array(8000 * 5), 80), envelope(screen, 80), 100), null)
})

test('unrelated sound is recognised as a weak match', () => {
  const a = envelope(speech(20, 8000, 1), 80)
  const b = envelope(speech(20, 8000, 99), 80)
  const m = bestLag(a, b, 200)!
  assert.ok(m.score < 0.6 || m.strength < 0.1, JSON.stringify(m))
})
