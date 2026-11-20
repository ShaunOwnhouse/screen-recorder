import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceleratorFromKey, acceleratorLabel, DEFAULT_RECORD_HOTKEY, DEFAULT_SHOT_HOTKEY, type KeyInfo
} from '../src/shared/hotkeys.ts'

const key = (code: string, mods: Partial<KeyInfo> = {}): KeyInfo => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

test('a shortcut is built from the modifiers plus the key', () => {
  assert.equal(acceleratorFromKey(key('KeyR', { altKey: true, shiftKey: true }), false), 'Alt+Shift+R')
  assert.equal(acceleratorFromKey(key('KeyS', { ctrlKey: true, altKey: true }), true), 'Control+Alt+S')
  assert.equal(acceleratorFromKey(key('Digit5', { ctrlKey: true }), false), 'Control+5')
  assert.equal(acceleratorFromKey(key('ArrowUp', { ctrlKey: true, shiftKey: true }), false), 'Control+Shift+Up')
  assert.equal(acceleratorFromKey(key('KeyK', { metaKey: true }), true), 'Command+K')
  assert.equal(acceleratorFromKey(key('KeyK', { metaKey: true }), false), 'Super+K')
})

test('keys that would take over typing everywhere are refused', () => {
  assert.equal(acceleratorFromKey(key('KeyR'), false), null, 'a bare letter')
  assert.equal(acceleratorFromKey(key('KeyR', { shiftKey: true }), false), null, 'shift + letter is a capital letter')
  assert.equal(acceleratorFromKey(key('Space'), false), null)
  assert.equal(acceleratorFromKey(key('ControlLeft', { ctrlKey: true }), false), null, 'a modifier on its own')
  assert.equal(acceleratorFromKey(key('Tab', { ctrlKey: true }), false), null, 'unsupported key')
})

test('function keys and Print Screen are fine on their own', () => {
  assert.equal(acceleratorFromKey(key('F9'), false), 'F9')
  assert.equal(acceleratorFromKey(key('F12', { ctrlKey: true }), false), 'Control+F12')
  assert.equal(acceleratorFromKey(key('PrintScreen'), false), 'PrintScreen')
})

test('labels read naturally on each platform', () => {
  assert.equal(acceleratorLabel('Alt+Shift+R', false), 'Alt+Shift+R')
  assert.equal(acceleratorLabel('Control+Alt+R', false), 'Ctrl+Alt+R')
  assert.equal(acceleratorLabel('Control+Alt+R', true), 'Control+Option+R')
  assert.equal(acceleratorLabel('Command+K', true), 'Cmd+K')
  assert.equal(acceleratorLabel('Super+K', false), 'Win+K')
})

test('the defaults do not take browser shortcuts (hard refresh, developer tools) away', () => {
  const browser = ['Control+Shift+R', 'CommandOrControl+Shift+R', 'Control+Shift+I', 'CommandOrControl+Shift+I', 'Command+Shift+R', 'Command+Alt+I']
  for (const d of [DEFAULT_RECORD_HOTKEY.win, DEFAULT_RECORD_HOTKEY.mac, DEFAULT_SHOT_HOTKEY.win, DEFAULT_SHOT_HOTKEY.mac]) {
    assert.ok(!browser.includes(d), d)
  }
  assert.notEqual(DEFAULT_RECORD_HOTKEY.win, DEFAULT_SHOT_HOTKEY.win)
  assert.notEqual(DEFAULT_RECORD_HOTKEY.mac, DEFAULT_SHOT_HOTKEY.mac)
  // Option+letter types special characters on a Mac, so the Mac defaults must include Control.
  for (const d of [DEFAULT_RECORD_HOTKEY.mac, DEFAULT_SHOT_HOTKEY.mac]) assert.match(d, /Control/)
})
