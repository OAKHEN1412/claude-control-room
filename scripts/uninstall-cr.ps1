# Removes the shims written by install-cr.ps1 (only files named cr / cr.cmd whose content points at this repo).
param([string]$Dir = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $repo 'cli\src\cr.ts'
$dirs = if ($Dir) { @($Dir) } else { @((Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:USERPROFILE 'bin')) }
foreach ($d in $dirs) {
  foreach ($n in 'cr.cmd', 'cr') {
    $f = Join-Path $d $n
    if ((Test-Path $f -PathType Leaf) -and ((Get-Content -Raw $f) -match [regex]::Escape('cli\src\cr.ts') + '|' + [regex]::Escape('cli/src/cr.ts'))) {
      Remove-Item $f
      Write-Output "removed: $f"
    }
  }
}
