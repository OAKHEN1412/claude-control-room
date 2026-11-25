# Claude Control Room uninstaller for Windows. No admin needed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir <dir>] [-Purge] [-Yes] [-DryRun]
#
# Steps: stop the server (the exact PID that owns the port), remove the Startup shortcut and the cr shims
# (via the app's own uninstall scripts), delete the app folder, and with -Purge also delete the data dir.
# The app folder is deleted only if it contains .cr-install. Without that marker the whole uninstall is
# refused, so a dev checkout is never touched. The data dir is kept unless -Purge.
# -DryRun prints every action and changes nothing. A dry run never prompts.
param(
  [string]$InstallDir = '',
  [switch]$Purge,
  [switch]$Yes,
  [switch]$DryRun
)

function CR-Has([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function CR-Record([string]$step, [string]$status, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Step = $step; Status = $status; Detail = $detail })
  Write-Host ("  => {0}: {1}" -f $status, $detail)
}

function CR-Ask([string]$question) {
  if ($Yes -or $DryRun) { return $true }
  $ans = Read-Host ("{0} [Y/n]" -f $question)
  return (-not ($ans -match '^\s*(n|no)\s*$'))
}

function CR-Exec([string]$file, [string[]]$argList) {
  $shown = $file + ' ' + ($argList -join ' ')
  if ($DryRun) {
    Write-Host ("  [dry-run] {0}" -f $shown) -ForegroundColor DarkGray
    return 0
  }
  Write-Host ("  > {0}" -f $shown) -ForegroundColor DarkGray
  & $file @argList | Out-Host
  return $LASTEXITCODE
}

function CR-DataDir {
  if ($env:CR_DATA_DIR) { return $env:CR_DATA_DIR }
  return (Join-Path $env:USERPROFILE '.claude-control-room')
}

function CR-ServerPort {
  if ($env:CR_PORT -match '^\d+$') { return [int]$env:CR_PORT }
  return 8790
}

function CR-StepStopServer {
  $port = CR-ServerPort
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    CR-Record 'Stop server' 'failed' 'Get-NetTCPConnection is not available; stop the server by hand'
    return
  }
  $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($conns.Count -eq 0) { CR-Record 'Stop server' 'skipped' ('nothing listening on port {0}' -f $port); return }
  $owners = @($conns | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 4 } | Select-Object -Unique)
  if ($owners.Count -eq 0) { CR-Record 'Stop server' 'skipped' ('port {0} is owned by a system process - not touched' -f $port); return }
  foreach ($pid1 in $owners) {
    $proc = Get-Process -Id $pid1 -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
    if ($DryRun) {
      Write-Host ("  [dry-run] Stop-Process -Id {0} (owner of port {1}, {2})" -f $pid1, $port, $name) -ForegroundColor DarkGray
      CR-Record 'Stop server' 'planned' ('stop PID {0} ({1}) on port {2}' -f $pid1, $name, $port)
      continue
    }
    if (-not (CR-Ask ('Stop {0} (PID {1}) that is listening on port {2}?' -f $name, $pid1, $port))) {
      CR-Record 'Stop server' 'skipped' ('declined for PID {0}' -f $pid1)
      continue
    }
    try {
      Stop-Process -Id $pid1 -Force -ErrorAction Stop
      CR-Record 'Stop server' 'done' ('stopped PID {0} ({1})' -f $pid1, $name)
    } catch {
      CR-Record 'Stop server' 'failed' ('could not stop PID {0}: {1}' -f $pid1, $_.Exception.Message)
    }
  }
}

function CR-StepShortcutAndShims {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $unAuto = Join-Path $InstallDir 'scripts\uninstall-autostart.ps1'
  $unCr = Join-Path $InstallDir 'scripts\uninstall-cr.ps1'
  if (-not $DryRun -and -not ((Test-Path -LiteralPath $unAuto) -and (Test-Path -LiteralPath $unCr))) {
    CR-Record 'Startup shortcut + cr' 'failed' 'uninstall scripts not found in the app folder - remove "Claude Control Room.lnk" from the Startup folder and the cr shims by hand'
    return
  }
  $a = CR-Exec $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $unAuto)
  $c = CR-Exec $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $unCr)
  if ($DryRun) { CR-Record 'Startup shortcut + cr' 'planned' 'uninstall-autostart.ps1 and uninstall-cr.ps1'; return }
  if ($a -eq 0 -and $c -eq 0) { CR-Record 'Startup shortcut + cr' 'done' 'shortcut and cr shims removed' }
  else { CR-Record 'Startup shortcut + cr' 'failed' ('autostart exit {0}, cr exit {1}' -f $a, $c) }
}

