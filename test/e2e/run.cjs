'use strict'
// End-to-end test of the real app: record → review → edit → save, then verify the saved files.
//   node test/e2e/run.cjs "<path to packaged app>"   (packaged build, e.g. dist/win-unpacked/Screen Snap.exe)
//   node test/e2e/run.cjs                            (runs from source with the local Electron)
// Exits non-zero if anything fails. Results, logs and screenshots land in test-results/e2e/.
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const http = require('node:http')
const { editorSuite } = require('./editor-suite.cjs')

const ROOT = path.resolve(__dirname, '../..')
const FFMPEG = require('ffmpeg-static')
const RESULTS = path.join(ROOT, 'test-results', 'e2e')
fs.rmSync(RESULTS, { recursive: true, force: true })
fs.mkdirSync(RESULTS, { recursive: true })

const target = process.argv[2]
const isWin = process.platform === 'win32'
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'))
const outDir = path.join(userData, 'saved')

const ONLY = (process.env.E2E_ONLY || '').split(',').filter(Boolean)
/** E2E_ONLY=edit,pause runs just those parts (for quick local checks); unset runs everything. */
const only = (name) => !ONLY.length || ONLY.includes(name)
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
function warn(name, detail = '') {
  results.push({ name, ok: true, warn: true, detail })
  log('WARN', name, detail ? `— ${detail}` : '')
}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `— ${detail}` : '')
  return ok
}

// ---------- file inspection ----------

const ff = (args, opts = {}) => spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
const info = (file) => ff(['-hide_banner', '-i', file]).stderr

function fullDecode(file) {
  const r = ff(['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'])
  return { ok: r.status === 0 && r.stderr.trim() === '', stderr: r.stderr.trim() }
}

function maxVolume(file) {
  const m = /max_volume: (-?[\d.]+) dB/.exec(ff(['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr)
  return m ? Number(m[1]) : -Infinity
}

function maxVolumeTail(file, seconds) {
  const m = /max_volume: (-?[\d.]+) dB/.exec(ff(['-hide_banner', '-sseof', `-${seconds}`, '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr)
  return m ? Number(m[1]) : -Infinity
}

/** True if the top-level MP4 boxes put `moov` before `mdat` (so players can start immediately). */
function isFaststart(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(16)
    let pos = 0
    const order = []
    while (pos + 8 <= size && order.length < 12) {
      fs.readSync(fd, head, 0, 16, pos)
      let len = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (len === 1) len = Number(head.readBigUInt64BE(8))
      order.push(type)
      if (len < 8) break
      pos += len
    }
    return order.indexOf('moov') !== -1 && (order.indexOf('mdat') === -1 || order.indexOf('moov') < order.indexOf('mdat'))
  } finally {
    fs.closeSync(fd)
  }
}

/** Finds bright-red UI pixels (the recording bar's Stop button, the countdown ring) in a region of one video frame. */
function redPixels(file, at, region, baseline) {
  const r = ff(
    ['-hide_banner', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer' }
  )
  const buf = r.stdout
  const isRed = (b, i) => Math.abs(b[i] - 239) < 25 && Math.abs(b[i + 1] - 68) < 25 && Math.abs(b[i + 2] - 68) < 25
  // Red that was already on the desktop before the app showed anything (an icon, say) is not our UI.
  // `baseline` is a screenshot of the bare desktop; (ox, oy) is where this video's top-left sits on it.
  const wasRed = (x, y) => {
    if (!baseline) return false
    const sx = baseline.ox + region.x + x, sy = baseline.oy + region.y + y
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const px = sx + dx, py = sy + dy
        if (px >= 0 && py >= 0 && px < baseline.w && py < baseline.h && isRed(baseline.buf, (py * baseline.w + px) * 3)) return true
      }
    }
    return false
  }
  let n = 0, ignored = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (isRed(buf, i)) {
      const p = i / 3, x = p % region.w, y = Math.floor(p / region.w)
      if (wasRed(x, y)) { ignored++; continue }
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const bbox = n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null
  // Our UI is a solid red button (the bar's Stop) or ring (the countdown): hundreds of pixels in a block at
  // least button-sized. A thin strip of red at an edge is something else on the desktop (e.g. an icon).
  const ui = !!bbox && n >= 300 && bbox.w >= 30 && bbox.h >= 14
  return { count: n, ignored, bbox, ui }
}

/** One frame of the bare desktop (physical pixels) so desktop colours can be told apart from the app's UI. */
function grabDesktop(w, h) {
  if (!isWin && process.platform !== 'linux') return null
  const input = isWin
    ? ['-f', 'gdigrab', '-framerate', '5', '-draw_mouse', '0', '-video_size', `${w}x${h}`, '-i', 'desktop']
    : ['-f', 'x11grab', '-framerate', '5', '-draw_mouse', '0', '-video_size', `${w}x${h}`, '-i', `${process.env.DISPLAY || ':0'}+0,0`]
  const r = ff(['-hide_banner', '-v', 'error', ...input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
  return r.stdout && r.stdout.length === w * h * 3 ? { buf: r.stdout, w, h } : null
}

/** Size and raw RGB of any image file (PNG, WebP, JPEG). */
function decodeImage(file) {
  const i = info(file)
  const m = /Video: [^\n]*?, (\d{2,5})x(\d{2,5})/.exec(i)
  const r = ff(['-hide_banner', '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
  return { width: m ? +m[1] : 0, height: m ? +m[2] : 0, rgb: r.stdout, codec: /Video: (\w+)/.exec(i)?.[1] ?? '', info: i }
}

/** Fraction of pixels that differ clearly from the bare desktop (the picture sits at ox,oy on it). */
function diffFromDesktop(img, desktop, ox, oy, threshold = 40) {
  let bad = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = (y * img.width + x) * 3
      const b = ((y + oy) * desktop.w + (x + ox)) * 3
      if (Math.abs(img.rgb[a] - desktop.buf[b]) > threshold || Math.abs(img.rgb[a + 1] - desktop.buf[b + 1]) > threshold || Math.abs(img.rgb[a + 2] - desktop.buf[b + 2]) > threshold) bad++
    }
  }
  return bad / (img.width * img.height)
}

/** Checks a converted recording (HEVC / WebM / GIF / MKV / MOV): right container and codecs, plays through, right length. */
function validateOther(label, file, want) {
  if (!check(`${label}: file saved`, fs.existsSync(file) && fs.statSync(file).size > 1024, file)) return
  const i = info(file)
  check(`${label}: container`, want.container.test(i), (/Input #0, [^,]+(?:,[^,]+)?/.exec(i) || [''])[0])
  const video = /Stream #.*Video: (.*)/.exec(i)?.[1] ?? ''
  check(`${label}: video codec`, want.video.test(video), video.slice(0, 80))
  if (want.pix) check(`${label}: 4:2:0 picture`, /yuv420p|pal8|bgra/.test(video) || want.pix.test(video), video.slice(0, 80))
  if (want.audio) check(`${label}: audio codec`, want.audio.test(/Stream #.*Audio: (.*)/.exec(i)?.[1] ?? ''), (/Stream #.*Audio: (.*)/.exec(i) || [,'none'])[1].slice(0, 60))
  else check(`${label}: no audio track`, !/Stream #.*Audio:/.test(i))
  const size = /, (\d{2,5})x(\d{2,5})/.exec(video)
  if (want.width) check(`${label}: size ${want.width}×${want.height}`, !!size && +size[1] === want.width && +size[2] === want.height, size ? `${size[1]}×${size[2]}` : 'no size')
  if (want.maxWidth) check(`${label}: picture no wider than ${want.maxWidth}`, !!size && +size[1] <= want.maxWidth, size ? size[1] : 'no size')
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(i)
  const seconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0
  check(`${label}: duration ${want.min}–${want.max}s`, seconds >= want.min && seconds <= want.max, `${seconds.toFixed(2)}s`)
  const d = fullDecode(file)
  check(`${label}: every frame decodes cleanly`, d.ok, d.stderr.slice(0, 200))
}

/** Opens the file with Windows' own media stack (the one Media Player and Photos use). */
function windowsMediaFoundation(file) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mf-decode.ps1'), '-Path', file],
    { encoding: 'utf8', timeout: 120000 }
  )
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

/** Everything a recording must satisfy before we'd ask anyone to download it. */
function validate(label, file, want) {
  const exists = fs.existsSync(file) && fs.statSync(file).size > 1024
  if (!check(`${label}: file saved`, exists, file)) return
  const i = info(file)
  const video = /Stream #.*Video: (.*)/.exec(i)?.[1] ?? ''
  const size = /, (\d{2,5})x(\d{2,5})/.exec(video)
  if (want.width) check(`${label}: size ${want.width}×${want.height}`, !!size && +size[1] === want.width && +size[2] === want.height, size ? `${size[1]}×${size[2]}` : 'no size')
  check(`${label}: H.264 video`, /^h264/.test(video), video.slice(0, 60))
  if (want.playable !== false) {
    check(`${label}: 4:2:0 High profile (plays everywhere)`, /h264 \(High\).*yuv420p/.test(video), video.slice(0, 90))
    check(`${label}: BT.709 colour tags`, /bt709/.test(video))
  }
  if (want.audio) {
    check(`${label}: AAC stereo 48 kHz audio`, /Audio: aac.*48000 Hz, stereo/.test(i), (/Audio: .*/.exec(i) || [''])[0].slice(0, 80))
    const vol = maxVolume(file)
    check(`${label}: audio is not silent`, vol > -60, `peak ${vol} dB`)
  }
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(i)
  const seconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0
  if (want.minSeconds) check(`${label}: duration ≥ ${want.minSeconds}s`, seconds >= want.minSeconds, `${seconds.toFixed(2)}s`)
  if (want.maxSeconds) check(`${label}: duration ≤ ${want.maxSeconds}s`, seconds <= want.maxSeconds, `${seconds.toFixed(2)}s`)
  if (want.fps) {
    const f = /, (\d+(?:\.\d+)?) fps/.exec(video)
    check(`${label}: ${want.fps} fps`, !!f && Math.abs(+f[1] - want.fps) < 1, f ? f[0] : 'no frame rate')
  }
  if (want.syncAv) {
    const decoded = (map) => {
      const r = ff(['-hide_banner', '-i', file, '-map', map, '-f', 'null', '-'])
      const t = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop()
      return t ? +t[1] * 3600 + +t[2] * 60 + +t[3] : NaN
    }
    const v = decoded('0:v:0')
    const a = decoded('0:a:0')
    check(`${label}: audio and video stay in sync`, Math.abs(v - a) <= 0.6, `video ${v.toFixed(2)}s, audio ${a.toFixed(2)}s`)
  }
  check(`${label}: starts instantly (moov before mdat)`, isFaststart(file))
  const d = fullDecode(file)
  check(`${label}: every frame decodes cleanly`, d.ok, d.stderr.slice(0, 200))
  if (isWin && want.playable !== false) {
    const mf = windowsMediaFoundation(file)
    check(`${label}: opens in Windows' own media stack`, mf.ok, mf.out.replace(/\s+/g, ' ').slice(0, 300))
  }
}

// ---------- app driving ----------

async function waitForWindow(app, part, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const w = app.windows().find((p) => !p.isClosed() && p.url().includes(part))
    if (w) return w
    await sleep(100)
  }
  throw new Error(`window "${part}" never appeared; open: ${app.windows().map((w) => w.url()).join(', ')}`)
}

async function waitGone(app, part, timeout = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!app.windows().some((p) => !p.isClosed() && p.url().includes(part))) return
    await sleep(100)
  }
  throw new Error(`window "${part}" is still open`)
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(RESULTS, `${name}.png`) }).catch(() => {})
}

const shotDir = path.join(userData, 'shots-saved')
const SETTINGS = (over) => ({
  outputDir: outDir,
  shotDir,
  shotFormat: 'png',
  shotClipboard: false,
  shotCursor: false,
  shotDelay: 0,
  autoUpdate: true,
  videoFormat: 'mp4',
  systemAudio: isWin, // exercises the Windows loopback path; there's no sound device on CI so it may fail softly
  micEnabled: true,
  micDevice: 'default',
  fps: 60,
  quality: 'maximum',
  countdown: 1,
  mode: 'fullscreen',
  ...over
})

let overrides = {}
async function setSettings(main, over) {
  overrides = { ...overrides, ...over }
  await main.evaluate((o) => window.api.setSettings(o), SETTINGS(overrides))
  await sleep(200)
}

/** Starts a recording, returns the review window once it has opened. */
async function record(app, main, label, { seconds, region, checkAffinity, pauses, during }) {
  log(`--- recording: ${label} ---`)
  await setSettings(main, { mode: region ? 'region' : 'fullscreen' })
  await main.click('#tab-record')
  await main.click('#record')

  if (region) {
    const overlay = await waitForWindow(app, 'overlay.html')
    await overlay.waitForLoadState('domcontentloaded')
    await sleep(600)
    await shot(overlay, `${label}-overlay`)
    const vp = await overlay.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    const fr = region.fractions || { x1: 0.15, y1: 0.2, x2: 0.75, y2: 0.7 }
    const x1 = Math.round(vp.w * fr.x1), y1 = Math.round(vp.h * fr.y1)
    const x2 = Math.round(vp.w * fr.x2), y2 = Math.round(vp.h * fr.y2)
    await overlay.mouse.move(x1, y1)
    await overlay.mouse.down()
    await overlay.mouse.move(x2, y2, { steps: 12 })
    await overlay.mouse.up()
    region.expected = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }

  const bar = await waitForWindow(app, 'bar.html')
  const t0 = Date.now()
  let recording = false
  const barTexts = []
  while (Date.now() - t0 < 45000) {
    const tx = await bar.textContent('#text', { timeout: 500 }).catch(() => null)
    if (tx && barTexts[barTexts.length - 1] !== tx) barTexts.push(tx)
    if (await bar.isVisible('#stop').catch(() => false)) { recording = true; break }
    await sleep(100)
  }
  check(`${label}: the timer is shown the moment capture starts, with no "Recording…" word first`, !barTexts.some((t) => /Recording/i.test(t)) && barTexts.some((t) => /^\d\d:\d\d$/.test(t)), barTexts.join(' | '))
  if (!check(`${label}: recording started (first frame captured)`, recording, `${((Date.now() - t0) / 1000).toFixed(1)}s after pressing Record`)) {
    const st = await main.evaluate(() => window.api.getStatus()).catch(() => ({}))
    throw new Error(`recording never started: ${JSON.stringify(st)}`)
  }
  const st = await main.evaluate(() => window.api.getStatus())
  log(`backend=${st.backend} encoder=${st.encoder} resolution=${st.resolution} audio=${st.audio ?? 'none'} warning=${st.warning ?? '-'}`)
  const hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.isVisible() === false)
  check(`${label}: control panel hidden while recording`, hidden)

  const barInfo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('bar.html'))
    return { bounds: w.getBounds(), visible: w.isVisible(), handle: w.getNativeWindowHandle().length === 8 ? w.getNativeWindowHandle().readBigUInt64LE(0).toString() : '0' }
  })
  const barBounds = barInfo.bounds
  log(`bar window: ${barInfo.visible ? 'shown on screen' : 'HIDDEN by the app (it could see itself in the capture)'} at ${JSON.stringify(barBounds)}`)
  if (isWin && checkAffinity) {
    // Whatever the capture method does, the app must at least ask Windows to exclude the bar (WDA_EXCLUDEFROMCAPTURE = 0x11).
    const readAffinity = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'affinity.ps1'), '-Handle', barInfo.handle], { encoding: 'utf8', timeout: 60000 })
    const r = readAffinity()
    check(`${label}: the app asks Windows to exclude the bar from capture`, r.status === 0, `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 200))
    if (r.status !== 0) {
      // Diagnostic: does asking again now (window fully shown) take effect?
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('bar.html'))?.setContentProtection(true))
      const r2 = readAffinity()
      log('affinity after the test calls setContentProtection(true) again:', `${r2.stdout || ''}${r2.stderr || ''}`.trim())
    }
  }
  await sleep(seconds * 1000)
  const barText = await bar.textContent('#text')
  check(`${label}: timer is running`, /^\d\d:\d\d/.test(barText), barText)

  if (during) await during()

  // Pause and resume the way a person does: the bar's button when the bar is on screen, otherwise the shortcut/tray command.
  const pauseLog = []
  if (pauses) {
    const stat = () => main.evaluate(() => window.api.getStatus())
    const until = async (fn, ms = 20000) => {
      const t = Date.now()
      while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100) }
      return false
    }
    const press = async (via) => {
      if (via === 'bar' && barInfo.visible) await bar.click('#pause')
      else await main.evaluate(() => window.api.togglePause())
    }
    check(`${label}: the bar has a Pause button next to Stop`, await bar.evaluate(() => !document.getElementById('pause').hidden && !document.getElementById('stop').hidden && document.getElementById('pause-text').textContent === 'Pause'))
    let n = 0
    for (const step of pauses) {
      n++
      const tag = `${label}: pause #${n} (${step.via})`
      await press(step.via)
      const paused = await until(async () => (await stat()).state === 'paused')
      const p1 = await stat()
      check(`${tag}: recording pauses`, paused, `state ${p1.state}, ${p1.elapsed.toFixed(1)}s`)
      if (!paused) break
      await sleep(step.hold * 1000)
      const p2 = await stat()
      check(`${tag}: the timer stays put while paused`, Math.abs(p2.elapsed - p1.elapsed) < 0.3, `${p1.elapsed.toFixed(2)}s → ${p2.elapsed.toFixed(2)}s after ${step.hold}s`)
      const shown = await bar.evaluate(() => ({ text: document.getElementById('text').textContent, button: document.getElementById('pause-text').textContent, stop: !document.getElementById('stop').hidden }))
      check(`${tag}: the bar says Paused and offers Resume and Stop`, /^Paused \d\d:\d\d/.test(shown.text) && shown.button === 'Resume' && shown.stop, JSON.stringify(shown))
      const panel = await main.evaluate(() => ({ chip: document.getElementById('chip')?.textContent, button: document.getElementById('pause-text').textContent }))
      check(`${tag}: the control panel agrees`, /Paused/.test(panel.chip ?? '') && panel.button === 'Resume', JSON.stringify(panel))
      pauseLog.push({ pausedAt: p1.elapsed })
      if (step.stopWhilePaused) break
      await press(step.via)
      const back = await until(async () => (await stat()).state === 'recording')
      const r = await stat()
      check(`${tag}: Resume carries on from the same point`, back && r.elapsed >= p1.elapsed - 0.05 && r.elapsed < p1.elapsed + 8, `${p1.elapsed.toFixed(2)}s → ${r.elapsed.toFixed(2)}s`)
      await sleep(step.then * 1000)
      const later = await stat()
      check(`${tag}: the timer runs again after Resume`, later.elapsed > r.elapsed + step.then - 1, `${r.elapsed.toFixed(2)}s → ${later.elapsed.toFixed(2)}s`)
    }
  }
  const finalElapsed = (await main.evaluate(() => window.api.getStatus())).elapsed
  // Stop exactly as a user would: the bar's Stop button, or (when the bar is hidden) the hotkey/tray command.
  if (barInfo.visible) await bar.click('#stop')
  else await main.evaluate(() => window.api.toggleRecording())

  const editor = await waitForWindow(app, 'editor.html', 120000)
  await editor.waitForFunction(
    () => document.querySelector('#info')?.textContent || !document.querySelector('#stage-msg')?.hidden,
    null, { timeout: 120000 }
  )
  const loadError = await editor.$eval('#stage-msg', (e) => (e.hidden ? '' : e.textContent))
  const infoLine = await editor.textContent('#info')
  if (!check(`${label}: review window opened the recording`, !loadError && !!infoLine, loadError || infoLine)) {
    await shot(editor, `${label}-editor`)
    throw new Error(`review window could not open the recording: ${loadError}`)
  }
  await editor.waitForFunction(() => (document.querySelector('#layers video')?.readyState ?? 0) >= 2, null, { timeout: 60000 })
    .then(() => check(`${label}: review window can play the video`, true))
    .catch(() => check(`${label}: review window can play the video`, false, 'preview never became ready'))
  await shot(editor, `${label}-editor`)
  return { editor, status: st, infoLine, barBounds, barVisible: barInfo.visible, pauseLog, finalElapsed }
}

