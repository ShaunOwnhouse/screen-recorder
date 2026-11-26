import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { friendlyUpdateError, type UpdateStatus } from '../shared/updates.ts'
import { showUpdatingWindow } from './updating-window.ts'

const LOCAL_FEED = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/
/** The tests can also read the "newer build" from one fixed GitHub release (to try GitHub's real download links). */
const TEST_FEED = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/update-test\/?$/
const FIRST_CHECK_MS = 20_000
const CHECK_EVERY_MS = 60 * 60 * 1000
/** Coming back to the window looks again if the last look was longer ago than this. */
const STALE_AFTER_MS = 15 * 60 * 1000

interface Deps {
  /** Is "download and install updates automatically" switched on? */
  auto: () => boolean
  /** A reason NOT to restart right now (recording, a screenshot being edited…), or null when it's fine. */
  busy: () => string | null
}

/** Build-time facts stamped into the packaged package.json by CI. */
function appMeta(): { signedBuild: boolean; releasePage: string } {
  try {
    const j = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    return { signedBuild: j.signedBuild === true, releasePage: typeof j.releasePage === 'string' ? j.releasePage : '' }
  } catch {
    return { signedBuild: false, releasePage: '' }
  }
}

/**
 * The installed app updates itself: it looks for a newer version in the background, downloads only what changed, and installs
 * it the next time the app is closed (or when the person clicks "Restart to update"). Settings and unsaved recordings are kept
 * because they live outside the program folder.
 */
export class Updater extends EventEmitter {
  private status: UpdateStatus
  private readonly meta = appMeta()
  private readonly notifyOnly: boolean
  private readonly unsupported: string | null
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private lastCheck = 0
  private readonly staleAfter: number

  constructor(private readonly deps: Deps) {
    super()
    const feed = process.env.SCREEN_SNAP_UPDATE_FEED
    const override = feed && (LOCAL_FEED.test(feed) || TEST_FEED.test(feed)) ? feed : null // for tests only: a feed on this very computer, or the fixed test release
    // macOS only lets signed apps replace themselves; until the app is signed an update is announced and installed by hand.
    // tests can shorten "a while" (only together with their own feed)
    const staleTest = Number(process.env.SCREEN_SNAP_UPDATE_STALE_MS)
    this.staleAfter = override && staleTest > 0 ? staleTest : STALE_AFTER_MS
    this.notifyOnly = process.platform === 'darwin' && !this.meta.signedBuild
    this.unsupported = override
      ? null
      : !app.isPackaged
        ? 'This is a development copy, so it doesn’t update itself.'
        : (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore
          ? 'This copy comes from the Microsoft Store, which updates it for you.'
          : process.env.PORTABLE_EXECUTABLE_FILE
          ? 'The portable version can’t update itself — install Screen Snap with the Setup file to get automatic updates.'
          : process.platform === 'linux'
            ? 'Automatic updates aren’t available on Linux yet.'
            : null
    this.status = this.unsupported
      ? { state: 'unsupported', current: app.getVersion(), detail: this.unsupported }
      : { state: 'idle', current: app.getVersion(), notifyOnly: this.notifyOnly }

    if (this.unsupported) return
    if (override) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: 'generic', url: override })
    }
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', detail: undefined }))
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.set({ state: 'available', latest: info.version, notifyOnly: this.notifyOnly, manualDownload: !this.deps.auto() && !this.notifyOnly })
    )
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', latest: undefined, percent: undefined }))
    autoUpdater.on('download-progress', (p: ProgressInfo) => this.set({ state: 'downloading', percent: p.percent }))
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.set({ state: 'ready', latest: info.version, percent: 100 }))
    autoUpdater.on('error', (err: Error) => this.set({ state: 'error', detail: friendlyUpdateError(String(err?.message ?? err)) }))
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  /** Checks shortly after start-up, then every hour. */
  start(): void {
    if (this.unsupported) return
    this.lastCheck = Date.now() // the first look is booked below, so coming to the window during start-up doesn't add another
    this.timer = setTimeout(() => {
      void this.check()
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
    }, FIRST_CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async check(): Promise<UpdateStatus> {
    if (this.unsupported || this.checking) return this.status
    // Don't look again while a download is under way or already finished.
    if (this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    this.checking = true
    this.lastCheck = Date.now()
    try {
      autoUpdater.autoDownload = this.deps.auto() && !this.notifyOnly
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', detail: friendlyUpdateError(String((err as Error)?.message ?? err)) })
    } finally {
      this.checking = false
    }
    return this.status
  }

  /** Called when the person opens or returns to the window: looks again if it has been a while (the app may have been open for days). */
  checkIfStale(): void {
    if (this.unsupported || this.timer === null) return // not started yet: the first check is already booked
    if (Date.now() - this.lastCheck < this.staleAfter) return
    void this.check()
  }

  /** Starts the download of a found update — or, where the app can't install it itself, opens the download page. */
  async download(): Promise<void> {
    if (this.notifyOnly) {
      if (this.meta.releasePage) await shell.openExternal(this.meta.releasePage)
      return
    }
    if (this.status.state !== 'available') return
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.set({ state: 'error', detail: friendlyUpdateError(String((err as Error)?.message ?? err)) })
    }
  }

  /** Closes the app, installs the downloaded update and starts the new version. */
  install(): { ok: boolean; reason?: string } {
    if (this.status.state !== 'ready') return { ok: false, reason: 'No update is ready yet.' }
    const busy = this.deps.busy()
    if (busy) return { ok: false, reason: busy }
    setImmediate(() => {
      showUpdatingWindow() // the installer is silent: this says what is happening until the new copy opens
      autoUpdater.quitAndInstall(true, true)
    })
    return { ok: true }
  }
}
