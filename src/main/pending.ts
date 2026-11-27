import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
/** The face camera recorded with a screen recording: raw (as the browser makes it), the finished copy, and the note about how it lines up. */
export const cameraRawFor = (file: string): string => file.replace(/\.mp4$/i, '.camera.webm')
export const cameraFileFor = (file: string): string => file.replace(/\.mp4$/i, '.camera.mp4')
export const cameraInfoFor = (file: string): string => file.replace(/\.mp4$/i, '.camera.json')
/** Pictures and other files that belong to one recording's edit (freeze-frame pictures, copies of files added to it). */
export const mediaDirFor = (file: string): string => file.replace(/\.mp4$/i, '.media')
/** The edit itself (every cut, comment, sound and effect), saved as the person works so it can be opened again. */
export const projectFileFor = (file: string): string => file.replace(/\.mp4$/i, '.project.json')
/** Present when the recording is kept as a project to reopen later (it is then no longer "waiting for review"). */
export const keptFileFor = (file: string): string => file.replace(/\.mp4$/i, '.kept.json')
export const thumbFileFor = (file: string): string => file.replace(/\.mp4$/i, '.thumb.jpg')
/** The computer sound / microphone of a recording taken out as files of their own, for the editor. */
export const trackFileFor = (file: string, kind: 'pc' | 'mic'): string => file.replace(/\.mp4$/i, `.${kind}.m4a`)

const isRecording = (name: string): boolean => /\.mp4$/i.test(name) && !/\.(recording\d*|proxy|camera)\.mp4$/i.test(name)

/** Resolves a basename to a file inside the pending folder, refusing anything else. */
export function resolvePending(name: string): string | null {
  if (!name || name !== basename(name)) return null
  const p = join(pendingDir(), name)
  return existsSync(p) ? p : null
}

/** What is remembered about a recording that was kept as a project. */
export interface KeptInfo {
  /** The name the person gave the video. */
  name: string
  savedAt: number
  /** Length of the edited video, seconds. */
  duration: number
  /** The videos that were saved from it. */
  outputs: string[]
}

export const isKept = (file: string): boolean => existsSync(keptFileFor(file))

export function readKept(file: string): KeptInfo | null {
  try {
    const j = JSON.parse(readFileSync(keptFileFor(file), 'utf8')) as Partial<KeptInfo>
    return {
      name: typeof j.name === 'string' && j.name ? j.name : basename(file).replace(/\.mp4$/i, ''),
      savedAt: typeof j.savedAt === 'number' ? j.savedAt : statSync(file).mtimeMs,
      duration: typeof j.duration === 'number' ? j.duration : 0,
      outputs: Array.isArray(j.outputs) ? j.outputs.filter((x): x is string => typeof x === 'string') : []
    }
  } catch {
    return null
  }
}

export function writeKept(file: string, info: KeptInfo): void {
  writeFileSync(keptFileFor(file), JSON.stringify(info))
}

/** Recordings waiting for review (the ones kept as projects are listed by `listKept`). */
export function listPending(): string[] {
  const dir = pendingDir()
  return readdirSync(dir)
    .filter(isRecording)
    .map((n) => join(dir, n))
    .filter((f) => !isKept(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** Recordings kept as projects, the most recently saved first. */
export function listKept(): string[] {
  const dir = pendingDir()
  return readdirSync(dir)
    .filter(isRecording)
    .map((n) => join(dir, n))
    .filter(isKept)
    .sort((a, b) => (readKept(b)?.savedAt ?? 0) - (readKept(a)?.savedAt ?? 0))
}

/** Everything a project takes up on disk: its recording, camera, sound files, pictures and added files. */
export function projectSize(file: string): number {
  const sum = (p: string): number => {
    try {
      const st = statSync(p)
      return st.isDirectory() ? readdirSync(p).reduce((n, f) => n + sum(join(p, f)), 0) : st.size
    } catch {
      return 0
    }
  }
  return [file, cameraFileFor(file), trackFileFor(file, 'pc'), trackFileFor(file, 'mic'), projectFileFor(file), mediaDirFor(file), ...segmentsOf(file)].reduce((n, f) => n + sum(f), 0)
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])
const wait = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs a file operation, trying again for a moment if Windows says the file is in use (something still has it open). */
export function retryBusy<T>(run: () => T, tries = 12, pauseMs = 250): T {
  for (let n = 1; ; n++) {
    try {
      return run()
    } catch (err) {
      if (n >= tries || !BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      wait(pauseMs)
    }
  }
}

export function removePending(file: string): void {
  for (const p of [file, proxyPathFor(file), joinListFor(file), cameraRawFor(file), cameraFileFor(file), cameraInfoFor(file), trackFileFor(file, 'pc'), trackFileFor(file, 'mic'), projectFileFor(file), keptFileFor(file), thumbFileFor(file), ...segmentsOf(file)]) {
    retryBusy(() => rmSync(p, { force: true }))
  }
  retryBusy(() => rmSync(mediaDirFor(file), { recursive: true, force: true }))
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
    retryBusy(() => renameSync(src, dest), 6, 200)
  } catch {
    // Different drive (or still in use): copy then delete.
    copyFileSync(src, dest)
    retryBusy(() => rmSync(src, { force: true }))
  }
}

export { sanitizeFileName, uniquePath } from './filenames.ts'
