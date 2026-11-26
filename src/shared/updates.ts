export type UpdateState = 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** The version that is running now. */
  current: string
  /** The newer version, once one has been found. */
  latest?: string
  /** 0–100 while downloading. */
  percent?: number
  /** Why updates are unavailable ('unsupported') or what went wrong ('error'). */
  detail?: string
  /** True when updates are only announced and the person installs them by hand (e.g. an unsigned Mac build). */
  notifyOnly?: boolean
  /** True when found updates are downloaded only after a click (automatic updates are switched off). */
  manualDownload?: boolean
}

/** The one-line status shown in Settings → Updates. */
export function updateLine(s: UpdateStatus): string {
  switch (s.state) {
    case 'unsupported':
      return s.detail ?? 'Updates are not available for this copy.'
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return 'You’re up to date.'
    case 'available':
      return s.notifyOnly || s.manualDownload ? `Version ${s.latest} is available.` : `Version ${s.latest} found — downloading…`
    case 'downloading':
      return `Downloading version ${s.latest}… ${Math.round(s.percent ?? 0)}%`
    case 'ready':
      return `Version ${s.latest} is ready to install.`
    case 'error':
      return `Couldn’t check for updates — ${s.detail ?? 'unknown problem'}.`
  }
}

export interface UpdateBanner {
  text: string
  /** What the banner's button does; no button when undefined. */
  action?: 'restart' | 'download' | 'open'
  label?: string
  /** 0–100 while the update is downloading: the banner shows a progress bar. */
  progress?: number
}

/** Is there an update the person can do something about (found, downloading or ready)? Marks the Settings → Updates section. */
export const updateWaiting = (s: UpdateStatus): boolean => s.state === 'available' || s.state === 'downloading' || s.state === 'ready'

/** What the panel shows at the top, or null when there's nothing worth interrupting for. */
export function updateBanner(s: UpdateStatus): UpdateBanner | null {
  if (s.state === 'ready') {
    return { text: `Version ${s.latest} is ready. Restart Screen Snap to finish updating — your settings and recordings are kept.`, action: 'restart', label: 'Restart to update' }
  }
  if (s.state === 'available' && s.notifyOnly) {
    return { text: `Version ${s.latest} is available.`, action: 'open', label: 'Get the update' }
  }
  if (s.state === 'available' && s.manualDownload) {
    return { text: `Version ${s.latest} is available.`, action: 'download', label: 'Update now' }
  }
  if (s.state === 'downloading') return { text: `Downloading update ${s.latest}… ${Math.round(s.percent ?? 0)}%`, progress: Math.min(100, Math.max(0, s.percent ?? 0)) }
  return null
}

/** A readable reason for a failed check. */
export function friendlyUpdateError(message: string): string {
  const m = message.toLowerCase()
  if (/enotfound|econnrefused|etimedout|econnreset|network|socket|getaddrinfo|err_internet|err_name_not_resolved/.test(m)) return 'couldn’t reach the update server (check your internet connection)'
  if (/404|not found|cannot find latest|no published versions/.test(m)) return 'no update has been published yet'
  if (/403|401|unauthor|forbidden/.test(m)) return 'the update server refused the request'
  const first = message.split('\n')[0].replace(/^Error:\s*/i, '').trim()
  return first.length > 120 ? `${first.slice(0, 117)}…` : first || 'unknown problem'
}