function CR-StepDeleteApp {
  $full = [IO.Path]::GetFullPath($InstallDir)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.TrimEnd('\') -eq $root.TrimEnd('\') -or $full.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) {
    CR-Record 'App folder' 'failed' ('refusing to delete {0}' -f $full)
    return
  }
  if (-not (Test-Path -LiteralPath $full)) { CR-Record 'App folder' 'skipped' ('{0} does not exist' -f $full); return }
  if (-not (CR-Ask ('Delete the app folder {0}?' -f $full))) { CR-Record 'App folder' 'skipped' 'declined'; return }
  if ($DryRun) { Write-Host ("  [dry-run] Remove-Item -Recurse -Force '{0}'" -f $full) -ForegroundColor DarkGray; CR-Record 'App folder' 'planned' ('delete {0}' -f $full); return }
  try {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    CR-Record 'App folder' 'done' ('deleted {0}' -f $full)
  } catch {
    CR-Record 'App folder' 'failed' ('could not delete {0}: {1}' -f $full, $_.Exception.Message)
  }
}

function CR-StepPurge {
  $dataDir = CR-DataDir
  if (-not $Purge) {
    CR-Record 'Data dir' 'skipped' ('kept {0} (use -Purge to delete it)' -f $dataDir)
    return
  }
  if (-not (Test-Path -LiteralPath $dataDir)) { CR-Record 'Data dir' 'skipped' ('{0} does not exist' -f $dataDir); return }
  if (-not (CR-Ask ('PURGE: delete the data dir {0} (config, database, logs)?' -f $dataDir))) { CR-Record 'Data dir' 'skipped' 'declined'; return }
  if ($DryRun) { Write-Host ("  [dry-run] Remove-Item -Recurse -Force '{0}'" -f $dataDir) -ForegroundColor DarkGray; CR-Record 'Data dir' 'planned' ('purge {0}' -f $dataDir); return }
  try {
    Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction Stop
    CR-Record 'Data dir' 'done' ('purged {0}' -f $dataDir)
  } catch {
    CR-Record 'Data dir' 'failed' ('could not purge {0}: {1}' -f $dataDir, $_.Exception.Message)
  }
}

function CR-Main {
  $results = New-Object System.Collections.ArrayList
  Write-Host 'Claude Control Room uninstaller' -ForegroundColor Cyan
  if ($DryRun) { Write-Host 'DRY RUN - nothing will be changed.' -ForegroundColor Yellow }
  Write-Host ("App folder: {0}" -f $InstallDir)

  $marker = Join-Path $InstallDir '.cr-install'
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host ("Nothing to do: {0} does not exist." -f $InstallDir) -ForegroundColor Yellow
    Write-Host 'If the Startup shortcut "Claude Control Room.lnk" is still there, remove it by hand.'
    return
  }
  if (-not (Test-Path -LiteralPath $marker)) {
    Write-Host ('REFUSED: {0} has no .cr-install marker, so it is not an installer-made app folder (maybe a dev checkout).' -f $InstallDir) -ForegroundColor Red
    Write-Host 'Nothing was changed. Pass the real -InstallDir, or delete a dev checkout yourself.'
    return
  }

  $steps = @(
    @{ N = 1; Title = 'Stop the server'; Fn = 'CR-StepStopServer' },
    @{ N = 2; Title = 'Startup shortcut and cr shims'; Fn = 'CR-StepShortcutAndShims' },
    @{ N = 3; Title = 'Delete the app folder'; Fn = 'CR-StepDeleteApp' },
    @{ N = 4; Title = 'Data dir'; Fn = 'CR-StepPurge' }
  )
  foreach ($s in $steps) {
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $s.N, $steps.Count, $s.Title) -ForegroundColor Cyan
    try { & $s.Fn } catch { CR-Record $s.Title 'failed' $_.Exception.Message }
  }

  Write-Host ''
  Write-Host 'Summary' -ForegroundColor Cyan
  $results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

if (-not $InstallDir) {
  if ($env:CR_INSTALL_DIR) { $InstallDir = $env:CR_INSTALL_DIR }
  else { $InstallDir = Join-Path $env:LOCALAPPDATA 'ClaudeControlRoom\app' }
}

CR-Main
