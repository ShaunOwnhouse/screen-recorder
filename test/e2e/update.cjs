'use strict'
// Real update test (Windows only): the installed app finds a newer build, downloads it, restarts into it, and keeps its settings.
//   node test/e2e/update.cjs "<path to the Screen-Snap-Setup-<version>.exe just built>" [--github]
// With --github the "newer build" is not served from this computer but hosted on one fixed GitHub release (update-test) and
// downloaded through GitHub's real download links — redirects and partial downloads included — the way installed copies get updates.
// 1. builds a newer installer, 2. serves it as an update feed on this computer, 3. installs the older one silently,
// 4. runs the installed app and waits for the update to download, 5. clicks "Restart to update", 6. waits for the installer
// to replace the program, 7. runs the new version and checks it is the new version, still has the old settings, and is up to date.
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('The update test needs Windows (it installs the real installer). Skipped.')
  process.exit(0)
}

const ROOT = path.resolve(__dirname, '../..')
const GITHUB = process.argv.includes('--github')
const REPO = process.env.GITHUB_REPOSITORY || ''
const RESULTS = path.join(ROOT, 'test-results', GITHUB ? 'update-github' : 'update')
fs.rmSync(RESULTS, { recursive: true, force: true })
fs.mkdirSync(RESULTS, { recursive: true })

const oldInstaller = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || '')
if (!fs.existsSync(oldInstaller)) throw new Error(`installer not found: ${oldInstaller}`)
const OLD = /Setup-(\d+\.\d+\.\d+)\.exe$/.exec(path.basename(oldInstaller))?.[1]
if (!OLD) throw new Error('could not read the version from the installer name')
const NEW = '2.0.0'
const INSTALL_DIR = 'C:\\SnapUpdateTest'
const EXE = path.join(INSTALL_DIR, 'Screen Snap.exe')
const UPDATE_OUT = path.join(ROOT, 'dist-update')

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `— ${detail}` : '')
  return ok
}
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout.trim()
const exeVersion = () => (fs.existsSync(EXE) ? ps(`(Get-Item '${EXE}').VersionInfo.ProductVersion`) : '')
const running = () => ps('(Get-Process -Name "Screen Snap" -ErrorAction SilentlyContinue | Measure-Object).Count') !== '0'

