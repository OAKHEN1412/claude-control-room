# Adds "Claude Control Room Agent.lnk" to the current user's Startup folder (shell:startup).
# Per-user, no admin, no Task Scheduler, no registry. Remove with uninstall-agent-autostart.ps1.
$ErrorActionPreference = 'Stop'
$vbs = (Resolve-Path (Join-Path $PSScriptRoot 'start-agent-hidden.vbs')).Path
$repo = Split-Path $PSScriptRoot -Parent
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Claude Control Room Agent.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $repo
$s.WindowStyle = 7
$s.Description = 'Claude Control Room Agent (127.0.0.1:8791)'
$s.Save()
Write-Output "installed: $lnk"
Write-Output "  -> $($s.TargetPath) $($s.Arguments)"
