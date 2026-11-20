import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { parseRange } from './parse.ts'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolvePending } from './pending.ts'
import { shotTmpDir } from './snap.ts'

export const MEDIA_SCHEME = 'media'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function mediaUrl(fileName: string): string {
  return `${MEDIA_SCHEME}://pending/${encodeURIComponent(fileName)}`
}

/** Serves pending recordings to the editor's <video> with byte-range support so seeking works. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (req) => {
    const url = new URL(req.url)
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
    // media://shot/<file> is a temporary screenshot picture; media://pending/<file> is a recording waiting for review.
    let file: string | null
    if (url.hostname === 'shot') {
      const candidate = name === basename(name) ? join(shotTmpDir(), name) : null
      file = candidate && existsSync(candidate) ? candidate : null
    } else file = resolvePending(name)
    if (!file) return new Response('Not found', { status: 404 })
    const type = /\.png$/i.test(file) ? 'image/png' : 'video/mp4'

    const size = statSync(file).size
    const range = parseRange(req.headers.get('range'), size)
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
    const body = (start: number, end: number): BodyInit =>
      Readable.toWeb(createReadStream(file, { start, end })) as unknown as BodyInit

    if (!range) return new Response(body(0, size - 1), { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
    return new Response(body(range.start, range.end), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(range.end - range.start + 1)
      }
    })
  })
}
