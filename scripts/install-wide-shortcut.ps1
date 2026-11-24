<#
  Creates the desktop shortcut "Claude Control Room (2 จอ)" that runs scripts\open-wide.vbs
  (one app window across all monitors). Per user, no admin, no registry. Run again to refresh it.
  -Remove deletes the shortcut.
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Claude Control Room (2 จอ).lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop $name

if ($Remove) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk; Write-Output "removed $lnk" } else { Write-Output 'no shortcut' }
  return
}

$vbs = Join-Path $PSScriptRoot 'open-wide.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "missing $vbs" }

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $PSScriptRoot
$s.Description = 'Claude Control Room - one window across both monitors'
$s.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
$s.Save()
Write-Output "created $lnk"