/** Starts a screenshot from the panel; returns the review window once the picture is ready. */
async function snap(app, main, label, { region, delay = 0 } = {}) {
  log(`--- screenshot: ${label} ---`)
  await setSettings(main, { shotMode: region ? 'region' : 'fullscreen', shotDelay: delay })
  await main.click('#tab-shot')
  await main.click('#shoot')
  let expected = null
  if (region) {
    const overlay = await waitForWindow(app, 'overlay.html')
    await overlay.waitForLoadState('domcontentloaded')
    await overlay.waitForFunction(() => { const i = document.getElementById('frozen'); return !!i && i.complete && i.naturalWidth > 0 }, null, { timeout: 30000 })
      .then(() => check(`${label}: the screen is frozen behind the selection`, true))
      .catch(() => check(`${label}: the screen is frozen behind the selection`, false, 'frozen picture never loaded'))
    await sleep(400)
    await shot(overlay, `${label}-overlay`)
    const vp = await overlay.evaluate(() => ({ w: innerWidth, h: innerHeight, styled: document.body.classList.contains('shot') }))
    check(`${label}: selection overlay has the screenshot style`, vp.styled)
    const fr = region.fractions || { x1: 0.1, y1: 0.15, x2: 0.6, y2: 0.6 }
    const x1 = Math.round(vp.w * fr.x1), y1 = Math.round(vp.h * fr.y1)
    const x2 = Math.round(vp.w * fr.x2), y2 = Math.round(vp.h * fr.y2)
    await overlay.mouse.move(x1, y1)
    await overlay.mouse.down()
    await overlay.mouse.move(x2, y2, { steps: 12 })
    await overlay.mouse.up()
    expected = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  const review = await waitForWindow(app, 'shot.html', 60000)
  await review.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 })
  await shot(review, `${label}-review`)
  return { review, expected }
}

const shotFile = (name, ext = 'png') => path.join(shotDir, `${name}.${ext}`)
const idleNow = async (main) => (await main.evaluate(() => window.api.getStatus())).state === 'idle'
const clipboardSize = (app) => app.evaluate(({ clipboard }) => clipboard.readImage().getSize())

/** Drags across the canvas (fractions of its size) with the mouse. */
async function dragOnCanvas(page, from, to) {
  const b = await page.locator('#view').boundingBox()
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1])
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 8 })
  await page.mouse.up()
}

