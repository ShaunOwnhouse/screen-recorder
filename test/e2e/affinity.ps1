# Reads a window's display-affinity flag. 0x11 (17) = WDA_EXCLUDEFROMCAPTURE: Windows keeps the window out of captures.
param([Parameter(Mandatory = $true)][string]$Handle)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Wda {
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
}
'@
[uint32]$affinity = 0
$ok = [Wda]::GetWindowDisplayAffinity([IntPtr][Int64]::Parse($Handle), [ref]$affinity)
Write-Output "ok=$ok affinity=$affinity"
if ($ok -and $affinity -eq 17) { exit 0 } else { exit 1 }
