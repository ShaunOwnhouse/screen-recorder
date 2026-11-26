import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * While an update installs, the app is closed and the installer works without any window of its own, so for up to a minute
 * nothing is on screen — and people try to open the app again, half way through the install. This small window (a separate
 * PowerShell process, outside the program folder so the installer can replace everything) says what is going on, waits
 * until the new copy has started and then closes itself (or after 5 minutes at the latest).
 */
export const UPDATING_TITLE = 'Updating Screen Snap'

export function updatingScript(processName = 'Screen Snap'): string {
  return [
    "$log = Join-Path $env:TEMP 'screen-snap-updating.log'",
    'function Note($m) { try { Add-Content -Path $log -Value ((Get-Date).ToString(\'HH:mm:ss.fff\') + \' \' + $m) } catch { } }',
    "Note 'start'",
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  [System.Windows.Forms.Application]::EnableVisualStyles()',
    '  $f = New-Object System.Windows.Forms.Form',
    `  $f.Text = '${UPDATING_TITLE}'`,
    "  $f.FormBorderStyle = 'FixedDialog'",
    '  $f.ControlBox = $false',
    "  $f.StartPosition = 'CenterScreen'",
    '  $f.TopMost = $true',
    '  $f.ClientSize = New-Object System.Drawing.Size(400, 120)',
    '  $f.BackColor = [System.Drawing.Color]::FromArgb(24, 27, 33)',
    '  $l = New-Object System.Windows.Forms.Label',
    "  $l.Text = 'Installing the new version of Screen Snap.' + [char]10 + 'It opens by itself in a moment - please wait.'",
    '  $l.ForeColor = [System.Drawing.Color]::White',
    "  $l.Font = New-Object System.Drawing.Font('Segoe UI', 10)",
    '  $l.SetBounds(20, 18, 360, 50)',
    '  $p = New-Object System.Windows.Forms.ProgressBar',
    "  $p.Style = 'Marquee'",
    '  $p.SetBounds(20, 78, 360, 16)',
    '  $f.Controls.Add($l)',
    '  $f.Controls.Add($p)',
    "  $f.Add_Shown({ Note 'shown' })",
    '  $global:gone = $false',
    '  $t0 = Get-Date',
    '  $t = New-Object System.Windows.Forms.Timer',
    '  $t.Interval = 700',
    '  $t.Add_Tick({',
    `    $up = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue).Count -gt 0`,
    '    if (-not $global:gone) { if (-not $up) { $global:gone = $true; Note \'old copy closed\' } }',
    "    elseif ($up) { Note 'new copy running'; Start-Sleep -Seconds 2; $f.Close() }",
    "    if (((Get-Date) - $t0).TotalSeconds -gt 300) { Note 'gave up waiting'; $f.Close() }",
    '  })',
    '  $t.Start()',
    '  [void]$f.ShowDialog()',
    "  Note 'closed'",
    "} catch { Note ('error: ' + $_) }"
  ].join('\n')
}

/**
 * Windows only; never gets in the way of the update itself. It is started through `start`, so it is not a child of the app that
 * is about to close (nothing that tidies up after the app's exit can take it down with it).
 */
export function showUpdatingWindow(): void {
  if (process.platform !== 'win32') return
  const note = (text: string): void => {
    try {
      appendFileSync(join(tmpdir(), 'screen-snap-updating-spawn.log'), `${new Date().toISOString()} ${text}\n`)
    } catch {
      /* only a trace for finding problems */
    }
  }
  try {
    const encoded = Buffer.from(updatingScript(), 'utf16le').toString('base64')
    const line = `"start "" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}"`
    // not windowsHide for the window itself (it would hide the window the script opens); it is only cmd's own console that is hidden here
    const child = spawn('cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    child.on('error', (err) => note(`error: ${err}`))
    child.on('exit', (code) => note(`cmd exited: ${code}`))
    note(`started, cmd pid ${child.pid}, ${encoded.length} characters`)
    child.unref()
  } catch (err) {
    note(`failed: ${err}`)
  }
}
