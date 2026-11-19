import { existsSync, statSync } from 'node:fs'
import { runFfmpeg } from './ffmpeg.ts'
import { parseMediaInfo } from './parse.ts'
import type { RecordingMeta } from '../shared/types.ts'

export async function probeMedia(file: string): Promise<RecordingMeta | null> {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file])
  return parseMediaInfo(stderr)
}

export interface Verdict {
  ok: boolean
  reason?: string
  meta?: RecordingMeta
}

const DECODE_ERROR = /invalid data|moov atom|error while decoding|corrupt|truncated|missing picture|could not find codec/i

/** Decodes a short window of the file; a recording that can't be decoded is not a recording. */
async function decodes(args: string[]): Promise<boolean> {
  const res = await runFfmpeg(['-hide_banner', '-v', 'error', ...args, '-f', 'null', '-'], 5 * 60 * 1000)
  return res.ok && !DECODE_ERROR.test(res.stderr)
}

/** Cheap structural check: the file exists, has a readable video stream, and isn't empty. */
export async function checkStructure(file: string): Promise<Verdict> {
  if (!existsSync(file)) return { ok: false, reason: 'The recording file was never created.' }
  if (statSync(file).size < 1024) return { ok: false, reason: 'The recording file is empty.' }
  const meta = await probeMedia(file)
  if (!meta) return { ok: false, reason: 'The recording has no readable video in it.' }
  if (!(meta.duration > 0.2)) return { ok: false, reason: 'The recording contains no video frames.' }
  return { ok: true, meta }
}

/** Full check run on every finished recording: structure, then decode the start and end. */
export async function verifyRecording(file: string): Promise<Verdict> {
  const structure = await checkStructure(file)
  if (!structure.ok) return structure
  if (!(await decodes(['-i', file, '-t', '2']))) return { ok: false, reason: 'The recording can’t be decoded (the start is damaged).' }
  if (structure.meta!.duration > 6 && !(await decodes(['-sseof', '-2', '-i', file]))) {
    return { ok: false, reason: 'The recording can’t be decoded (the end is damaged).' }
  }
  return structure
}
