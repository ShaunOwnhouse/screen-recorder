/** Turning a key press into an Electron accelerator ("Alt+Shift+R"), and showing one to people. */

export interface KeyInfo {
  /** KeyboardEvent.code, e.g. "KeyR", "Digit5", "F9", "PrintScreen". */
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const NAMED: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', PrintScreen: 'PrintScreen', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\'
}

const isFunctionKey = (key: string): boolean => /^F([1-9]|1\d|2[0-4])$/.test(key) || key === 'PrintScreen'

/**
 * The accelerator for a key press, or null when it isn't a usable global shortcut: a bare letter would take
 * over typing in every app, so plain keys need a modifier (function keys and Print Screen are fine alone).
 */
export function acceleratorFromKey(k: KeyInfo, mac: boolean): string | null {
  let key: string | null
  if (/^Key[A-Z]$/.test(k.code)) key = k.code.slice(3)
  else if (/^Digit\d$/.test(k.code)) key = k.code.slice(5)
  else if (/^F\d{1,2}$/.test(k.code)) key = k.code
  else key = NAMED[k.code] ?? null
  if (!key) return null

  const mods: string[] = []
  if (k.ctrlKey) mods.push('Control')
  if (k.altKey) mods.push('Alt')
  if (k.shiftKey) mods.push('Shift')
  if (k.metaKey) mods.push(mac ? 'Command' : 'Super')
  if (!isFunctionKey(key)) {
    if (!mods.length) return null
    if (mods.length === 1 && mods[0] === 'Shift') return null // Shift+letter is just a capital letter
  }
  return [...mods, key].join('+')
}

/** "Control+Alt+R" → "Ctrl+Alt+R" (Windows) or "Control+Option+R" (Mac). */
export function acceleratorLabel(accelerator: string, mac: boolean): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'Control') return mac ? 'Control' : 'Ctrl'
      if (part === 'CommandOrControl') return mac ? 'Cmd' : 'Ctrl'
      if (part === 'Command') return 'Cmd'
      if (part === 'Alt') return mac ? 'Option' : 'Alt'
      if (part === 'Super') return mac ? 'Cmd' : 'Win'
      return part
    })
    .join('+')
}

/** Defaults that other apps don't use: browsers own Ctrl+Shift+R (hard refresh) and Ctrl+Shift+I (developer tools). */
export const DEFAULT_RECORD_HOTKEY = { win: 'Alt+Shift+R', mac: 'Control+Alt+R' }
export const DEFAULT_SHOT_HOTKEY = { win: 'Alt+Shift+S', mac: 'Control+Alt+S' }
export const DEFAULT_PAUSE_HOTKEY = { win: 'Alt+Shift+P', mac: 'Control+Alt+P' }
