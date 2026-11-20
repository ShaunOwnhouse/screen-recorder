import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendlyUpdateError, updateBanner, updateLine, type UpdateStatus } from '../src/shared/updates.ts'

const s = (over: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', current: '1.1.0', ...over })

test('the status line says what is going on in plain words', () => {
  assert.equal(updateLine(s({ state: 'checking' })), 'Checking for updates…')
  assert.equal(updateLine(s({ state: 'none' })), 'You’re up to date.')
  assert.equal(updateLine(s({ state: 'available', latest: '1.2.0' })), 'Version 1.2.0 found — downloading…')
  assert.equal(updateLine(s({ state: 'available', latest: '1.2.0', manualDownload: true })), 'Version 1.2.0 is available.')
  assert.equal(updateLine(s({ state: 'downloading', latest: '1.2.0', percent: 41.6 })), 'Downloading version 1.2.0… 42%')
  assert.equal(updateLine(s({ state: 'ready', latest: '1.2.0' })), 'Version 1.2.0 is ready to install.')
  assert.match(updateLine(s({ state: 'error', detail: 'no update has been published yet' })), /Couldn’t check for updates — no update has been published yet/)
  assert.equal(updateLine(s({ state: 'unsupported', detail: 'Portable copies can’t update.' })), 'Portable copies can’t update.')
})

test('the panel only interrupts for something the person can act on', () => {
  assert.equal(updateBanner(s({ state: 'none' })), null)
  assert.equal(updateBanner(s({ state: 'checking' })), null)
  assert.equal(updateBanner(s({ state: 'error', detail: 'x' })), null, 'a failed check is not worth a banner')
  assert.equal(updateBanner(s({ state: 'unsupported' })), null)
  const ready = updateBanner(s({ state: 'ready', latest: '1.2.0' }))!
  assert.equal(ready.action, 'restart')
  assert.match(ready.text, /settings and recordings are kept/)
  assert.equal(updateBanner(s({ state: 'available', latest: '1.2.0', notifyOnly: true }))!.action, 'open')
  assert.equal(updateBanner(s({ state: 'available', latest: '1.2.0', manualDownload: true }))!.action, 'download')
  assert.equal(updateBanner(s({ state: 'available', latest: '1.2.0' })), null, 'an automatic download needs no button')
  const dl = updateBanner(s({ state: 'downloading', latest: '1.2.0', percent: 10 }))!
  assert.equal(dl.action, undefined)
})

test('errors are turned into something a person can understand', () => {
  assert.match(friendlyUpdateError('getaddrinfo ENOTFOUND example.com'), /couldn’t reach the update server/)
  assert.match(friendlyUpdateError('net::ERR_INTERNET_DISCONNECTED'), /couldn’t reach the update server/)
  assert.equal(friendlyUpdateError('Cannot find latest.yml in the latest release'), 'no update has been published yet')
  assert.equal(friendlyUpdateError('HTTP 404'), 'no update has been published yet')
  assert.equal(friendlyUpdateError('HTTP 403 Forbidden'), 'the update server refused the request')
  assert.equal(friendlyUpdateError('Error: something odd\nstack line'), 'something odd')
  assert.ok(friendlyUpdateError('x'.repeat(500)).length <= 120)
})
