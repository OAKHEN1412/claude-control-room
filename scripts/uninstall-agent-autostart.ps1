# Removes the agent autostart shortcut. Does not stop an agent that is already running.
$ErrorActionPreference = 'Stop'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Control Room Agent.lnk'
if (Test-Path -LiteralPath $lnk) {
  Remove-Item -LiteralPath $lnk
  Write-Output "removed: $lnk"
} else {
  Write-Output "not installed: $lnk"
}
