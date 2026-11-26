'use strict'
// Checks the update feed the way an installed copy of the app reads it, so a broken feed is noticed the moment it is published.
//   node scripts/check-feed.cjs <feed url> [expected version]
// 1. reads latest.yml from the feed, 2. checks it names the expected version, 3. downloads the installer it points at
// (the same address, with the same redirects, that the app follows) and checks its size and SHA-512 against latest.yml,
// 4. checks the block map (used for small "differential" downloads) is there. Exits non-zero if anything is wrong.
const { createHash } = require('node:crypto')

const feed = (process.argv[2] || process.env.UPDATE_FEED_URL || '').replace(/\/+$/, '')
const expected = process.argv[3] || ''
if (!feed) {
  console.error('usage: node scripts/check-feed.cjs <feed url> [expected version]')
  process.exit(2)
}

const problems = []
const say = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) problems.push(text)
}

async function get(url, init) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'screen-snap-feed-check' }, ...init })
  return res
}

/** The few fields latest.yml has that matter here (it is simple enough to read without a YAML library). */
function field(yml, name) {
  const m = new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(yml)
  return m ? m[1] : ''
}

;(async () => {
  console.log(`feed: ${feed}`)
  // a file that was only just uploaded can take a little while to show up at its download address
  let r = await get(`${feed}/latest.yml`)
  let yml = r.ok ? await r.text() : ''
  for (let tries = 1; tries < 9 && expected && (!r.ok || field(yml, 'version') !== expected); tries++) {
    console.log(`  (the feed still shows ${r.ok ? field(yml, 'version') : `HTTP ${r.status}`}; looking again in 10 s)`)
    await new Promise((res) => setTimeout(res, 10000))
    r = await get(`${feed}/latest.yml`)
    yml = r.ok ? await r.text() : ''
  }
  say(r.ok, `latest.yml can be read (HTTP ${r.status})`)
  if (!r.ok) return finish()
  const version = field(yml, 'version')
  const file = field(yml, 'path')
  const sha = field(yml, 'sha512')
  const size = Number((/^\s*size:\s*(\d+)/m.exec(yml) || [])[1])
  say(!!version && !!file && !!sha && size > 0, `latest.yml names a version, a file, a checksum and a size (${version}, ${file}, ${size} bytes)`)
  if (expected) say(version === expected, `the feed offers the version just published (${version} vs ${expected})`)

  // the installer, from the address the app would use
  const t0 = Date.now()
  const d = await get(`${feed}/${encodeURIComponent(file)}`)
  say(d.ok, `the installer can be downloaded (HTTP ${d.status})`)
  if (d.ok) {
    const hash = createHash('sha512')
    let bytes = 0
    for await (const chunk of d.body) {
      hash.update(chunk)
      bytes += chunk.length
    }
    say(bytes === size, `the installer is the size latest.yml says (${bytes} of ${size} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    say(hash.digest('base64') === sha, 'the installer\'s SHA-512 matches latest.yml, so the app will accept it')
  }

  // a range request (what a differential download uses) must work through the redirect too
  const part = await get(`${feed}/${encodeURIComponent(file)}`, { headers: { range: 'bytes=0-1023', 'user-agent': 'screen-snap-feed-check' } })
  const got = part.ok ? (await part.arrayBuffer()).byteLength : 0
  say(part.status === 206 && got === 1024, `a partial download works (HTTP ${part.status}, ${got} bytes)`)
  if (part.body) await part.body.cancel().catch(() => undefined)

  const bm = await get(`${feed}/${encodeURIComponent(file)}.blockmap`, { headers: { range: 'bytes=0-255' } })
  say(bm.ok, `the block map is there (HTTP ${bm.status})`)
  if (bm.body) await bm.body.cancel().catch(() => undefined)
  finish()
})().catch((err) => {
  say(false, `the check itself failed: ${err.message}`)
  finish()
})

function finish() {
  console.log(problems.length ? `\n${problems.length} problem(s) with the update feed.` : '\nThe update feed is intact.')
  process.exit(problems.length ? 1 : 0)
}