/** Clicks the timeline ruler at a time, the way a person moves the playhead. */
async function seekTo(editor, t) {
  const box = await editor.locator('#tl-ruler').boundingBox()
  const px = await editor.evaluate(() => window.__editor.store.pxPerSec)
  await editor.mouse.click(box.x + t * px, box.y + 12)
  await sleep(150)
}

const editorState = (editor) => editor.evaluate(() => {
  const s = window.__editor.store
  return { duration: s.duration, playhead: s.playhead, clips: s.project.clips.map((c) => ({ id: c.id, name: c.name, kind: c.kind, in: c.in, out: c.out, track: c.track, start: c.start, speed: c.speed, fadeIn: c.fadeIn, fadeOut: c.fadeOut, box: c.box })),
    overlays: s.project.overlays.map((o) => ({ ...o })), sounds: s.project.sounds, crop: s.project.crop, out: s.outputSize, brand: s.brand, selection: s.selection }
})

/** Splits at 30 % and deletes the first piece, like cutting the start off. */
async function cutFirstThird(editor) {
  const dur = (await editorState(editor)).duration
  await seekTo(editor, dur * 0.3)
  await editor.click('#split')
  await editor.click('.blk.clip >> nth=0')
  await editor.click('#delete-sel')
}

/** Makes the next "Add video / music / font" dialog answer with these files. */
const answerPicker = (app, files) => app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, files)

/** The colour of one pixel of a saved video at a time, as a player shows it. */
function pixelAt(file, t, x, y, w, h) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 256 * 1024 * 1024 })
  const d = r.stdout
  const i = (Math.round(y) * w + Math.round(x)) * 3
  return d.length > i + 2 ? [d[i], d[i + 1], d[i + 2]] : null
}
const nearColour = (a, b, tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol)

/** After a save the editor stays open (to keep editing); click Finish, then wait for it to go. */
async function finishSaved(app, editor, ms) {
  await editor.waitForSelector('#saved:not([hidden])', { timeout: ms })
  // the window can close before the click has finished being reported: that is the click working
  await editor.click('#saved-finish', { noWaitAfter: true }).catch((e) => { if (!/closed/i.test(String(e))) throw e })
  await waitGone(app, 'editor.html', ms)
}

async function save(app, editor, name) {
  await editor.fill('#name', name)
  await editor.click('#save')
  await finishSaved(app, editor, 180000)
  return path.join(outDir, `${name}.mp4`)
}

