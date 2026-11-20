import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'

/** Finished recordings live here until the user saves or discards them. */
export function pendingDir(): string {
  const dir = join(app.getPath('userData'), 'pending')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const tempPathFor = (file: string): string => file.replace(/\.mp4$/i, '.recording.mp4')
export const proxyPathFor = (file: string): string => file.replace(/\.mp4$/i, '.proxy.mp4')

const isRecording = (name: string): boolean => /\.mp4$/i.test(name) && !/\.(recording|proxy)\.mp4$/i.test(name)

/** Resolves a basename to a file inside the pending folder, refusing anything else. */
export function resolvePending(name: string): string | null {
  if (!name || name !== basename(name)) return null
  const p = join(pendingDir(), name)
  return existsSync(p) ? p : null
}

export function listPending(): string[] {
  const dir = pendingDir()
  return readdirSync(dir)
    .filter(isRecording)
    .map((n) => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

export function removePending(file: string): void {
  for (const p of [file, proxyPathFor(file), tempPathFor(file)]) rmSync(p, { force: true })
}

/** Turns recordings interrupted by a crash or power cut back into normal MP4s. */
export async function recoverInterrupted(remux: (input: string, output: string) => Promise<boolean>): Promise<void> {
  const dir = pendingDir()
  for (const name of readdirSync(dir).filter((n) => /\.recording\.mp4$/i.test(n))) {
    const temp = join(dir, name)
    const final = temp.replace(/\.recording\.mp4$/i, '.mp4')
    if (!existsSync(final) && statSync(temp).size > 0 && (await remux(temp, final))) rmSync(temp, { force: true })
    else if (existsSync(final) || statSync(temp).size === 0) rmSync(temp, { force: true })
  }
}

export function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch {
    // Different drive: copy then delete.
    copyFileSync(src, dest)
    rmSync(src, { force: true })
  }
}

export { sanitizeFileName, uniquePath } from './filenames.ts'
