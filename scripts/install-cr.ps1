# Installs the `cr` terminal client: writes cr.cmd (cmd / PowerShell) and an extension-less `cr` (Git Bash) shim
# into a folder that is ALREADY on the user's PATH (%USERPROFILE%\.local\bin, then %USERPROFILE%\bin, or -Dir).
# It never edits PATH, the registry or any system folder. If no such folder is on PATH it still writes the shims to
# %USERPROFILE%\.local\bin and prints the one line you must add to PATH yourself.
# Needs Node 22.18+ (runs the .ts entry directly). Re-run after moving the repo. Remove with uninstall-cr.ps1.
param([string]$Dir = '')
$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$entry = (Resolve-Path (Join-Path $repo 'cli\src\cr.ts')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not on PATH' }

function Norm([string]$p) { return $p.TrimEnd('\', '/').ToLowerInvariant() }
$onPath = @($env:Path -split ';' | Where-Object { $_ } | ForEach-Object { Norm $_ })
$candidates = if ($Dir) { @($Dir) } else { @((Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:USERPROFILE 'bin')) }
$target = $null
foreach ($c in $candidates) {
  if ((Test-Path $c -PathType Container) -and ($onPath -contains (Norm $c))) { $target = $c; break }
}
$needPath = $false
if (-not $target) {
  $target = if ($Dir) { $Dir } else { Join-Path $env:USERPROFILE '.local\bin' }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $needPath = $true
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
# cmd / PowerShell
$cmd = "@echo off`r`nnode `"$entry`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $target 'cr.cmd'), $cmd, $utf8)
# Git Bash: C:\a\b -> /c/a/b
$posix = '/' + $entry.Substring(0, 1).ToLowerInvariant() + $entry.Substring(2).Replace('\', '/')
$sh = "#!/bin/sh`nexec node `"$posix`" `"`$@`"`n"
[IO.File]::WriteAllText((Join-Path $target 'cr'), $sh, $utf8)

Write-Output "installed: $(Join-Path $target 'cr.cmd')  +  $(Join-Path $target 'cr')"
Write-Output "  -> node $entry"
if ($needPath) {
  Write-Output ''
  Write-Output "NOTE: $target is not on your PATH, so 'cr' will not be found yet. To add it for your user, run once:"
  Write-Output "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$target', 'User')"
  Write-Output '  then open a new terminal.'
}
& node $entry --help | Select-Object -First 1
