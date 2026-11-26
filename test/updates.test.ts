import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendlyUpdateError, updateButton, updateLine, updateWaiting, type UpdateStatus } from '../src/shared/updates.ts'

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

test('Settings → Updates only shows a button when there is something to click', () => {
  assert.equal(updateButton(s({ state: 'none' })), null)
  assert.equal(updateButton(s({ state: 'checking' })), null)
  assert.equal(updateButton(s({ state: 'error', detail: 'x' })), null, 'a failed check has nothing to click')
  assert.equal(updateButton(s({ state: 'unsupported' })), null)
  assert.deepEqual(updateButton(s({ state: 'ready', latest: '1.2.0' })), { action: 'restart', label: 'Restart to update' })
  assert.deepEqual(updateButton(s({ state: 'available', latest: '1.2.0', notifyOnly: true })), { action: 'open', label: 'Get the update' })
  assert.deepEqual(updateButton(s({ state: 'available', latest: '1.2.0', manualDownload: true })), { action: 'download', label: 'Update now' })
  assert.equal(updateButton(s({ state: 'available', latest: '1.2.0' })), null, 'an automatic download needs no button')
  assert.equal(updateButton(s({ state: 'downloading', latest: '1.2.0', percent: 10 })), null, 'the progress is in the status line')
})

test('the Settings section is marked while an update is waiting', () => {
  for (const state of ['available', 'downloading', 'ready'] as const) assert.equal(updateWaiting(s({ state })), true, state)
  for (const state of ['idle', 'checking', 'none', 'error', 'unsupported'] as const) assert.equal(updateWaiting(s({ state })), false, state)
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
