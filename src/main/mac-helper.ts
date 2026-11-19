import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** The native ScreenCaptureKit helper, built in CI from native/mac/MacHelper.swift. */
export function macHelperPath(): string | null {
  if (process.platform !== 'darwin') return null
  const p = app.isPackaged ? join(process.resourcesPath, 'bin', 'mac-helper') : join(__dirname, '../../resources/mac/mac-helper')
  return existsSync(p) ? p : null
}

/** CoreGraphics display IDs in the order FFmpeg's avfoundation numbers "Capture screen N". */
export function macDisplayOrder(): Promise<number[] | null> {
  const helper = macHelperPath()
  if (!helper) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(helper, ['displays'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const ids = JSON.parse(String(stdout).trim())
        resolve(Array.isArray(ids) ? ids.map(Number) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

export function spawnSystemAudio(): ChildProcess | null {
  const helper = macHelperPath()
  return helper ? spawn(helper, ['audio'], { stdio: ['pipe', 'pipe', 'pipe'] }) : null
}
