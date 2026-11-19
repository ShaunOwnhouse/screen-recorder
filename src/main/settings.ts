import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '../shared/types.ts'

const file = (): string => join(app.getPath('userData'), 'settings.json')

function defaults(): Settings {
  return {
    displayId: null,
    mode: 'fullscreen',
    outputHeight: null,
    fps: 60,
    quality: 'veryhigh',
    encoder: 'auto',
    showCursor: true,
    backend: 'auto',
    outputDir: join(app.getPath('videos'), 'Screen Recordings'),
    systemAudio: true,
    systemVolume: 1,
    micDevice: null,
    micLabel: null,
    micVolume: 1,
    noiseSuppression: true
  }
}

let current: Settings | null = null

export function getSettings(): Settings {
  if (!current) {
    try {
      current = { ...defaults(), ...JSON.parse(readFileSync(file(), 'utf8')) }
    } catch {
      current = defaults()
    }
  }
  return current!
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(current, null, 2))
  return current
}
