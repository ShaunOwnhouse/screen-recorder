import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { IMAGE_FORMATS, VIDEO_FORMATS } from '../shared/formats.ts'
import { DEFAULT_RECORD_HOTKEY, DEFAULT_SHOT_HOTKEY } from '../shared/hotkeys.ts'
import type { Settings } from '../shared/types.ts'

const file = (): string => join(app.getPath('userData'), 'settings.json')

function defaults(): Settings {
  return {
    mode: 'fullscreen',
    countdown: 3,
    outputHeight: null,
    fps: 60,
    quality: 'maximum',
    encoder: 'auto',
    showCursor: true,
    backend: 'auto',
    outputDir: join(app.getPath('videos'), 'Screen Snap'),
    systemAudio: true,
    systemVolume: 1,
    micEnabled: false,
    micDevice: 'default',
    micLabel: null,
    micVolume: 1,
    noiseSuppression: true,
    videoFormat: 'mp4',
    shotMode: 'region',
    shotDelay: 0,
    shotFormat: 'png',
    shotDir: join(app.getPath('pictures'), 'Screen Snap'),
    shotClipboard: false,
    shotCursor: false,
    hotkeyRecord: process.platform === 'darwin' ? DEFAULT_RECORD_HOTKEY.mac : DEFAULT_RECORD_HOTKEY.win,
    hotkeyShot: process.platform === 'darwin' ? DEFAULT_SHOT_HOTKEY.mac : DEFAULT_SHOT_HOTKEY.win
  }
}

/** Replaces anything that isn't a known value (an old or hand-edited settings file) with the default. */
function sanitize(s: Settings): Settings {
  const d = defaults()
  return {
    ...s,
    videoFormat: VIDEO_FORMATS.some((f) => f.id === s.videoFormat) ? s.videoFormat : d.videoFormat,
    shotFormat: IMAGE_FORMATS.some((f) => f.id === s.shotFormat) ? s.shotFormat : d.shotFormat,
    shotMode: s.shotMode === 'fullscreen' || s.shotMode === 'region' ? s.shotMode : d.shotMode,
    shotDelay: [0, 3, 5].includes(s.shotDelay) ? s.shotDelay : d.shotDelay,
    hotkeyRecord: typeof s.hotkeyRecord === 'string' ? s.hotkeyRecord : d.hotkeyRecord,
    hotkeyShot: typeof s.hotkeyShot === 'string' ? s.hotkeyShot : d.hotkeyShot
  }
}

let current: Settings | null = null

export function getSettings(): Settings {
  if (!current) {
    try {
      const saved = JSON.parse(readFileSync(file(), 'utf8'))
      // Earlier versions used micDevice: null to mean "no microphone".
      if (saved.micEnabled === undefined && 'micDevice' in saved) {
        saved.micEnabled = saved.micDevice !== null
        saved.micDevice = saved.micDevice ?? 'default'
      }
      current = sanitize({ ...defaults(), ...saved })
    } catch {
      current = defaults()
    }
  }
  return current!
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = sanitize({ ...getSettings(), ...patch })
  writeFileSync(file(), JSON.stringify(current, null, 2))
  return current
}