;(async () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(SETTINGS({})))

  // A recording the app was in the middle of when the computer lost power — one made in two pieces by a pause, one in a single
  // piece, and one empty leftover. The app must turn the first two into normal recordings when it starts.
  const pendingDirSeed = path.join(userData, 'pending')
  fs.mkdirSync(pendingDirSeed, { recursive: true })
  const makePiece = (file, hz) => ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30,format=yuv420p', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000`,
    '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file])
  const stemA = path.join(pendingDirSeed, 'Recording 2020-01-01 10-00-00')
  const stemB = path.join(pendingDirSeed, 'Recording 2020-01-01 11-00-00')
  makePiece(`${stemA}.recording.mp4`, 400)
  makePiece(`${stemA}.recording2.mp4`, 600)
  makePiece(`${stemB}.recording.mp4`, 500)
  fs.writeFileSync(path.join(pendingDirSeed, 'Recording 2020-01-01 12-00-00.recording.mp4'), '')

  // A tiny update feed on this computer (Windows only: Linux runs from source, which never self-updates).
  let feedVersion = require(path.join(ROOT, 'package.json')).version
  const feedServer = http.createServer((req, res) => {
    // electron-updater asks for latest.yml?noCache=<token>, so ignore the query string
    if (/latest\.yml$/.test(req.url.split('?')[0])) {
      res.writeHead(200, { 'Content-Type': 'text/yaml' })
      res.end(`version: ${feedVersion}\nfiles:\n  - url: Screen-Snap-Setup-${feedVersion}.exe\n    sha512: AAAA\n    size: 1\npath: Screen-Snap-Setup-${feedVersion}.exe\nsha512: AAAA\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => feedServer.listen(0, '127.0.0.1', r))
  const feedUrl = `http://127.0.0.1:${feedServer.address().port}`

  const flags = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${userData}`]
  const launch = target
    ? { executablePath: path.resolve(target), args: flags }
    : { executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', ROOT, ...flags] }
  log('launching', target ? path.resolve(target) : 'Electron from source', '| platform', process.platform)
  const app = await electron.launch({ ...launch, timeout: 120000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...(isWin ? { SCREEN_SNAP_UPDATE_FEED: feedUrl } : {}) } })
  const errors = []
  app.process().stderr.on('data', (d) => {
    const s = String(d)
    if (/ERROR|FATAL/.test(s) && !/bus\.cc|dbus|gpu|GPU|viz|ozone|libva|Fontconfig|ALSA|command_buffer|sandbox|display_|angle|shared_image|SharedImage/i.test(s)) errors.push(s.trim())
  })

  let failed = false
  try {
    const main = await waitForWindow(app, 'index.html')
    await main.waitForFunction(() => !document.getElementById('footer').textContent.includes('Detecting'), null, { timeout: 60000 })
    log('panel ready:', await main.textContent('#footer'))
    await sleep(1500)
    {
      log('--- recovery of interrupted recordings ---')
      const left = fs.readdirSync(pendingDirSeed)
      const a = path.join(pendingDirSeed, 'Recording 2020-01-01 10-00-00.mp4')
      const b = path.join(pendingDirSeed, 'Recording 2020-01-01 11-00-00.mp4')
      check('Recovery: a recording interrupted after a pause comes back as one normal recording', fs.existsSync(a), left.join(', '))
      check('Recovery: a recording interrupted in one piece comes back too', fs.existsSync(b))
      check('Recovery: no loose pieces or empty leftovers remain', !left.some((n) => /\.recording\d*\.mp4$|\.pieces\.txt$/.test(n)), left.join(', '))
      if (fs.existsSync(a)) {
        const i = info(a)
        const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(i)
        const seconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0
        check('Recovery: the joined recording contains both pieces (about 4 s)', seconds > 3.5 && seconds < 4.6, `${seconds.toFixed(2)}s`)
        check('Recovery: and it plays from start to end', fullDecode(a).ok)
      }
      // They are waiting for review like any recording, and they open in the editor: look at each, then discard it.
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      let opened = 0
      if (await main.isVisible('#pending')) await main.click('#review')
      // discarding one opens the next waiting recording by itself, so keep looking until none opens
      for (let n = 0; n < 4; n++) {
        const ed = await waitForWindow(app, 'editor.html', n === 0 ? 30000 : 5000).catch(() => null)
        if (!ed) break
        await ed.waitForFunction(() => document.querySelector('#info')?.textContent, null, { timeout: 30000 })
        opened++
        await ed.click('#discard', { noWaitAfter: true }).catch(() => undefined)
        const t0 = Date.now()
        while (!ed.isClosed() && Date.now() - t0 < 30000) await sleep(100)
        await sleep(400)
      }
      check('Recovery: the recovered recordings open in the editor and can be discarded', opened === 2 && !(await main.isVisible('#pending')), `${opened} opened`)
    }
    const runVersion = await app.evaluate(({ app }) => app.getVersion())
    feedVersion = runVersion // the feed starts out announcing the very version that is running
    await shot(main, 'panel')

    const display = await app.evaluate(({ screen }) => {
      const d = screen.getPrimaryDisplay()
      return { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), f: d.scaleFactor,
        work: d.workArea }
    })
    log('primary display (physical px):', `${display.w}×${display.h} @${display.f}x`)
    const evenFloor = (n) => Math.floor(n / 2) * 2

    // A picture of the bare desktop (the app's own windows hidden), so a red desktop icon isn't mistaken for the app's UI.
    let desktop = null
    if (isWin || process.platform === 'linux') {
      const shown = await app.evaluate(({ BrowserWindow }) => {
        const ids = BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.id)
        for (const id of ids) BrowserWindow.fromId(id).hide()
        return ids
      })
      await sleep(700)
      desktop = grabDesktop(display.w, display.h)
      await app.evaluate(({ BrowserWindow }, ids) => { for (const id of ids) BrowserWindow.fromId(id)?.show() }, shown)
      await sleep(500)
      log('bare desktop captured for comparison:', desktop ? `${desktop.w}×${desktop.h}` : 'not available')
    }

    // ---- Settings area: a fixed-height box that scrolls, with section shortcuts ----
    if (only('panel')) {
      log('--- panel layout ---')
      check('Panel: has Record and Screenshot tabs, Record selected', (await main.getAttribute('#tab-record', 'aria-selected')) === 'true' && (await main.getAttribute('#tab-shot', 'aria-selected')) === 'false')
      check('Panel: named Screen Snap', (await main.title()) === 'Screen Snap' && /Screen Snap/.test(await main.textContent('.brand h1')), await main.title())
      await shot(main, 'panel-settings-closed')
      await main.click('#settings-toggle')
      await main.waitForSelector('#settings-wrap:not([hidden])')
      await sleep(400)
      const m = await main.evaluate(() => {
        const b = document.getElementById('settings-body')
        return { clientH: b.clientHeight, scrollH: b.scrollHeight, app: Math.ceil(document.getElementById('app').getBoundingClientRect().height),
          fadeHidden: document.getElementById('fade').classList.contains('hide'), win: window.innerHeight }
      })
      check('Settings: scroll inside a fixed-height area instead of growing the window', m.scrollH > m.clientH + 100 && m.clientH <= 250, JSON.stringify(m))
      check('Settings open: the whole window stays compact (≤ 740 px)', m.app <= 740, `${m.app}px`)
      check('Settings: "scroll for more" shows while there is more below', !m.fadeHidden)
      await shot(main, 'panel-settings-open')
      await main.click('#jump button[data-target=g-keys]')
      await sleep(1200)
      const k = await main.evaluate(() => {
        const b = document.getElementById('settings-body')
        const g = document.getElementById('g-keys').getBoundingClientRect()
        const r = b.getBoundingClientRect()
        return { visible: g.top < r.bottom && g.bottom > r.top, atEnd: b.scrollTop + b.clientHeight >= b.scrollHeight - 6,
          active: document.querySelector('#jump button.on')?.dataset.target, fadeHidden: document.getElementById('fade').classList.contains('hide') }
      })
      check('Settings: tapping a section name scrolls to it and highlights it', k.visible && k.active === 'g-keys', JSON.stringify(k))
      const bottom = await main.evaluate(async () => {
        const b = document.getElementById('settings-body')
        b.scrollTop = b.scrollHeight
        await new Promise((r) => setTimeout(r, 200))
        return { atEnd: b.scrollTop + b.clientHeight >= b.scrollHeight - 6, fadeHidden: document.getElementById('fade').classList.contains('hide') }
      })
      check('Settings: the fade goes away at the very bottom', bottom.fadeHidden && bottom.atEnd, JSON.stringify(bottom))
      await shot(main, 'panel-settings-bottom')
      const reach = await main.evaluate(async () => {
        const b = document.getElementById('settings-body')
        const seen = []
        for (const id of ['g-rec', 'g-video', 'g-audio', 'g-saving', 'g-shots', 'g-keys']) {
          const g = document.getElementById(id)
          b.scrollTop = g.offsetTop - 50
          await new Promise((r) => setTimeout(r, 50))
          const gr = g.getBoundingClientRect(), br = b.getBoundingClientRect()
          seen.push(gr.top < br.bottom && gr.bottom > br.top)
        }
        return seen
      })
      check('Settings: every section can be reached by scrolling', reach.every(Boolean), reach.join(','))

      // Shortcuts: safe defaults, and changeable
      log('--- shortcuts ---')
      const registered = (acc) => app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), acc)
      const st = await main.evaluate(() => window.api.getSettings())
      const caps0 = await main.evaluate(() => window.api.getCapabilities())
      check('Shortcuts: record and screenshot have different default keys', !!st.hotkeyRecord && !!st.hotkeyShot && st.hotkeyRecord !== st.hotkeyShot, `${st.hotkeyRecord} / ${st.hotkeyShot}`)
      check('Shortcuts: both defaults are registered', (await registered(st.hotkeyRecord)) && (await registered(st.hotkeyShot)), `${caps0.hotkey} / ${caps0.shotHotkey}`)
      check('Shortcuts: pause has its own safe default key and it is registered', !!st.hotkeyPause && ![st.hotkeyRecord, st.hotkeyShot].includes(st.hotkeyPause) && (await registered(st.hotkeyPause)) && !!caps0.pauseHotkey, `${st.hotkeyPause} / ${caps0.pauseHotkey}`)
      for (const acc of ['Control+Shift+R', 'CommandOrControl+Shift+R', 'Command+Shift+R']) {
        check(`Shortcuts: the browser's hard-refresh key (${acc}) is NOT taken`, !(await registered(acc)))
      }
      for (const acc of ['Control+Shift+I', 'CommandOrControl+Shift+I', 'Command+Alt+I']) {
        check(`Shortcuts: the browser's developer-tools key (${acc}) is NOT taken`, !(await registered(acc)))
      }
      const labelOk = (await main.textContent('#key-record')).includes(caps0.hotkey) && (await main.textContent('#key-shot')).includes(caps0.shotHotkey)
      check('Shortcuts: settings show the current keys', labelOk, `${await main.textContent('#key-record')} | ${await main.textContent('#key-shot')}`)

      await main.click('#key-record')
      check('Shortcuts: clicking a key box waits for the new keys', /Press the new keys/.test(await main.textContent('#key-record')))
      await main.keyboard.press('KeyQ')
      check('Shortcuts: a bare letter is refused with an explanation', /Use Ctrl, Alt or Shift/.test(await main.textContent('#key-hint')) && /Press the new keys/.test(await main.textContent('#key-record')))
      await main.keyboard.press('Control+Alt+KeyQ')
      await sleep(500)
      let now = await main.evaluate(() => window.api.getSettings())
      check('Shortcuts: a new key combination is saved', now.hotkeyRecord === 'Control+Alt+Q', now.hotkeyRecord)
      check('Shortcuts: the new keys work and the old ones are released', (await registered('Control+Alt+Q')) && !(await registered(st.hotkeyRecord)))
      await main.click('#key-record')
      await main.keyboard.press('Escape')
      check('Shortcuts: Escape cancels without changing anything', (await main.evaluate(() => window.api.getSettings())).hotkeyRecord === 'Control+Alt+Q')
      await main.click('#key-record')
      await main.keyboard.press(st.hotkeyShot.replace(/\+([A-Z])$/, '+Key$1'))
      await sleep(300)
      check('Shortcuts: the same keys can\'t be used for both actions', /already used for another action/.test(await main.textContent('#key-hint')) && (await main.evaluate(() => window.api.getSettings())).hotkeyRecord === 'Control+Alt+Q')
      await main.keyboard.press('Escape')
      // A key another app already owns is reported, not silently ignored.
      await app.evaluate(({ globalShortcut }) => {
        const real = globalShortcut.register.bind(globalShortcut)
        globalShortcut.register = (accelerator, cb) => (accelerator === 'Control+Alt+W' ? false : real(accelerator, cb))
      })
      await main.click('#key-shot')
      await main.keyboard.press('Control+Alt+KeyW')
      await sleep(600)
      const clash = await main.evaluate(async () => ({ caps: await window.api.getCapabilities(), s: await window.api.getSettings() }))
      check('Shortcuts: a key used by another app shows "unavailable"', clash.s.hotkeyShot === 'Control+Alt+W' && clash.caps.shotHotkey === null && /unavailable/.test(await main.textContent('#key-shot')), await main.textContent('#key-shot'))
      await main.click('#key-shot-off')
      await sleep(500)
      now = await main.evaluate(() => window.api.getSettings())
      const capsOff = await main.evaluate(() => window.api.getCapabilities())
      check('Shortcuts: a shortcut can be turned off', now.hotkeyShot === '' && capsOff.shotHotkey === null && !(await registered('Control+Alt+W')) && (await main.textContent('#key-shot')).trim() === 'Off')
      await main.evaluate((d) => window.api.setSettings({ hotkeyRecord: d.r, hotkeyShot: d.s }), { r: st.hotkeyRecord, s: st.hotkeyShot })
      await sleep(400)
      await main.click('#key-pause')
      await main.keyboard.press('Control+Alt+KeyY')
      await sleep(400)
      const pk = await main.evaluate(() => window.api.getSettings())
      check('Shortcuts: the pause key can be changed, and the old one is released', pk.hotkeyPause === 'Control+Alt+Y' && (await registered('Control+Alt+Y')) && !(await registered(st.hotkeyPause)), pk.hotkeyPause)
      await main.click('#key-pause-off')
      await sleep(400)
      check('Shortcuts: the pause key can be turned off', (await main.evaluate(() => window.api.getSettings())).hotkeyPause === '' && !(await registered('Control+Alt+Y')) && (await main.textContent('#key-pause')).trim() === 'Off')
      await main.evaluate((d) => window.api.setSettings({ hotkeyPause: d }), st.hotkeyPause)
      await sleep(300)
      check('Shortcuts: defaults come back', (await registered(st.hotkeyRecord)) && (await registered(st.hotkeyShot)) && (await registered(st.hotkeyPause)) && !(await registered('Control+Alt+Q')))
      await main.click('#settings-toggle')
    }

    // ---- Updates: the installed app updates itself (Settings → Updates) ----
    if (only('updates')) {
      log('--- updates ---')
      await main.click('#settings-toggle')
      await main.waitForSelector('#settings-wrap:not([hidden])')
      await main.click('#jump button[data-target=g-updates]')
      await sleep(900)
      check('Updates: the running version is shown', (await main.textContent('#app-version')).trim() === runVersion && /^\d+\.\d+\.\d+$/.test(runVersion), `${await main.textContent('#app-version')} vs ${runVersion}`)
      check('Updates: Settings has an Updates section reachable from the section buttons', await main.isVisible('#update-check'))
      const line = () => main.textContent('#update-line')
      if (!isWin) {
        const l = await line()
        check('Updates: a development copy says plainly that it does not update itself', /doesn’t update itself/.test(l), l)
        check('Updates: "Check now" is switched off when updates are not possible', await main.isDisabled('#update-check'))
        check('Updates: no update banner is shown for it', await main.isHidden('#update-banner'))
      } else {
        // The packaged app asks the local feed: same version → up to date
        await main.click('#update-check')
        await main.waitForFunction(() => /up to date/.test(document.getElementById('update-line').textContent), null, { timeout: 30000 })
          .then(() => check('Updates: "Check now" says you are up to date when there is nothing newer', true), async () => check('Updates: "Check now" says you are up to date when there is nothing newer', false, await line()))
        check('Updates: no banner when up to date', await main.isHidden('#update-banner'))
        // A newer version exists, automatic updates are off → it is announced with a Download button
        await main.evaluate(() => window.api.setSettings({ autoUpdate: false }))
        feedVersion = '99.0.0'
        await main.click('#update-check')
        await main.waitForFunction(() => /99\.0\.0 is available/.test(document.getElementById('update-line').textContent), null, { timeout: 30000 })
          .then(() => check('Updates: a newer version is announced', true), async () => check('Updates: a newer version is announced', false, await line()))
        check('Updates: the banner offers "Update now"', (await main.isVisible('#update-banner')) && /Update now/.test(await main.textContent('#update-action')), await main.textContent('#update-banner'))
        check('Updates: the Updates section button is marked while an update is waiting', await main.evaluate(() => document.querySelector('#jump button[data-target=g-updates]').classList.contains('has-update')))
        check('Updates: no progress bar until it downloads', await main.isHidden('#update-bar'))
        await shot(main, 'panel-update-available')
        // When the feed can't be reached the app says so quietly (no crash, no scary banner)
        feedServer.close()
        feedServer.closeAllConnections()
        await main.evaluate(() => window.api.setSettings({ autoUpdate: true }))
        await sleep(300)
        await main.click('#update-check')
        await main.waitForFunction(() => /Couldn’t check for updates/.test(document.getElementById('update-line').textContent), null, { timeout: 40000 })
          .then(() => check('Updates: an unreachable update server is reported calmly', true), async () => check('Updates: an unreachable update server is reported calmly', false, await line()))
      }
      await main.click('#update-auto')
      check('Updates: automatic updates can be switched off', (await main.evaluate(() => window.api.getSettings())).autoUpdate === false)
      await main.click('#update-auto')
      check('Updates: …and back on', (await main.evaluate(() => window.api.getSettings())).autoUpdate === true)
      await shot(main, 'panel-updates')
      await main.click('#settings-toggle')
    }

    // 0) Prove the Windows playback check itself works: a normal 4:2:0 file must pass; the 4:4:4 format
    //    that Windows Media Player rejects (error 0x80004005) is reported for information.
    if (isWin) {
      const make = (name, pix, profile) => {
        const f = path.join(RESULTS, name)
        ff(['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-c:v', 'libx264',
          '-pix_fmt', pix, '-profile:v', profile, '-movflags', '+faststart', f])
        return f
      }
      const good = windowsMediaFoundation(make('control-420.mp4', 'yuv420p', 'high'))
      check('Control: a standard 4:2:0 H.264 file plays in Windows', good.ok, good.out.replace(/\s+/g, ' ').slice(0, 250))
      const bad = windowsMediaFoundation(make('control-444.mp4', 'yuv444p', 'high444'))
      log(`Control: 4:4:4 H.264 (what Media Player rejected) → ${bad.ok ? 'Windows CAN decode it here' : 'Windows cannot decode it'}: ${bad.out.replace(/\s+/g, ' ').slice(0, 200)}`)
    }

    // 1) Whole screen, Maximum, with audio → save untouched
    if (only('maximum')) {
      const { editor, status, barBounds, barVisible } = await record(app, main, 'maximum', { seconds: 5, checkAffinity: true })
      const file = await save(app, editor, 'e2e-maximum')
      validate('Maximum whole screen', file, {
        width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 4, maxSeconds: 12
      })
      if (isWin) {
        // Wherever the bar was placed, none of its pixels may appear in the video.
        const b = barBounds
        const region = {
          w: Math.round(b.width * display.f), h: Math.round(b.height * display.f),
          x: Math.round(b.x * display.f), y: Math.round(b.y * display.f)
        }
        const found = redPixels(file, 3, region, desktop && { ...desktop, ox: 0, oy: 0 })
        const detail = `${found.count} bright-red pixels (${found.ignored} already on the desktop), bbox ${JSON.stringify(found.bbox)}, where the bar was (${JSON.stringify(b)}); bar ${barVisible ? 'was shown' : 'was hidden by the app'}`
        check('Maximum whole screen: recording bar is NOT in the video', !found.ui, detail)
      }
      log('recorded with', status.backend, '/', status.encoder)
    }

    // 1b) Pause and resume (twice) → one continuous file that leaves out the paused time
    if (only('pause')) {
      const wallStart = Date.now()
      const { editor, pauseLog, finalElapsed } = await record(app, main, 'paused', {
        seconds: 2.5,
        pauses: [{ via: 'bar', hold: 3.5, then: 2 }, { via: 'api', hold: 1.5, then: 1.5 }]
      })
      const wall = (Date.now() - wallStart) / 1000
      const file = await save(app, editor, 'e2e-paused')
      // ~6 s was recorded; the 5 s spent paused must not be in the file.
      validate('Paused and resumed', file, {
        width: evenFloor(display.w), height: evenFloor(display.h), audio: true, syncAv: true, minSeconds: 4.2, maxSeconds: 20
      })
      const i = info(file)
      const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(i)
      const seconds = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0
      check('Paused and resumed: the timer on the bar matches the length of the video', Math.abs(seconds - finalElapsed) < 2.5, `timer ${finalElapsed.toFixed(1)}s, video ${seconds.toFixed(1)}s`)
      check('Paused and resumed: the time spent paused is not in the video', seconds < wall - 4, `${seconds.toFixed(1)}s of video from ${wall.toFixed(1)}s on the clock`)
      const tail = maxVolumeTail(file, 3)
      check('Paused and resumed: sound carries on after the last Resume (not just before the first pause)', tail > -60, `peak ${tail} dB in the last 3 s`)
      check('Paused and resumed: one video stream and one audio stream (no leftovers from the pieces)',
        (i.match(/Stream #.*Video:/g) || []).length === 1 && (i.match(/Stream #.*Audio:/g) || []).length === 1)
      check('Paused and resumed: no loose pieces left in the working folder', !fs.readdirSync(path.join(userData, 'pending')).some((n) => /\.recording\d*\.mp4$|\.pieces\.txt$/.test(n)), fs.readdirSync(path.join(userData, 'pending')).join(', '))
      log('paused at', pauseLog.map((p) => `${p.pausedAt.toFixed(1)}s`).join(', '))
    }

    // 1c) Stop while paused → everything recorded so far is kept
    if (only('pause')) {
      const { editor } = await record(app, main, 'pause-stop', { seconds: 2.5, pauses: [{ via: 'bar', hold: 1.5, stopWhilePaused: true }] })
      const file = await save(app, editor, 'e2e-pause-stop')
      validate('Stopped while paused', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 1.5, maxSeconds: 6 })
    }

    // 1d) Recording the webcam together with the screen (the test camera stands in for a real one)
    if (only('camera')) {
      await main.click('#tab-record')
      await setSettings(main, { camera: false })
      check('Camera: the main section has a Camera button, off to begin with', (await main.getAttribute('#pill-camera', 'aria-pressed')) === 'false' && (await main.isHidden('#camera-row')))
      await main.click('#pill-camera')
      await main.waitForSelector('#camera-row:not([hidden])', { timeout: 10000 })
      await main.waitForSelector('#cam-live:not([hidden])', { timeout: 20000 }).catch(() => undefined)
      const choices = await main.locator('#camera-select option').count()
      check('Camera: turning it on shows a picker and a live preview', (await main.isVisible('#cam-live')) && choices >= 2, `${choices} choices`)
      check('Camera: the choice is remembered', (await main.evaluate(() => window.api.getSettings())).camera === true)
      await shot(main, 'panel-camera')
      await setSettings(main, { camera: true })
      const { editor, pauseLog } = await record(app, main, 'camera', {
        seconds: 2.5,
        pauses: [{ via: 'api', hold: 1.5, then: 2 }],
        // you can see yourself while recording, in a window that is kept out of the recording
        during: async () => {
          const view = await waitForWindow(app, 'selfview.html', 15000).catch(() => null)
          const info = view && (await app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('selfview.html'))
            return w ? { visible: w.isVisible(), top: w.isAlwaysOnTop(), handle: w.getNativeWindowHandle().length === 8 ? w.getNativeWindowHandle().readBigUInt64LE(0).toString() : '0' } : null
          }))
          check('Camera: while recording, you can see yourself in a small window', !!info && info.visible && info.top, JSON.stringify(info))
          if (view) {
            await sleep(1200)
            check('Camera: and it shows the live picture', await view.evaluate(() => { const v = document.getElementById('v'); return !!v && v.readyState >= 2 && v.videoWidth > 0 }))
            if (isWin) {
              const a = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'affinity.ps1'), '-Handle', info.handle], { encoding: 'utf8', timeout: 60000 })
              check('Camera: Windows is asked to keep that window out of the recording', a.status === 0, `${a.stdout || ''}${a.stderr || ''}`.trim().slice(0, 160))
            }
          }
        }
      })
      check('Camera: the self-view window is gone once recording has stopped', !app.windows().some((p) => !p.isClosed() && p.url().includes('selfview.html')))
      const pend = fs.readdirSync(path.join(userData, 'pending'))
      const cam = pend.find((f) => /\.camera\.mp4$/.test(f))
      const note = pend.find((f) => /\.camera\.json$/.test(f))
      check('Camera: the picture from the camera was saved next to the recording', !!cam && !!note && !pend.some((f) => /\.camera\.webm$/.test(f)), pend.join(', '))
      if (cam && note) {
        const camPath = path.join(userData, 'pending', cam)
        const i = info(camPath)
        check('Camera: it is a normal H.264 video, with the voice kept in the same file', /Video: h264/.test(i) && /Audio: aac/.test(i), (/Video: .*/.exec(i) || [''])[0].slice(0, 80))
        const dur = (f) => { const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info(f)); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0 }
        const screen = path.join(userData, 'pending', cam.replace('.camera.mp4', '.mp4'))
        check('Camera: it is as long as the screen recording (the pause is left out of both)', Math.abs(dur(camPath) - dur(screen)) < 3.5, `camera ${dur(camPath).toFixed(2)}s, screen ${dur(screen).toFixed(2)}s`)
        const meta = JSON.parse(fs.readFileSync(path.join(userData, 'pending', note), 'utf8'))
        check('Camera: how it lines up with the screen was worked out', Number.isFinite(meta.offset) && Math.abs(meta.offset) < 4 && /voice|clock/.test(meta.method), JSON.stringify(meta))
        check('Camera: its picture is not blank', (() => { const r = ff(['-hide_banner', '-i', camPath, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YDIF', '-f', 'null', '-']); return /YDIF/.test(r.stderr) || fullDecode(camPath).ok })())
      }
      const src = await editor.evaluate(() => window.editor.load())
      check('Camera: the review window knows which sounds the recording holds', !!src.source?.tracks && (src.source.tracks.pc || src.source.tracks.mic), JSON.stringify(src.source?.tracks ?? null))
      check('Camera: the review window is told about it', !!src.source?.camera && src.source.camera.info.duration > 1, JSON.stringify(src.source?.camera ?? null))

      // ---- in the editor ----
      const T = 'Camera editor'
      await editor.evaluate(() => window.__editor.store.seek(1))
      await sleep(900)
      const camClip = () => editor.evaluate(() => window.__editor.store.project.clips.find((c) => c.media === 'camera') ?? null)
      const recClip = () => editor.evaluate(() => window.__editor.store.project.clips.find((c) => c.kind === 'recording') ?? null)
      const camId = (await camClip())?.id
      const recId = (await recClip())?.id
      const geom = () => editor.evaluate((id) => {
        const v = document.querySelector(`#pips [data-layer="${id}"]`)
        if (!v) return null
        const fr = document.getElementById('frame').getBoundingClientRect()
        const r = v.getBoundingClientRect()
        const cs = getComputedStyle(v)
        return { shown: cs.display !== 'none', w: r.width / fr.width, h: r.height / fr.height, x: (r.left - fr.left) / fr.width, y: (r.top - fr.top) / fr.height, radius: cs.borderTopLeftRadius, fw: fr.width, fh: fr.height }
      }, camId)
      let g = await geom()
      check(`${T}: your face camera is on the video by itself`, !!g && g.shown, JSON.stringify(g))
      check(`${T}: it is a round window, square in shape`, !!g && Math.abs(g.w * g.fw - g.h * g.fh) < 3 && parseFloat(g.radius) > 20, JSON.stringify(g))
      check(`${T}: it has a row of its own in the timeline, separate from the screen recording`, (await editor.locator('.tl-label', { hasText: 'Face cam' }).count()) === 1 && (await editor.locator('.tl-track.video').count()) === 2 && !!camId && !!recId && camId !== recId)
      check(`${T}: the camera and the screen recording are two pieces on two different tracks`, (await camClip()).track !== (await recClip()).track)
      // click it on the video to change it
      const fb = await editor.locator('#frame').boundingBox()
      await editor.mouse.click(fb.x + (g.x + g.w / 2) * fb.width, fb.y + (g.y + g.h / 2) * fb.height)
      await editor.waitForSelector('#prop-shape', { timeout: 5000 })
      check(`${T}: clicking it opens its settings and shows its handles`, (await editor.isVisible('#prop-box-w')) && (await editor.isVisible('#sel i.h-se')) && (await editor.evaluate(() => window.__editor.store.selection?.kind)) === 'clip')
      await editor.click('#prop-shape [data-shape="rounded"]')
      await editor.locator('#prop-box-w').fill('0.3')
      await editor.selectOption('#prop-box-corner', 'top-left')
      let st = await editorState(editor)
      const cam0 = await camClip()
      check(`${T}: shape, size and corner can be changed`, cam0.shape === 'rounded' && Math.abs(cam0.box.w - 0.3) < 0.01 && cam0.box.x < 0.05 && cam0.box.y < 0.08, JSON.stringify({ shape: cam0.shape, box: cam0.box }))
      // drag it somewhere else on the video (let the preview settle after the changes above first)
      await sleep(400)
      g = await geom()
      { const fb2 = await editor.locator('#frame').boundingBox(); fb.x = fb2.x; fb.y = fb2.y; fb.width = fb2.width; fb.height = fb2.height }
      await editor.mouse.move(fb.x + (g.x + g.w / 2) * fb.width, fb.y + (g.y + g.h / 2) * fb.height)
      await editor.mouse.down()
      await sleep(120)
      await editor.mouse.move(fb.x + (g.x + g.w / 2) * fb.width + fb.width * 0.35, fb.y + (g.y + g.h / 2) * fb.height + fb.height * 0.25, { steps: 8 })
      await editor.mouse.up()
      const moved = await camClip()
      check(`${T}: it can be dragged to a new place`, moved.box.x - cam0.box.x > 0.25 && moved.box.y - cam0.box.y > 0.15, `x ${cam0.box.x.toFixed(2)}→${moved.box.x.toFixed(2)}`)
      // its start can be typed exactly (a camera that runs a little late can be moved a hair earlier)
      await editor.locator('#prop-start').fill('0.2')
      await editor.locator('#prop-start').press('Tab')
      check(`${T}: the camera can be started a moment later or earlier on its own`, Math.abs((await camClip()).start - 0.2) < 0.01 && Math.abs((await recClip()).start) < 0.01)
      await editor.locator('#prop-start').fill('0')
      await editor.locator('#prop-start').press('Tab')
      const camNow = await camClip()
      log(`camera: file has sound ${camNow.hasAudio}`)
      if (camNow.hasAudio) {
        check(`${T}: the webcam's own sound is used by default, so voice and lips are one recording`, camNow.hasAudio === true && (await editor.isChecked('#prop-cam-voice')))
        await editor.uncheck('#prop-cam-voice')
        check(`${T}: the voice can be switched back to the screen recording's microphone`, (await camClip()).hasAudio === false && ((await recClip()).audioSource ?? 'mix') === 'mix')
        await editor.check('#prop-cam-voice')
        check(`${T}: and to the webcam again`, (await camClip()).hasAudio === true && (await recClip()).audioSource !== 'mix')
      }
      // the two are separate pieces: cutting the screen recording by itself leaves the camera alone; a ripple delete cuts both
      const D = (await editorState(editor)).duration
      await editor.click(`.blk.clip[data-clip="${recId}"]`)
      await editor.evaluate((t) => window.__editor.store.seek(t), D * 0.4)
      await editor.click('#split')
      const afterSplit = await editor.evaluate(() => window.__editor.store.project.clips.map((c) => c.media))
      check(`${T}: splitting the screen recording leaves the camera whole`, afterSplit.filter((m) => m === 'recording').length === 2 && afterSplit.filter((m) => m === 'camera').length === 1, JSON.stringify(afterSplit))
      await editor.click(`.blk.clip[data-clip="${recId}"]`)
      await editor.click('#delete-sel')
      const after = await editorState(editor)
      const camAfter = await camClip()
      check(`${T}: deleting that part (closing the gap) takes it out of the camera too`, after.duration < D - 0.5 && !!camAfter && camAfter.out - camAfter.in < camNow.out - camNow.in - 0.5, `${D.toFixed(1)}→${after.duration.toFixed(1)}s`)
      await editor.click('#undo')
      await editor.click('#undo')
      // put it in the bottom right, round, and save
      await editor.click(`.blk.clip[data-clip="${camId}"]`)
      await editor.click('#prop-shape [data-shape="circle"]')
      await editor.locator('#prop-box-w').fill('0.3')
      await editor.selectOption('#prop-box-corner', 'bottom-right')
      await editor.locator('#prop-start').fill('0')
      await editor.locator('#prop-start').press('Tab')
      // hide just the camera picture for a stretch, later in the recording
      check(`${T}: the camera has a "Show over time" graph`, await editor.isVisible('#lvl-clip-show-graph'))
      const Dcam = (await editorState(editor)).duration
      await editor.evaluate((t) => window.__editor.store.seek(t), Dcam * 0.6)
      await editor.click('#lvl-clip-show-dip')
      const showEnv = (await camClip()).showEnv
      const hiddenAt = (showEnv ?? []).filter((q) => q.v < 0.2)
      check(`${T}: "Dip here" makes the camera fade out and come back`, !!showEnv && showEnv.length === 4 && hiddenAt.length === 2, JSON.stringify(showEnv))
      check(`${T}: the line shows on the camera's bar in the timeline`, (await editor.locator(`.blk.clip[data-clip="${camId}"] svg.lvl-tl`).count()) >= 1)
      await shot(editor, 'editor-camera')
      st = await editorState(editor)
      const screenCopy = path.join(userData, 'screen-copy.mp4')
      const pendingScreen = fs.readdirSync(path.join(userData, 'pending')).find((f) => /^Recording .*\d\.mp4$/.test(f))
      fs.copyFileSync(path.join(userData, 'pending', pendingScreen), screenCopy)
      const finalCam = { ...(await camClip()).box }
      const out = await save(app, editor, 'e2e-camera')
      validate('Saved with the face camera', out, { width: st.out.width, height: st.out.height, audio: true, minSeconds: 3 })
      const W = st.out.width, H = st.out.height
      const side = finalCam.w * W
      const cx = finalCam.x * W + side / 2, cy = finalCam.y * H + side / 2
      const t = 1.2
      const inCam = pixelAt(out, t, cx, cy, W, H)
      const inScreen = pixelAt(screenCopy, t, cx, cy, W, H)
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      check(`${T}: the camera's picture is in the saved video, where it was placed`, !!inCam && !!inScreen && dist(inCam, inScreen) > 50, `video ${inCam} vs screen ${inScreen}`)
      const cornerOut = pixelAt(out, t, finalCam.x * W + side * 0.03, finalCam.y * H + side * 0.03, W, H)
      const cornerScreen = pixelAt(screenCopy, t, finalCam.x * W + side * 0.03, finalCam.y * H + side * 0.03, W, H)
      check(`${T}: a round window leaves the square's corner showing the screen`, !!cornerOut && dist(cornerOut, cornerScreen) < 40, `video ${cornerOut} vs screen ${cornerScreen}`)
      const elsewhere = pixelAt(out, t, W * 0.1, H * 0.5, W, H)
      const elsewhereScreen = pixelAt(screenCopy, t, W * 0.1, H * 0.5, W, H)
      check(`${T}: the rest of the screen is untouched`, !!elsewhere && dist(elsewhere, elsewhereScreen) < 40, `video ${elsewhere} vs screen ${elsewhereScreen}`)
      // (what the picture looks like while the camera is faded is checked pixel by pixel in test/project-export.test.ts; a screen recording
      // keeps changing, so comparing it here with the original would be unreliable)
      check(`${T}: its files are cleaned up once saved`, !fs.readdirSync(path.join(userData, 'pending')).some((f) => /camera/.test(f)))
      await setSettings(main, { camera: false })
    }

    // 2) The editor, used the way a person uses it: cut, comment, shapes, media, music, title card, brand, crop → save
    if (only('edit')) {
      const { editor } = await record(app, main, 'edit', { seconds: 6 })
      await editorSuite({
        app, editor, main, check, warn, log, sleep, userData, ff, FFMPEG, save, validate, seekTo, editorState, answerPicker, pixelAt, nearColour,
        cutFirstThird, isWin, shot
      })
    }

    // 3) Studio (4:4:4) → "Make it play everywhere" (ticked by default) → standard 4:2:0
    if (only('studio')) {
      await setSettings(main, { quality: 'studio' })
      const { editor, infoLine } = await record(app, main, 'studio', { seconds: 3 })
      check('Studio: recorded as 4:4:4', /4:4:4/.test(infoLine), infoLine)
      const ticked = await editor.isChecked('#compat')
      check('Studio: "make it play everywhere" is ticked by default', ticked)
      const file = await save(app, editor, 'e2e-studio-converted')
      validate('Studio converted', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 2 })
      await setSettings(main, { quality: 'maximum' })
    }

    // 4) Region covering the top of the screen: the bar must move out of the recorded area, so it
    //    can't be in the video no matter what the capture method does with window exclusion.
    if (only('region')) {
      const region = { fractions: { x1: 0.02, y1: 0.03, x2: 0.98, y2: 0.55 } }
      const { editor, barBounds } = await record(app, main, 'region', { seconds: 3, region })
      const e = region.expected
      const rect = { x: e.x, y: e.y, width: e.w, height: e.h }
      const overlaps = barBounds.x < rect.x + rect.width && barBounds.x + barBounds.width > rect.x &&
        barBounds.y < rect.y + rect.height && barBounds.y + barBounds.height > rect.y
      check('Region: recording bar moved outside the recorded area', !overlaps, `bar ${JSON.stringify(barBounds)} vs region ${JSON.stringify(rect)}`)
      const file = await save(app, editor, 'e2e-region')
      validate('Region', file, { width: evenFloor(Math.round(e.w * display.f)), height: evenFloor(Math.round(e.h * display.f)), audio: true, minSeconds: 2 })
      const full = { x: 0, y: 0, w: evenFloor(Math.round(e.w * display.f)), h: evenFloor(Math.round(e.h * display.f)) }
      const origin = { ox: Math.round(e.x * display.f), oy: Math.round(e.y * display.f) }
      const samples = [0.2, 1, 2, 3].map((t) => ({ t, ...redPixels(file, t, full, desktop && { ...desktop, ...origin }) }))
      log('red pixels over time:', JSON.stringify(samples))
      check('Region: no recording-bar or countdown UI anywhere in the video', !samples.some((x) => x.ui), `red pixels over time ${JSON.stringify(samples)}`)
    }

    // 5) Other quality/frame-rate settings also produce playable files
    if (only('quality')) {
      await setSettings(main, { quality: 'veryhigh', fps: 30 })
      const { editor } = await record(app, main, 'veryhigh30', { seconds: 4 })
      const file = await save(app, editor, 'e2e-veryhigh-30fps')
      validate('Very high 30 fps', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 3, fps: 30 })
      await setSettings(main, { quality: 'maximum', fps: 60 })
    }

    // 6) A longer recording: stays in sync and stops cleanly
    if (only('long')) {
      const { editor } = await record(app, main, 'long', { seconds: 30 })
      const file = await save(app, editor, 'e2e-long')
      validate('Long recording (30 s)', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 29, maxSeconds: 45, fps: 60, syncAv: true })
    }

    // 7) Save as… writes to the chosen path
    if (only('saveas')) {
      const target = path.join(outDir, 'chosen-elsewhere.mp4')
      await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }) }, target)
      const { editor } = await record(app, main, 'saveas', { seconds: 3 })
      await editor.fill('#name', 'ignored-name')
      await editor.click('#save-as')
      await finishSaved(app, editor, 120000)
      validate('Save as', target, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 2 })
    }

    // 8) Discard deletes the recording and leaves nothing to review
    if (only('discard')) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      const { editor } = await record(app, main, 'discard', { seconds: 3 })
      await editor.click('#discard', { noWaitAfter: true }).catch(() => undefined)
      await waitGone(app, 'editor.html', 30000)
      const st = await main.evaluate(() => window.api.getStatus())
      const left = fs.readdirSync(path.join(userData, 'pending')).filter((f) => /\.mp4$/i.test(f))
      check('Discard: recording deleted and nothing left to review', !st.pending && left.length === 0, `pending=${st.pending}, files=${left.join(',')}`)
      check('Discard: nothing was saved to the output folder', !fs.existsSync(path.join(outDir, 'Recording discard.mp4')))
    }

    // 8b) Speed, the preview of the finished video, and carrying on editing after a save
    if (only('speed')) {
      const { editor } = await record(app, main, 'speed', { seconds: 6 })
      const opts = await editor.$$eval('#speed option', (o) => o.map((x) => x.value))
      check('Speed: the save bar offers speeds, with 1× chosen', opts.includes('0.5') && opts.includes('2') && (await editor.inputValue('#speed')) === '1', opts.join(','))
      const before = (await editorState(editor)).duration
      await editor.selectOption('#speed', '2')
      check('Speed: choosing 2× is remembered by the project', (await editor.evaluate(() => window.__editor.store.project.speed)) === 2)

      // preview the finished video before saving
      await editor.click('#preview-final')
      await editor.waitForSelector('#pv:not([hidden])', { timeout: 180000 })
      const pvDur = await editor.evaluate(() => new Promise((res) => {
        const v = document.getElementById('pv-video')
        const done = () => res(v.duration)
        if (v.readyState >= 1) done()
        else v.addEventListener('loadedmetadata', done, { once: true })
        setTimeout(() => res(v.duration || 0), 20000)
      }))
      check('Preview: the finished video can be watched before saving, at its sped-up length', Math.abs(pvDur - before / 2) < 1, `${Number(pvDur).toFixed(2)} s vs ${(before / 2).toFixed(2)} s`)
      await editor.click('#pv-close')
      check('Preview: "Back to editing" returns to the editor', await editor.isHidden('#pv'))

      await editor.fill('#name', 'e2e-speed')
      await editor.click('#save')
      await editor.waitForSelector('#saved:not([hidden])', { timeout: 180000 })
      const out = path.join(outDir, 'e2e-speed.mp4')
      const secs = (() => { const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info(out)); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0 })()
      check('Speed: the saved video is half as long at 2×', Math.abs(secs - before / 2) < 0.8, `${secs.toFixed(2)} s vs ${(before / 2).toFixed(2)} s`)
      validate('Saved at double speed', out, { audio: true, minSeconds: before / 2 - 0.8, maxSeconds: before / 2 + 0.8 })
      check('Keep editing: the editor is still open after saving', !editor.isClosed() && (await editor.isVisible('#saved')))
      // carry on: back to normal speed, save again as another file
      await editor.click('#saved-keep')
      check('Keep editing: "Keep editing" closes the message and the editor can still be used', (await editor.isHidden('#saved')) && (await editor.isEnabled('#save')))
      await editor.selectOption('#speed', '1')
      await editor.fill('#name', 'e2e-speed-again')
      await editor.click('#save')
      await editor.waitForSelector('#saved:not([hidden])', { timeout: 180000 })
      const out2 = path.join(outDir, 'e2e-speed-again.mp4')
      const secs2 = (() => { const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info(out2)); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0 })()
      check('Keep editing: a second save from the same recording works (normal speed this time)', Math.abs(secs2 - before) < 0.8 && fs.existsSync(out), `${secs2.toFixed(2)} s vs ${before.toFixed(2)} s`)
      await editor.click('#saved-finish', { noWaitAfter: true })
      await waitGone(app, 'editor.html', 60000)
      const left = fs.readdirSync(path.join(userData, 'pending')).filter((f) => /\.mp4$/i.test(f))
      check('Keep editing: Finish removes the recording and leaves the saved videos', left.length === 0 && fs.existsSync(out) && fs.existsSync(out2), left.join(','))
    }

    // 9) Other save formats: the default stays MP4 · H.264; everything else warns, and really converts
    if (only('formats')) {
      log('--- save formats ---')
      const caps = await main.evaluate(() => window.api.getCapabilities())
      log('video formats this FFmpeg can write:', caps.videoFormats.join(', '), '| images:', caps.imageFormats.join(', '))
      for (const f of ['mp4', 'mkv', 'mov', 'gif']) check(`Format "${f}" is available`, caps.videoFormats.includes(f))
      for (const f of ['hevc', 'webm']) if (!caps.videoFormats.includes(f)) warn(`Format "${f}" not offered by this FFmpeg build`, 'skipped')
      const W = evenFloor(display.w), H = evenFloor(display.h)

      // A) default is MP4 · H.264 and shows no warning; a different pick shows one; "Use MP4" undoes it
      {
        const { editor } = await record(app, main, 'fmt-default', { seconds: 3 })
        const options = await editor.$$eval('#format option', (o) => o.map((x) => x.value))
        check('Format: MP4 · H.264 is first in the list and selected', options[0] === 'mp4' && (await editor.inputValue('#format')) === 'mp4', options.join(','))
        check('Format: the recommended format shows no warning', await editor.isHidden('#format-notice'))
        await editor.selectOption('#format', 'mkv')
        const text = await editor.textContent('#format-notice')
        check('Format: picking another format shows a risk notice', (await editor.isVisible('#format-notice')) && /MKV/.test(text) && /not sure/.test(text), text.slice(0, 120))
        check('Format: the file extension follows the format', (await editor.textContent('#ext')) === '.mkv')
        await editor.selectOption('#format', 'gif')
        check('Format: GIF gets the strongest warning', /\bbad\b/.test(await editor.getAttribute('#format-notice', 'class')) && /GIF loses a lot/.test(await editor.textContent('#format-notice')))
        await editor.click('#use-default')
        check('Format: "Use MP4 (recommended)" puts it back and hides the notice', (await editor.inputValue('#format')) === 'mp4' && (await editor.isHidden('#format-notice')) && (await editor.textContent('#ext')) === '.mp4')
        await editor.selectOption('#format', 'mkv')
        await editor.fill('#name', 'e2e-format-mkv')
        await editor.click('#save')
        await finishSaved(app, editor, 180000)
        validateOther('MKV (re-wrapped, not re-encoded)', path.join(outDir, 'e2e-format-mkv.mkv'),
          { container: /matroska/, video: /^h264 \(High\)/, audio: /aac/, width: W, height: H, min: 2, max: 12 })
      }

      // B) the default can be changed in Settings; MOV with a trim goes through the re-encode path
      {
        await main.click('#tab-record')
        await main.click('#settings-toggle')
        await main.waitForSelector('#settings-wrap:not([hidden])')
        await main.selectOption('#video-format', 'mov')
        await sleep(300)
        const hint = await main.textContent('#video-format-hint')
        check('Settings: choosing a non-default video format shows its warning', /MOV may not open everywhere/.test(hint), hint.slice(0, 100))
        check('Settings: default video format is saved', (await main.evaluate(() => window.api.getSettings())).videoFormat === 'mov')
        await main.click('#settings-toggle')
        await setSettings(main, { videoFormat: 'mov' }) // the helper rewrites every setting, so keep the one just chosen in the UI
        const { editor } = await record(app, main, 'fmt-mov', { seconds: 4 })
        check('Format: the Settings default is pre-selected in the review window', (await editor.inputValue('#format')) === 'mov' && (await editor.textContent('#ext')) === '.mov')
        await cutFirstThird(editor)
        await editor.fill('#name', 'e2e-format-mov')
        await editor.click('#save')
        await finishSaved(app, editor, 180000)
        validateOther('MOV (trimmed, re-encoded)', path.join(outDir, 'e2e-format-mov.mov'),
          { container: /mov,mp4/, video: /^h264 \(High\)/, audio: /aac/, width: W, height: H, min: 1, max: 5 })
        check('MOV: starts instantly (moov before mdat)', isFaststart(path.join(outDir, 'e2e-format-mov.mov')))
        await setSettings(main, { videoFormat: 'mp4' })
      }

      // C) H.265, WebM and GIF always convert
      const converting = [
        ['hevc', 'H.265', { container: /mov,mp4/, video: /^hevc/, audio: /aac/, width: W, height: H, min: 2, max: 12 }, 'mp4'],
        ['webm', 'WebM VP9', { container: /matroska,webm/, video: /^vp9/, audio: /opus/, width: W, height: H, min: 2, max: 12 }, 'webm'],
        ['gif', 'GIF', { container: /gif/, video: /^gif/, audio: null, maxWidth: 1280, min: 2, max: 12 }, 'gif']
      ]
      for (const [id, name, want, ext] of converting) {
        if (!caps.videoFormats.includes(id)) continue
        const { editor } = await record(app, main, `fmt-${id}`, { seconds: 3 })
        await editor.selectOption('#format', id)
        check(`Format: ${name} shows its notice`, await editor.isVisible('#format-notice'), (await editor.textContent('#format-notice')).slice(0, 100))
        await editor.fill('#name', `e2e-format-${id}`)
        await editor.click('#save')
        await finishSaved(app, editor, 300000)
        validateOther(`${name} (converted)`, path.join(outDir, `e2e-format-${id}.${ext}`), want)
      }
    }

    // 11) Screenshots
    if (only('screenshots')) {
      log('--- screenshots ---')
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      fs.mkdirSync(shotDir, { recursive: true })
      const imgDims = (img) => `${img.width}×${img.height}`

      // A) whole screen → exact pixels, no app UI in it, nothing saved until approved
      {
        const { review } = await snap(app, main, 'shot-whole')
        const infoLine = await review.textContent('#info')
        check('Screenshot: the picture is the full screen at real pixel size', infoLine.startsWith(`${display.w} × ${display.h} px`), infoLine)
        check('Screenshot: back to idle once the picture is taken', await idleNow(main))
        check('Screenshot: nothing is saved before you approve', fs.readdirSync(shotDir).length === 0, fs.readdirSync(shotDir).join(','))
        check('Screenshot: PNG is selected and described as lossless, with no warning', (await review.inputValue('#format')) === 'png' && /\binfo\b/.test(await review.getAttribute('#format-notice', 'class')) && (await review.isHidden('#use-default')))
        const defName = await review.inputValue('#name')
        check('Screenshot: default name is "Screenshot <date> <time>"', /^Screenshot \d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/.test(defName), defName)
        await review.fill('#name', 'e2e-shot-whole')
        await review.click('#save')
        await waitGone(app, 'shot.html', 60000)
        const f = shotFile('e2e-shot-whole')
        check('Screenshot: file saved in the screenshots folder', fs.existsSync(f), f)
        if (fs.existsSync(f)) {
          const img = decodeImage(f)
          check('Screenshot: saved as PNG at the full screen size', img.codec === 'png' && img.width === display.w && img.height === display.h, imgDims(img))
          if (desktop) {
            const d = diffFromDesktop(img, desktop, 0, 0)
            check('Screenshot: none of the app\'s own windows are in the picture', d < 0.02, `${(d * 100).toFixed(2)}% of pixels differ from the bare desktop`)
          }
        }
        await main.waitForSelector('#last-shot:not([hidden])', { timeout: 10000 }).then(() => check('Screenshot: "Last saved" shows it in the panel', true), () => check('Screenshot: "Last saved" shows it in the panel', false))
      }

      // B) select a region on the frozen screen
      {
        const region = { fractions: { x1: 0.1, y1: 0.15, x2: 0.6, y2: 0.6 } }
        const { review, expected: e } = await snap(app, main, 'shot-region', { region })
        const wantW = Math.round(e.w * display.f), wantH = Math.round(e.h * display.f)
        const infoLine = await review.textContent('#info')
        check('Screenshot: region picture is exactly the selected size', infoLine.startsWith(`${wantW} × ${wantH} px`), `${infoLine} (wanted ${wantW}×${wantH})`)
        await review.fill('#name', 'e2e-shot-region')
        await review.click('#save')
        await waitGone(app, 'shot.html', 60000)
        const img = decodeImage(shotFile('e2e-shot-region'))
        check('Screenshot: region PNG has the selected pixel size', img.width === wantW && img.height === wantH, imgDims(img))
        if (desktop) {
          const d = diffFromDesktop(img, desktop, Math.round(e.x * display.f), Math.round(e.y * display.f))
          check('Screenshot: the region matches that part of the real screen', d < 0.02, `${(d * 100).toFixed(2)}% of pixels differ`)
        }
      }

      // C) draw, undo/redo, crop → everything is burned into the saved picture
      {
        const { review, expected: ed } = await snap(app, main, 'shot-edit', { region: { fractions: { x1: 0.05, y1: 0.05, x2: 0.85, y2: 0.85 } } })
        const before = await review.textContent('#info')
        const dims = /(\d+) × (\d+) px/.exec(before)
        await review.click('#t-pen')
        check('Screenshot editor: Pen tool is selected', (await review.getAttribute('#t-pen', 'aria-pressed')) === 'true')
        await dragOnCanvas(review, [0.2, 0.2], [0.6, 0.4])
        check('Screenshot editor: drawing marks the picture as edited', /edited/.test(await review.textContent('#info')) && !(await review.isDisabled('#undo')))
        await review.click('#t-arrow')
        await dragOnCanvas(review, [0.25, 0.6], [0.55, 0.5])
        await review.click('#t-hl')
        await dragOnCanvas(review, [0.15, 0.3], [0.5, 0.3])
        await review.click('#t-text')
        const cv = await review.locator('#view').boundingBox()
        await review.mouse.click(cv.x + cv.width * 0.3, cv.y + cv.height * 0.12)
        await review.keyboard.type('Hello')
        await review.keyboard.press('Enter')
        await review.click('#undo')
        check('Screenshot editor: Undo takes back the last mark, Redo restores it', !(await review.isDisabled('#redo')))
        await review.click('#redo')
        check('Screenshot editor: Redo is used up again', await review.isDisabled('#redo'))
        // crop: pull the bottom-right corner in. First let the window settle, then make sure starting a crop doesn't move the picture.
        const picWidth = () => review.evaluate(() => document.getElementById('view').getBoundingClientRect().width)
        await sleep(900)
        const widthBefore = await picWidth()
        await review.click('#t-crop')
        check('Screenshot editor: Crop shows its own buttons', await review.isVisible('#crop-apply'))
        await sleep(700)
        const widthAfter = await picWidth()
        check('Screenshot editor: starting a crop does not make the picture jump around', Math.abs(widthAfter - widthBefore) < 1, `${widthBefore} → ${widthAfter}`)
        const h = await review.locator('#crop-box i[data-h=se]').boundingBox()
        await review.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
        await review.mouse.down()
        await review.mouse.move(h.x + h.width / 2 - cv.width * 0.2, h.y + h.height / 2 - cv.height * 0.2, { steps: 6 })
        await review.mouse.up()
        await review.click('#crop-apply')
        const after = await review.textContent('#info')
        const nd = /(\d+) × (\d+) px/.exec(after)
        check('Screenshot editor: Crop makes the picture smaller', +nd[1] < +dims[1] * 0.9 && +nd[2] < +dims[2] * 0.9, `${dims[1]}×${dims[2]} → ${nd[1]}×${nd[2]}`)
        await review.fill('#name', 'e2e-shot-edit')
        await review.click('#save')
        await waitGone(app, 'shot.html', 60000)
        const img = decodeImage(shotFile('e2e-shot-edit'))
        check('Screenshot editor: saved picture has the cropped size', img.width === +nd[1] && img.height === +nd[2], `${imgDims(img)} (wanted ${nd[1]}×${nd[2]})`)
        // red marks (pen + arrow) that were not already on the bare desktop; the crop kept the top-left corner of the region
        let red = 0
        const isRed = (b, i) => Math.abs(b[i] - 239) < 30 && Math.abs(b[i + 1] - 68) < 30 && Math.abs(b[i + 2] - 68) < 30
        const ox = Math.round(ed.x * display.f), oy = Math.round(ed.y * display.f)
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            if (!isRed(img.rgb, (y * img.width + x) * 3)) continue
            if (desktop && isRed(desktop.buf, ((y + oy) * desktop.w + (x + ox)) * 3)) continue
            red++
          }
        }
        check('Screenshot editor: pen and arrow marks are in the saved picture', red > 800, `${red} red pixels`)
      }

      // D) other image formats warn, and really convert
      for (const [id, ext, codec, maxDiff] of [['webp', 'webp', 'webp', 0.02], ['jpeg', 'jpg', 'mjpeg', 0.03]]) {
        if (!(await main.evaluate(() => window.api.getCapabilities())).imageFormats.includes(id)) { warn(`Image format "${id}" not offered by this FFmpeg build`, 'skipped'); continue }
        const { review } = await snap(app, main, `shot-${id}`)
        await review.selectOption('#format', id)
        const note = await review.textContent('#format-notice')
        check(`Screenshot: ${id.toUpperCase()} shows a risk notice with a way back to PNG`, /not sure/.test(note) && (await review.isVisible('#use-default')) && /\bnotice\b/.test(await review.getAttribute('#format-notice', 'class')), note.slice(0, 100))
        check(`Screenshot: file extension follows the format`, (await review.textContent('#ext')) === `.${ext}`)
        if (id === 'webp') {
          await review.click('#use-default')
          check('Screenshot: "Use PNG (recommended)" puts it back', (await review.inputValue('#format')) === 'png' && (await review.isHidden('#use-default')))
          await review.selectOption('#format', id)
        }
        await review.fill('#name', `e2e-shot-${id}`)
        await review.click('#save')
        await waitGone(app, 'shot.html', 60000)
        const f = shotFile(`e2e-shot-${id}`, ext)
        check(`Screenshot: ${id.toUpperCase()} file saved`, fs.existsSync(f), f)
        if (fs.existsSync(f)) {
          const img = decodeImage(f)
          check(`Screenshot: ${id.toUpperCase()} has the full screen size and the right codec`, img.codec === codec && img.width === display.w && img.height === display.h, `${img.codec} ${imgDims(img)}`)
          if (desktop) {
            const d = diffFromDesktop(img, desktop, 0, 0)
            check(`Screenshot: ${id.toUpperCase()} matches the real screen`, d < maxDiff, `${(d * 100).toFixed(2)}% differ`)
          }
        }
      }

      // E) clipboard: automatic when switched on, and the Copy button
      {
        await setSettings(main, { shotClipboard: true })
        await app.evaluate(({ clipboard }) => clipboard.clear())
        const { review } = await snap(app, main, 'shot-clipboard')
        const auto = await clipboardSize(app)
        check('Screenshot: "copy as soon as I capture" puts the picture on the clipboard', auto.width === display.w && auto.height === display.h, `${auto.width}×${auto.height}`)
        await setSettings(main, { shotClipboard: false })
        await app.evaluate(({ clipboard }) => clipboard.clear())
        await review.click('#copy')
        await sleep(400)
        const manual = await clipboardSize(app)
        check('Screenshot: the Copy button copies the full-quality picture', manual.width === display.w && manual.height === display.h, `${manual.width}×${manual.height}`)
        const countBefore = fs.readdirSync(shotDir).length
        await review.click('#discard', { noWaitAfter: true }).catch(() => {})
        await waitGone(app, 'shot.html', 30000)
        check('Screenshot: Discard saves nothing', fs.readdirSync(shotDir).length === countBefore)
        check('Screenshot: Discard returns to idle', await idleNow(main))
      }

      // F) Save as… and discarding an edited picture
      {
        const target = path.join(userData, 'elsewhere', 'picked.png')
        await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }) }, target)
        const { review } = await snap(app, main, 'shot-saveas')
        await review.fill('#name', 'ignored-name')
        await review.click('#save-as')
        await waitGone(app, 'shot.html', 60000)
        check('Screenshot: Save as… writes to the chosen path', fs.existsSync(target) && decodeImage(target).width === display.w, target)
        check('Screenshot: Save as… did not also save to the default folder', !fs.existsSync(shotFile('ignored-name')))

        const { review: r2 } = await snap(app, main, 'shot-discard-edited')
        await r2.click('#t-pen')
        await dragOnCanvas(r2, [0.3, 0.3], [0.5, 0.5])
        const count = fs.readdirSync(shotDir).length
        await r2.click('#discard', { noWaitAfter: true }).catch(() => {})
        await waitGone(app, 'shot.html', 30000)
        check('Screenshot: discarding an edited picture (after the confirm) saves nothing', fs.readdirSync(shotDir).length === count)
      }

      // G) Esc cancels the selection and brings the panel back
      {
        log('--- screenshot: cancel ---')
        await setSettings(main, { shotMode: 'region', shotDelay: 0 })
        await main.click('#tab-shot')
        await main.click('#shoot')
        const overlay = await waitForWindow(app, 'overlay.html')
        await overlay.waitForLoadState('domcontentloaded')
        await sleep(500)
        await overlay.keyboard.press('Escape').catch(() => {})
        await waitGone(app, 'overlay.html', 15000)
        await sleep(500)
        const panel = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.isVisible())
        check('Screenshot: Esc cancels, the panel comes back and no review window opens', (await idleNow(main)) && panel === true && !app.windows().some((w) => !w.isClosed() && w.url().includes('shot.html')))
      }

      // H) delay: a countdown, then the picture — without the countdown in it; and it can be cancelled
      {
        const t0 = Date.now()
        const { review } = await snap(app, main, 'shot-delay', { delay: 3 })
        const took = (Date.now() - t0) / 1000
        check('Screenshot: the delay waits before capturing', took >= 2.5, `${took.toFixed(1)}s`)
        await review.fill('#name', 'e2e-shot-delay')
        await review.click('#save')
        await waitGone(app, 'shot.html', 60000)
        if (desktop) {
          const d = diffFromDesktop(decodeImage(shotFile('e2e-shot-delay')), desktop, 0, 0)
          check('Screenshot: the countdown is not in the picture', d < 0.02, `${(d * 100).toFixed(2)}% differ`)
        }
        await setSettings(main, { shotDelay: 5, shotMode: 'fullscreen' })
        await main.click('#shoot')
        await waitForWindow(app, 'countdown.html', 15000)
        check('Screenshot: status shows it is working on a screenshot', (await main.evaluate(() => window.api.getStatus())).state === 'snapping')
        await main.evaluate(() => window.api.takeScreenshot())
        await waitGone(app, 'countdown.html', 15000)
        await sleep(600)
        check('Screenshot: the shortcut/button again cancels a waiting screenshot', (await idleNow(main)) && !app.windows().some((w) => !w.isClosed() && w.url().includes('shot.html')))
        await setSettings(main, { shotDelay: 0 })
        await main.click('#tab-record')
      }
    }

    // 10) Cancel during the countdown leaves nothing behind
    if (only('cancel')) {
      log('--- cancel during countdown ---')
      await setSettings(main, { countdown: 5, mode: 'fullscreen' })
      await main.click('#tab-record')
      await main.click('#record')
      const bar = await waitForWindow(app, 'bar.html')
      await bar.waitForSelector('#cancel:not([hidden])', { timeout: 15000 })
      await bar.click('#cancel')
      await waitGone(app, 'bar.html', 15000)
      const st = await main.evaluate(() => window.api.getStatus())
      const panel = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.isVisible())
      check('Cancel countdown: back to idle with the panel showing', st.state === 'idle' && panel === true, `${st.state}, panel visible: ${panel}`)
      check('Cancel countdown: nothing left to review', !st.pending, String(st.pending))
    }
  } catch (err) {
    failed = true
    log('E2E ERROR:', err.stack || err.message)
    for (const w of app.windows()) {
      const name = path.basename(new URL(w.url()).pathname, '.html')
      await w.screenshot({ path: path.join(RESULTS, `error-${name}.png`) }).catch(() => {})
    }
  } finally {
    await app.close().catch(() => {})
  }

  // Recorder logs (what FFmpeg printed) are the most useful thing when something fails.
  const logs = path.join(userData, 'logs')
  if (fs.existsSync(logs)) {
    for (const f of fs.readdirSync(logs)) {
      fs.copyFileSync(path.join(logs, f), path.join(RESULTS, f))
      console.log(`\n===== ${f} =====\n${fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter((l) => !/^frame=|^fps=|^stream_|^bitrate=|^total_size=|^out_time|^dup_frames|^drop_frames|^speed=|^progress=/.test(l)).join('\n').slice(0, 6000)}`)
    }
  }
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) fs.copyFileSync(path.join(outDir, f), path.join(RESULTS, f))
  if (errors.length) console.log('\nElectron errors:\n' + [...new Set(errors)].slice(0, 15).join('\n'))

  fs.writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(results, null, 2))
  const bad = results.filter((r) => !r.ok)
  const warned = results.filter((r) => r.warn)
  console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed ? ' (run aborted early)' : ''}`)
  warned.forEach((w) => console.log(`  WARNING: ${w.name} — ${w.detail}`))
  bad.forEach((b) => console.log(`  FAILED: ${b.name} — ${b.detail}`))
  process.exit(bad.length || failed ? 1 : 0)
})()
