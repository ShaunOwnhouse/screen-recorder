# Opens a video with Windows' own Media Foundation stack (what Media Player, Photos and Films & TV use)
# and decodes a frame. Exits 0 only if Windows can really read and decode the file.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, [Type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(90000)) { throw 'Windows media stack timed out' }
  $task.Result
}

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Media.Editing.MediaClip, Windows.Media.Editing, ContentType = WindowsRuntime]
[void][Windows.Media.Editing.MediaComposition, Windows.Media.Editing, ContentType = WindowsRuntime]

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])

  # 1) Can Windows identify the container and codecs?
  $profile = Await ([Windows.Media.MediaProperties.MediaEncodingProfile]::CreateFromFileAsync($file)) ([Windows.Media.MediaProperties.MediaEncodingProfile])
  Write-Output ("video=$($profile.Video.Subtype) $($profile.Video.Width)x$($profile.Video.Height) audio=$($profile.Audio.Subtype)")
  if ($profile.Video.Width -lt 2) { throw 'Windows found no video track' }

  # 2) Can it actually decode a frame?
  $clip = Await ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($file)) ([Windows.Media.Editing.MediaClip])
  $composition = New-Object Windows.Media.Editing.MediaComposition
  $composition.Clips.Add($clip)
  $method = [Windows.Media.Editing.MediaComposition].GetMethod('GetThumbnailAsync', [Type[]]@([TimeSpan], [int], [int], [Windows.Media.Editing.VideoFramePrecision]))
  $thumbType = $method.ReturnType.GenericTypeArguments[0]
  $op = $composition.GetThumbnailAsync([TimeSpan]::FromSeconds(1), 320, 180, [Windows.Media.Editing.VideoFramePrecision]::NearestFrame)
  $thumb = Await $op $thumbType
  if ($thumb.Size -lt 500) { throw 'decoded frame is empty' }
  Write-Output "decoded a frame ($($thumb.Size) bytes)"
  exit 0
}
catch {
  Write-Output ("WINDOWS CANNOT PLAY THIS FILE: " + $_.Exception.Message)
  exit 1
}
