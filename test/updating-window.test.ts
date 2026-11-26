import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UPDATING_TITLE, updatingScript } from '../src/main/updating-window.ts'

describe('the "Updating Screen Snap" window script', () => {
  const script = updatingScript()
  it('shows the window title the Windows update test looks for and waits for the app by name', () => {
    assert.ok(script.includes(`'${UPDATING_TITLE}'`))
    assert.ok(script.includes("Get-Process -Name 'Screen Snap'"))
  })
  it('is plain ASCII with balanced brackets and quotes (it is passed to PowerShell as one encoded command)', () => {
    assert.ok(/^[\x20-\x7e\n]+$/.test(script))
    for (const [a, b] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.equal(script.split(a).length, script.split(b).length, `${a}${b}`)
    assert.equal((script.match(/'/g) ?? []).length % 2, 0)
  })
  it('stays well inside the command-line length limit once encoded', () => {
    assert.ok(Buffer.from(script, 'utf16le').toString('base64').length < 8000)
  })
  it('closes itself after a while even if the new copy never starts', () => {
    assert.ok(/TotalSeconds -gt \d+/.test(script))
  })
})
