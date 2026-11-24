# Removes the autostart shortcut. Does not stop a server that is already running.
$ErrorActionPreference = 'Stop'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Control Room.lnk'
if (Test-Path -LiteralPath $lnk) {
  Remove-Item -LiteralPath $lnk
  Write-Output "removed: $lnk"
} else {
  Write-Output "not installed: $lnk"
}