async function waitFor(fn, ms, every = 1000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

;(async () => {
  let failed = false
  let app = null
  let feed = null
  try {
    // 1) a newer installer (and the latest.yml that announces it)
    // (the run that serves it from this computer builds it; the GitHub run reuses that build)
    const reuse = GITHUB && fs.existsSync(path.join(UPDATE_OUT, 'latest.yml')) && fs.existsSync(path.join(UPDATE_OUT, `Screen-Snap-Setup-${NEW}.exe`))
    if (!reuse) log(`building the newer build (${NEW}) to serve as the update…`)
    const b = reuse
      ? { status: 0 }
      : spawnSync(
          'npx',
          ['electron-builder', '--win', 'nsis', '--publish', 'never', `-c.extraMetadata.version=${NEW}`, '-c.directories.output=dist-update',
            '-c.publish.provider=generic', '-c.publish.url=http://127.0.0.1:1'],
          { cwd: ROOT, shell: true, stdio: 'inherit' }
        )
    const files = fs.existsSync(UPDATE_OUT) ? fs.readdirSync(UPDATE_OUT) : []
    check('A newer installer and latest.yml were built', b.status === 0 && files.includes('latest.yml') && files.includes(`Screen-Snap-Setup-${NEW}.exe`), files.join(', '))
    check('The update feed file names the new version', /version:\s*2\.0\.0/.test(fs.readFileSync(path.join(UPDATE_OUT, 'latest.yml'), 'utf8')))

    // 2) serve it: from this computer, or from the fixed GitHub release
    let served = 0
    let feedUrl = ''
    const gh = (...args) => spawnSync('gh', [...args, '--repo', REPO], { encoding: 'utf8', shell: true, env: process.env })
    const toUpload = [`Screen-Snap-Setup-${NEW}.exe`, `Screen-Snap-Setup-${NEW}.exe.blockmap`, 'latest.yml']
    if (GITHUB) {
      if (!REPO) throw new Error('GITHUB_REPOSITORY is not set')
      const view = gh('release', 'view', 'update-test')
      if (view.status !== 0) {
        const made = gh('release', 'create', 'update-test', '--prerelease', '--title', '"Update test (used by the build checks only)"', '--notes', '"A throwaway newer build the update test downloads. Not for downloading."')
        log(`release update-test created: exit ${made.status} ${made.stderr || ''}`.trim())
      }
      const up = gh('release', 'upload', 'update-test', ...toUpload.map((f) => `"${path.join(UPDATE_OUT, f)}"`), '--clobber')
      log(`uploaded the newer build to GitHub: exit ${up.status} ${up.stderr || ''}`.trim())
      check('The newer build was uploaded to the test release on GitHub', up.status === 0)
      feedUrl = `https://github.com/${REPO}/releases/download/update-test`
    }
    if (!GITHUB) feed = http.createServer((req, res) => {
      const file = path.join(UPDATE_OUT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''))
      if (!file.startsWith(UPDATE_OUT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404)
        return res.end()
      }
      const size = fs.statSync(file).size
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      if (m) {
        const start = +m[1]
        const end = m[2] ? Math.min(+m[2], size - 1) : size - 1
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream' })
        if (/\.exe$/.test(file)) served += end - start + 1
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' })
      if (/\.exe$/.test(file)) served += size
      fs.createReadStream(file).pipe(res)
    })
    if (!GITHUB) {
      await new Promise((r) => feed.listen(0, '127.0.0.1', r))
      feedUrl = `http://127.0.0.1:${feed.address().port}`
    }

    // 3) settings the person already has, then install the OLD build silently
    const appData = path.join(process.env.APPDATA, 'Screen Snap')
    fs.mkdirSync(appData, { recursive: true })
    fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({ fps: 30, quality: 'veryhigh', countdown: 5, shotFormat: 'png' }))
    // The installer refuses to go on (and silently waits) while another copy of the app is still running, for instance one
    // left over from the end-to-end test that ran just before this one, so make sure none is.
    spawnSync('taskkill', ['/F', '/T', '/IM', 'Screen Snap.exe'], { windowsHide: true })
    await sleep(3000)
    // an earlier run in the same job (the other feed) leaves its copy behind: remove it so this one starts clean
    const uninstaller = path.join(INSTALL_DIR, 'Uninstall Screen Snap.exe')
    if (fs.existsSync(uninstaller)) {
      log('removing the copy left by the earlier run…')
      spawnSync(uninstaller, ['/S', `_?=${INSTALL_DIR}`], { windowsHide: true, timeout: 3 * 60 * 1000 })
      await sleep(3000)
      fs.rmSync(INSTALL_DIR, { recursive: true, force: true })
    }
    log(`installing ${OLD} silently into ${INSTALL_DIR}…`)
    const inst = spawnSync(oldInstaller, ['/S', '/currentuser', `/D=${INSTALL_DIR}`], { windowsHide: true, timeout: 5 * 60 * 1000 })
    log(`installer finished: exit ${inst.status}${inst.error ? `, ${inst.error.message}` : ''}`)
    check(`The older build (${OLD}) installed`, !!(await waitFor(() => fs.existsSync(EXE), 180000)) && exeVersion().startsWith(OLD), `${exeVersion()} at ${EXE}`)

    // 4) run it; it must find the update on its own feed and download it in the background
    const launch = () => electron.launch({ executablePath: EXE, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: { ...process.env, SCREEN_SNAP_UPDATE_FEED: feedUrl }, timeout: 120000 })
    const panel = async (a) => {
      const w = await waitFor(() => a.windows().find((p) => p.url().includes('index.html')), 60000, 200)
      await w.waitForFunction(() => !document.getElementById('footer').textContent.includes('Detecting'), null, { timeout: 60000 })
      return w
    }
    app = await launch()
    let main = await panel(app)
    const first = await main.evaluate(() => window.api.getUpdateStatus())
    check('The installed old build reports its own version', first.current === OLD, JSON.stringify(first))
    await main.evaluate(() => window.api.checkForUpdates())
    const ready = await waitFor(async () => {
      const s = await main.evaluate(() => window.api.getUpdateStatus())
      if (s.state === 'downloading') log(`downloading ${s.latest}… ${Math.round(s.percent || 0)}%`)
      return s.state === 'ready' || s.state === 'error' ? s : null
    }, 300000, 1500)
    check('The app found the newer version and downloaded it by itself', !!ready && ready.state === 'ready' && ready.latest === NEW, JSON.stringify(ready))
    log(`update download served ${(served / 1048576).toFixed(1)} MB from the feed`)
    if (!GITHUB) check('The update was fetched from the feed', served > 0, `${(served / 1048576).toFixed(1)} MB`)
    await main.waitForSelector('#update-banner:not([hidden])', { timeout: 10000 }).catch(() => {})
    const banner = await main.textContent('#update-banner').catch(() => '')
    check('A banner offers "Restart to update"', /Restart to update/.test(banner) && banner.includes(NEW), banner.replace(/\s+/g, ' ').slice(0, 160))
    await main.screenshot({ path: path.join(RESULTS, 'update-ready.png') }).catch(() => {})

    // 5) restart into it
    const exitedP = new Promise((r) => app.process().once('exit', () => r(true)))
    await main.click('#update-action', { noWaitAfter: true }).catch(() => {})
    const exited = await Promise.race([exitedP, sleep(120000).then(() => false)])
    check('The old copy closed itself so the update could be installed', exited)
    app = null
    const installed = await waitFor(() => exeVersion().startsWith(NEW), 240000, 2000)
    check(`The installer replaced the program with ${NEW}`, !!installed, exeVersion())
    // The installer restarts the app by itself.
    const relaunched = await waitFor(() => running(), 90000, 1000)
    check('The new version started itself after the update', !!relaunched)
    spawnSync('taskkill', ['/F', '/IM', 'Screen Snap.exe', '/T'], { windowsHide: true })
    await sleep(3000)

    // 6) the new version: right number, same settings, up to date
    app = await launch()
    main = await panel(app)
    const now = await main.evaluate(() => window.api.getUpdateStatus())
    check(`The updated app is version ${NEW}`, now.current === NEW, JSON.stringify(now))
    const shown = (await main.textContent('#app-version')).trim()
    check('Settings shows the new version number', shown === NEW, shown)
    const s = await main.evaluate(() => window.api.getSettings())
    check('Settings kept through the update', s.fps === 30 && s.quality === 'veryhigh' && s.countdown === 5, JSON.stringify({ fps: s.fps, quality: s.quality, countdown: s.countdown }))
    const again = await main.evaluate(() => window.api.checkForUpdates())
    await waitFor(async () => (await main.evaluate(() => window.api.getUpdateStatus())).state === 'none', 60000, 1000)
    const final = await main.evaluate(() => window.api.getUpdateStatus())
    check('After updating, it says it is up to date', final.state === 'none', JSON.stringify(final || again))
    await main.screenshot({ path: path.join(RESULTS, 'update-done.png') }).catch(() => {})
  } catch (err) {
    failed = true
    log('UPDATE TEST ERROR:', err.stack || err.message)
  } finally {
    await app?.close().catch(() => {})
    spawnSync('taskkill', ['/F', '/IM', 'Screen Snap.exe', '/T'], { windowsHide: true })
    feed?.close()
    if (GITHUB && REPO) for (const f of ['Screen-Snap-Setup-2.0.0.exe', 'Screen-Snap-Setup-2.0.0.exe.blockmap', 'latest.yml']) spawnSync('gh', ['release', 'delete-asset', 'update-test', f, '--yes', '--repo', REPO], { shell: true, env: process.env })
  }
  fs.writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(results, null, 2))
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} update checks passed${failed ? ' (run aborted early)' : ''}`)
  bad.forEach((r) => console.log(`  FAILED: ${r.name} — ${r.detail}`))
  process.exit(bad.length || failed ? 1 : 0)
})()
