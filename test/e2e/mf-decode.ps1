# Asks Windows' own Media Foundation stack (what Media Player, Photos and Films & TV use) to open a
# video and decode EVERY frame, by transcoding it to a small MP4. Exit 0 only if Windows can do that.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOperation = ($extensions | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskProgress = ($extensions | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1'
  })[0]

function Await($operation, [Type]$resultType) {
  $task = $asTaskOperation.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(120000)) { throw 'Windows media stack timed out' }
  if ($task.IsFaulted) { throw $task.Exception.InnerException }
  $task.Result
}

function AwaitProgress($operation, [Type]$progressType) {
  $task = $asTaskProgress.MakeGenericMethod($progressType).Invoke($null, @($operation))
  if (-not $task.Wait(300000)) { throw 'Windows transcode timed out' }
  if ($task.IsFaulted) { throw $task.Exception.InnerException }
}

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.CreationCollisionOption, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.VideoEncodingQuality, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Media.Transcoding.MediaTranscoder, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Media.Transcoding.PrepareTranscodeResult, Windows.Media, ContentType = WindowsRuntime]

$output = $null
try {
  $source = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])

  # 1) Can Windows identify the container and codecs?
  $profile = Await ([Windows.Media.MediaProperties.MediaEncodingProfile]::CreateFromFileAsync($source)) ([Windows.Media.MediaProperties.MediaEncodingProfile])
  Write-Output ("video=$($profile.Video.Subtype) $($profile.Video.Width)x$($profile.Video.Height) audio=$($profile.Audio.Subtype)")
  if ($profile.Video.Width -lt 2) { throw 'Windows found no video track' }

  # 2) Can it decode every frame? Transcoding forces the full decode path.
  $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([System.IO.Path]::GetTempPath())) ([Windows.Storage.StorageFolder])
  $name = "mf-decode-$([guid]::NewGuid().ToString('N')).mp4"
  $destination = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $output = $destination.Path

  $transcoder = New-Object Windows.Media.Transcoding.MediaTranscoder
  $transcoder.HardwareAccelerationEnabled = $false
  $target = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::Qvga)
  $prepared = Await ($transcoder.PrepareFileTranscodeAsync($source, $destination, $target)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
  if (-not $prepared.CanTranscode) { throw "Windows cannot decode this file (reason: $($prepared.FailureReason))" }
  AwaitProgress ($prepared.TranscodeAsync()) ([double])

  $bytes = (Get-Item -LiteralPath $output).Length
  if ($bytes -lt 2000) { throw 'Windows produced no output while decoding' }
  Write-Output "Windows decoded every frame ($bytes bytes of re-encoded output)"
  exit 0
}
catch {
  Write-Output ("WINDOWS CANNOT PLAY THIS FILE: " + $_.Exception.Message)
  exit 1
}
finally {
  if ($output -and (Test-Path -LiteralPath $output)) { Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue }
}
