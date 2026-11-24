import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'

/** Finished recordings live here until the user saves or discards them. */
export function pendingDir(): string {
  const dir = join(app.getPath('userData'), 'pending')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const tempPathFor = (file: string): string => file.replace(/\.mp4$/i, '.recording.mp4')
export const proxyPathFor = (file: string): string => file.replace(/\.mp4$/i, '.proxy.mp4')
/** A recording that was paused and resumed is captured in pieces: .recording.mp4, .recording2.mp4, … */
export const segmentPathFor = (file: string, n: number): string => (n <= 1 ? tempPathFor(file) : file.replace(/\.mp4$/i, `.recording${n}.mp4`))
export const joinListFor = (file: string): string => file.replace(/\.mp4$/i, '.pieces.txt')

const isRecording = (name: string): boolean => /\.mp4$/i.test(name) && !/\.(recording\d*|proxy)\.mp4$/i.test(name)

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
  for (const p of [file, proxyPathFor(file), joinListFor(file), ...segmentsOf(file)]) rmSync(p, { force: true })
}

/** Every piece of a recording that is still around, in order. */
export function segmentsOf(file: string): string[] {
  const dir = dirname(file)
  const stem = basename(file).replace(/\.mp4$/i, '')
  const found: { n: number; path: string }[] = []
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^(.*)\.recording(\d*)\.mp4$/i.exec(name)
    if (m && m[1] === stem) found.push({ n: m[2] ? Number(m[2]) : 1, path: join(dir, name) })
  }
  return found.sort((a, b) => a.n - b.n).map((f) => f.path)
}

/** Turns recordings interrupted by a crash or power cut back into normal MP4s (every piece of a paused one is joined). */
export async function recoverInterrupted(
  remux: (input: string, output: string) => Promise<boolean>,
  joinPieces: (inputs: string[], output: string) => Promise<boolean>
): Promise<void> {
  const dir = pendingDir()
  const stems = new Set<string>()
  for (const name of readdirSync(dir)) {
    const m = /^(.*)\.recording\d*\.mp4$/i.exec(name)
    if (m) stems.add(m[1])
  }
  for (const stem of stems) {
    const final = join(dir, `${stem}.mp4`)
    const pieces = segmentsOf(final).filter((p) => statSync(p).size > 0)
    let done = existsSync(final)
    if (!done && pieces.length === 1) done = await remux(pieces[0], final)
    else if (!done && pieces.length > 1) done = (await joinPieces(pieces, final)) || (await remux(pieces[0], final))
    // Keep the pieces only while there is nothing better to show for them.
    if (done || !pieces.length) for (const p of [...segmentsOf(final), joinListFor(final)]) rmSync(p, { force: true })
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
