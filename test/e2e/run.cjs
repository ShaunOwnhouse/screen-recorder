'use strict'
// End-to-end test of the real app: record → review → edit → save, then verify the saved files.
//   node test/e2e/run.cjs "<path to packaged app>"   (packaged build, e.g. dist/win-unpacked/Screen Recorder.exe)
//   node test/e2e/run.cjs                            (runs from source with the local Electron)
// Exits non-zero if anything fails. Results, logs and screenshots land in test-results/e2e/.
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const FFMPEG = require('ffmpeg-static')
const RESULTS = path.join(ROOT, 'test-results', 'e2e')
fs.rmSync(RESULTS, { recursive: true, force: true })
fs.mkdirSync(RESULTS, { recursive: true })

const target = process.argv[2]
const isWin = process.platform === 'win32'
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'))
const outDir = path.join(userData, 'saved')

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
function redPixels(file, at, region) {
  const r = ff(
    ['-hide_banner', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer' }
  )
  const buf = r.stdout
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (Math.abs(buf[i] - 239) < 25 && Math.abs(buf[i + 1] - 68) < 25 && Math.abs(buf[i + 2] - 68) < 25) {
      n++
      const p = i / 3, x = p % region.w, y = Math.floor(p / region.w)
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
  return { count: n, bbox, ui }
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

const SETTINGS = (over) => ({
  outputDir: outDir,
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
async function record(app, main, label, { seconds, region, checkAffinity }) {
  log(`--- recording: ${label} ---`)
  await setSettings(main, { mode: region ? 'region' : 'fullscreen' })
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
  while (Date.now() - t0 < 45000) {
    if (await bar.isVisible('#stop').catch(() => false)) { recording = true; break }
    await sleep(100)
  }
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
  await editor.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 60000 })
    .then(() => check(`${label}: review window can play the video`, true))
    .catch(() => check(`${label}: review window can play the video`, false, 'preview never became ready'))
  await shot(editor, `${label}-editor`)
  return { editor, status: st, infoLine, barBounds, barVisible: barInfo.visible }
}

async function save(app, editor, name) {
  await editor.fill('#name', name)
  await editor.click('#save')
  await waitGone(app, 'editor.html', 180000)
  return path.join(outDir, `${name}.mp4`)
}

;(async () => {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(SETTINGS({})))

  const flags = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${userData}`]
  const launch = target
    ? { executablePath: path.resolve(target), args: flags }
    : { executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', ROOT, ...flags] }
  log('launching', target ? path.resolve(target) : 'Electron from source', '| platform', process.platform)
  const app = await electron.launch({ ...launch, timeout: 120000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
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
    await shot(main, 'panel')

    const display = await app.evaluate(({ screen }) => {
      const d = screen.getPrimaryDisplay()
      return { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), f: d.scaleFactor,
        work: d.workArea }
    })
    log('primary display (physical px):', `${display.w}×${display.h} @${display.f}x`)
    const evenFloor = (n) => Math.floor(n / 2) * 2

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
    {
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
        const found = redPixels(file, 3, region)
        const detail = `${found.count} bright-red pixels, bbox ${JSON.stringify(found.bbox)}, where the bar was (${JSON.stringify(b)}); bar ${barVisible ? 'was shown' : 'was hidden by the app'}`
        check('Maximum whole screen: recording bar is NOT in the video', !found.ui, detail)
      }
      log('recorded with', status.backend, '/', status.encoder)
    }

    // 2) Edit: cut the start, crop to 16:9 → save (re-encoded)
    {
      const { editor } = await record(app, main, 'edit', { seconds: 6 })
      const tl = await editor.locator('#timeline').boundingBox()
      await editor.mouse.move(tl.x + 2, tl.y + 20)
      await editor.mouse.down()
      await editor.mouse.move(tl.x + tl.width * 0.3, tl.y + 20, { steps: 6 })
      await editor.mouse.up()
      await editor.click('#delete-sel')
      await editor.click('#crop-toggle')
      await editor.selectOption('#aspect', '16:9')
      const crop = await editor.textContent('#crop-size')
      const [cw, ch] = crop.split('×').map((s) => parseInt(s.trim(), 10))
      log('editing: cut first 30%, crop', crop)
      const file = await save(app, editor, 'e2e-edited')
      validate('Edited (trim + crop)', file, { width: cw, height: ch, audio: true, minSeconds: 2, maxSeconds: 8 })
    }

    // 3) Studio (4:4:4) → "Make it play everywhere" (ticked by default) → standard 4:2:0
    {
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
    {
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
      const samples = [0.2, 1, 2, 3].map((t) => ({ t, ...redPixels(file, t, full) }))
      log('red pixels over time:', JSON.stringify(samples))
      check('Region: no recording-bar or countdown UI anywhere in the video', !samples.some((x) => x.ui), `red pixels over time ${JSON.stringify(samples)}`)
    }

    // 5) Other quality/frame-rate settings also produce playable files
    {
      await setSettings(main, { quality: 'veryhigh', fps: 30 })
      const { editor } = await record(app, main, 'veryhigh30', { seconds: 4 })
      const file = await save(app, editor, 'e2e-veryhigh-30fps')
      validate('Very high 30 fps', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 3, fps: 30 })
      await setSettings(main, { quality: 'maximum', fps: 60 })
    }

    // 6) A longer recording: stays in sync and stops cleanly
    {
      const { editor } = await record(app, main, 'long', { seconds: 30 })
      const file = await save(app, editor, 'e2e-long')
      validate('Long recording (30 s)', file, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 29, maxSeconds: 45, fps: 60, syncAv: true })
    }

    // 7) Save as… writes to the chosen path
    {
      const target = path.join(outDir, 'chosen-elsewhere.mp4')
      await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }) }, target)
      const { editor } = await record(app, main, 'saveas', { seconds: 3 })
      await editor.fill('#name', 'ignored-name')
      await editor.click('#save-as')
      await waitGone(app, 'editor.html', 120000)
      validate('Save as', target, { width: evenFloor(display.w), height: evenFloor(display.h), audio: true, minSeconds: 2 })
    }

    // 8) Discard deletes the recording and leaves nothing to review
    {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      const { editor } = await record(app, main, 'discard', { seconds: 3 })
      await editor.click('#discard')
      await waitGone(app, 'editor.html', 30000)
      const st = await main.evaluate(() => window.api.getStatus())
      const left = fs.readdirSync(path.join(userData, 'pending')).filter((f) => /\.mp4$/i.test(f))
      check('Discard: recording deleted and nothing left to review', !st.pending && left.length === 0, `pending=${st.pending}, files=${left.join(',')}`)
      check('Discard: nothing was saved to the output folder', !fs.existsSync(path.join(outDir, 'Recording discard.mp4')))
    }

    // 9) The global hotkey is registered
    {
      const hk = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R'))
      check('Global hotkey (Ctrl/Cmd+Shift+R) is registered', hk === true)
    }

    // 10) Cancel during the countdown leaves nothing behind
    {
      log('--- cancel during countdown ---')
      await setSettings(main, { countdown: 5, mode: 'fullscreen' })
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
