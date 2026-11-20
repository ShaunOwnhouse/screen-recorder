import { existsSync } from 'node:fs'
import { join } from 'node:path'

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A safe file name (no path characters) with the given extension. Any extension the user typed is dropped first. */
export function sanitizeFileName(name: string, fallback: string, ext = 'mp4'): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(new RegExp(`\\.${escapeRe(ext)}$`, 'i'), '').trim().replace(/[. ]+$/, '')
  return `${cleaned || fallback}.${ext}`
}

/** `name.ext` in `dir`, or `name (2).ext`, `name (3).ext`… if that already exists. */
export function uniquePath(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}
