// Generates the app and tray PNG icons without external dependencies: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Renders pixel(u, v) to a PNG; u and v are in units of the image height (u runs to width/height). */
function png(width, pixelOrHeight, maybePixel) {
  const height = typeof pixelOrHeight === 'number' ? pixelOrHeight : width
  const pixel = typeof pixelOrHeight === 'function' ? pixelOrHeight : maybePixel
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      // 4x4 supersampling for smooth edges
      let acc = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const p = pixel((x + (sx + 0.5) / 4) / height, (y + (sy + 0.5) / 4) / height)
          acc = acc.map((v, i) => v + (i === 3 ? p[3] : p[i] * p[3]))
        }
      const a = acc[3] / 16
      const o = y * (width * 4 + 1) + 1 + x * 4
      raw[o] = a ? Math.round(acc[0] / acc[3]) : 0
      raw[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0
      raw[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0
      raw[o + 3] = Math.round(a * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const RED = [239, 68, 68, 1]
const DARK = [24, 27, 33, 1]
const LIGHT = [232, 234, 238, 1]
const NONE = [0, 0, 0, 0]
const dist = (u, v) => Math.hypot(u - 0.5, v - 0.5)

function roundedSquare(u, v, r) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0)
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0)
  return Math.hypot(dx, dy) <= r
}

// The Screen Snap mark: four snip-frame corners around a record dot.
function segDist(u, v, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(u - (ax + t * dx), v - (ay + t * dy))
}
const cornerSegments = (m, l) => [
  [[m, m + l], [m, m]], [[m, m], [m + l, m]],
  [[1 - m - l, m], [1 - m, m]], [[1 - m, m], [1 - m, m + l]],
  [[m, 1 - m - l], [m, 1 - m]], [[m, 1 - m], [m + l, 1 - m]],
  [[1 - m - l, 1 - m], [1 - m, 1 - m]], [[1 - m, 1 - m], [1 - m, 1 - m - l]]
]
/** True where the mark is drawn: the record dot, or a snip-frame corner. */
function snip(u, v, { m = 0.2, l = 0.2, t = 0.075, dot = 0.13 } = {}) {
  if (dist(u, v) < dot) return true
  return cornerSegments(m, l).some(([a, b]) => segDist(u, v, a, b) <= t / 2)
}

// macOS-style margin: the rounded square fills ~80% of the canvas.
const app = (u0, v0) => {
  const u = (u0 - 0.1) / 0.8
  const v = (v0 - 0.1) / 0.8
  if (u < 0 || u > 1 || v < 0 || v > 1 || !roundedSquare(u, v, 0.22)) return NONE
  return snip(u, v, { m: 0.22, l: 0.21, t: 0.08, dot: 0.14 }) ? RED : DARK
}
const trayIdle = (u, v) => (snip(u, v, { m: 0.1, l: 0.3, t: 0.12, dot: 0.17 }) ? LIGHT : NONE)
const trayRec = (u, v) => {
  const d = dist(u, v)
  if (d < 0.46) return RED
  return NONE
}

const BLACK = [0, 0, 0, 1]
const recolor = (fn, color) => (u, v) => (fn(u, v)[3] ? color : NONE)

const out = process.argv[2] ?? 'resources'
mkdirSync(`${out}/mac`, { recursive: true })
writeFileSync(`${out}/icon.png`, png(1024, app))
writeFileSync(`${out}/tray-idle.png`, png(32, trayIdle))
writeFileSync(`${out}/tray-rec.png`, png(32, trayRec))
// macOS menu bar: 16pt images with @2x variants; "Template" images are recoloured by macOS.
writeFileSync(`${out}/mac/trayTemplate.png`, png(16, recolor(trayIdle, BLACK)))
writeFileSync(`${out}/mac/trayTemplate@2x.png`, png(32, recolor(trayIdle, BLACK)))
writeFileSync(`${out}/mac/trayRec.png`, png(16, trayRec))
writeFileSync(`${out}/mac/trayRec@2x.png`, png(32, trayRec))
// Microsoft Store (MSIX) tile assets; the manifest's background colour fills behind them.
const mark = (u, v) => (snip(u, v, { m: 0.2, l: 0.2, t: 0.075, dot: 0.13 }) ? RED : NONE)
const wide = (u, v) => mark(u - (310 / 150 - 1) / 2, v)
mkdirSync(`${out}/appx`, { recursive: true })
writeFileSync(`${out}/appx/StoreLogo.png`, png(50, app))
writeFileSync(`${out}/appx/Square44x44Logo.png`, png(44, app))
writeFileSync(`${out}/appx/Square150x150Logo.png`, png(150, mark))
writeFileSync(`${out}/appx/Wide310x150Logo.png`, png(310, 150, wide))
console.log('icons written to', out)
