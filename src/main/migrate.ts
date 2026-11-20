import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** The app used to be called "Screen Recorder"; carry the saved settings and unsaved recordings over to "Screen Snap". */
export function migrateFromOldName(): void {
  const dir = app.getPath('userData')
  const old = join(app.getPath('appData'), 'Screen Recorder')
  if (old === dir || !existsSync(old) || existsSync(join(dir, 'settings.json'))) return
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(join(old, 'settings.json'))) copyFileSync(join(old, 'settings.json'), join(dir, 'settings.json'))
    if (existsSync(join(old, 'pending')) && !existsSync(join(dir, 'pending'))) renameSync(join(old, 'pending'), join(dir, 'pending'))
  } catch {
    // Starting fresh is fine; nothing is lost that was already saved to the user's folders.
  }
}
