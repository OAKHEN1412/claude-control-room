# Claude Control Room installer for Windows. No admin needed.
#
# Piped (parameters are impossible through iex, so use env vars instead):
#   $env:CR_INSTALL_YES='1'; $env:CR_INSTALL_DRYRUN='1'; $env:CR_INSTALL_REF='v0.1.0'; $env:CR_INSTALL_DIR='D:\CRapp'
#   irm https://raw.githubusercontent.com/OAKHEN1412/claude-control-room/main/install.ps1 | iex
# Local:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Yes] [-DryRun] [-InstallDir <dir>] [-Ref <tag>] [-RepoUrl <url>] [-Port 8790] [-NoVideoToolchain]
#
# -DryRun prints every action and changes nothing. Read-only probes (Get-Command, the GitHub release lookup)
# still run. A dry run never prompts. Without -Yes every step asks y/n, default yes.
# Each step is a function; CR-Main runs them in order and the summary table lists done / skipped / failed.
param(
  [switch]$Yes,
  [switch]$DryRun,
  [string]$InstallDir = '',
  [string]$Ref = '',
  [string]$RepoUrl = 'https://github.com/OAKHEN1412/claude-control-room.git',
  [int]$Port = 8790,
  [switch]$NoVideoToolchain
)

function CR-Has([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function CR-EnableTls12 {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
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

# Runs a native command (or prints it in dry-run). Returns the exit code.
function CR-Exec([string]$file, [string[]]$argList, [string]$cwd = '') {
  $shown = $file + ' ' + ($argList -join ' ')
  if ($DryRun) {
    Write-Host ("  [dry-run] {0}" -f $shown) -ForegroundColor DarkGray
    if ($cwd) { Write-Host ("            (in {0})" -f $cwd) -ForegroundColor DarkGray }
    return 0
  }
  Write-Host ("  > {0}" -f $shown) -ForegroundColor DarkGray
  $prev = (Get-Location).Path
  try {
    if ($cwd) { Set-Location -LiteralPath $cwd }
    & $file @argList | Out-Host
    return $LASTEXITCODE
  } finally {
    Set-Location -LiteralPath $prev
  }
}

function CR-RefreshPath {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($m, $u)
  $local = Join-Path $env:USERPROFILE '.local\bin'
  if (Test-Path -LiteralPath $local) { $parts += $local }
  $env:Path = (@($parts | Where-Object { $_ }) -join ';')
}

function CR-NodeVersion {
  if (-not (CR-Has 'node')) { return $null }
  try {
    $v = ([string](& node --version 2>$null)).Trim().TrimStart('v')
    return [version]$v
  } catch { return $null }
}

function CR-DataDir {
  if ($env:CR_DATA_DIR) { return $env:CR_DATA_DIR }
  return (Join-Path $env:USERPROFILE '.claude-control-room')
}

function CR-WriteUtf8([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($path, $text, $enc)
}

# winget package install with a verification check. $check is a scriptblock returning $true when present.
function CR-Winget([string]$label, [string]$id, [scriptblock]$check) {
  if (& $check) {
    CR-Record $label 'skipped' 'already installed'
    return
  }
  if (-not (CR-Has 'winget')) {
    CR-Record $label 'failed' ('winget not found - install {0} by hand' -f $label)
    return
  }
  $code = CR-Exec 'winget' @('install', '--id', $id, '-e', '--accept-package-agreements', '--accept-source-agreements')
  if ($DryRun) { CR-Record $label 'planned' ('winget install {0}' -f $id); return }
  CR-RefreshPath
  if (& $check) {
    CR-Record $label 'done' ('installed with winget ({0})' -f $id)
  } else {
    CR-Record $label 'failed' ('winget exit {0}. This may need admin rights: run install.ps1 from an elevated PowerShell or install {1} by hand' -f $code, $label)
  }
}

function CR-StepNode {
  $min = [version]'22.18.0'
  $cur = CR-NodeVersion
  if ($cur -and $cur -ge $min) { CR-Record 'Node.js' 'skipped' ("already {0}" -f $cur); return }
  Write-Host ("  Node.js {0}+ is needed (found: {1})." -f $min, $(if ($cur) { $cur } else { 'none' }))
  if (-not (CR-Ask 'Install Node.js LTS with winget?')) { CR-Record 'Node.js' 'skipped' 'declined'; return }
  CR-Winget 'Node.js' 'OpenJS.NodeJS.LTS' { $c = CR-NodeVersion; return ($c -and $c -ge [version]'22.18.0') }
}

function CR-StepGit {
  if (CR-Has 'git') { CR-Record 'Git' 'skipped' 'already installed'; return }
  if (-not (CR-Ask 'Install Git with winget?')) { CR-Record 'Git' 'skipped' 'declined'; return }
  CR-Winget 'Git' 'Git.Git' { CR-Has 'git' }
}

function CR-StepClaude {
  if (CR-Has 'claude') { CR-Record 'Claude Code CLI' 'skipped' 'already on PATH'; return }
  Write-Host '  Claude Code CLI is not on PATH.'
  if (-not (CR-Ask 'Install Claude Code with the official installer (irm https://claude.ai/install.ps1 | iex)?')) {
    CR-Record 'Claude Code CLI' 'skipped' 'declined - install it later, then run claude once to sign in'
    return
  }
  if ($DryRun) { CR-Record 'Claude Code CLI' 'planned' 'irm https://claude.ai/install.ps1 | iex'; return }
  Invoke-Expression (Invoke-RestMethod -Uri 'https://claude.ai/install.ps1')
  CR-RefreshPath
  if (CR-Has 'claude') {
    CR-Record 'Claude Code CLI' 'done' 'installed - run "claude" once in a terminal to sign in (not blocking)'
  } else {
    CR-Record 'Claude Code CLI' 'failed' 'not on PATH after the installer - open a new terminal and check'
  }
}

function CR-StepFfmpeg {
  if ((CR-Has 'ffmpeg') -and (CR-Has 'ffprobe')) { CR-Record 'ffmpeg' 'skipped' 'already installed'; return }
  if (-not (CR-Ask 'Install ffmpeg with winget?')) { CR-Record 'ffmpeg' 'skipped' 'declined'; return }
  CR-Winget 'ffmpeg' 'Gyan.FFmpeg' { (CR-Has 'ffmpeg') -and (CR-Has 'ffprobe') }
}

function CR-GitTagExists([string]$dir, [string]$name) {
  & git -C $dir show-ref --verify --quiet ("refs/tags/" + $name) 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function CR-WriteMarker {
  if ($DryRun) { Write-Host ('  [dry-run] write {0}' -f (Join-Path $InstallDir '.cr-install')) -ForegroundColor DarkGray; return }
  $obj = [ordered]@{ tag = [string]$Ref; installedAt = (Get-Date).ToUniversalTime().ToString('o') }
  CR-WriteUtf8 (Join-Path $InstallDir '.cr-install') (($obj | ConvertTo-Json) + "`n")
}

function CR-StepClone {
  $dir = $InstallDir
  if (-not (CR-Has 'git')) { CR-Record 'App checkout' 'failed' 'git is not installed (step 2)'; return }
  if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir '.cr-install'))) {
      CR-Record 'App checkout' 'failed' ('{0} is a git checkout without .cr-install - not touching it' -f $dir)
      return
    }
    $target = $Ref
    if (-not (CR-GitTagExists $dir $Ref)) { $target = 'origin/' + $Ref }
    $c1 = CR-Exec 'git' @('-C', $dir, 'fetch', '--tags', '--force', 'origin')
    $c2 = CR-Exec 'git' @('-C', $dir, 'checkout', '--force', '--detach', $target)
    if ($DryRun) { CR-Record 'App checkout' 'planned' ('fetch tags, checkout {0}' -f $target); return }
    if ($c1 -eq 0 -and $c2 -eq 0) {
      CR-WriteMarker
      CR-Record 'App checkout' 'done' ('updated to {0} in {1}' -f $target, $dir)
    } else {
      CR-Record 'App checkout' 'failed' ('git fetch/checkout failed in {0}' -f $dir)
    }
    return
  }
  if ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
    CR-Record 'App checkout' 'failed' ('{0} exists, is not empty and is not a CR install - pick another -InstallDir' -f $dir)
    return
  }
  if (-not $DryRun) {
    $parent = Split-Path -Parent $dir
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  }
  $c = CR-Exec 'git' @('clone', '--depth', '1', '--branch', $Ref, $RepoUrl, $dir)
  if ($DryRun) { CR-Record 'App checkout' 'planned' ('clone {0} at {1} into {2}' -f $RepoUrl, $Ref, $dir); return }
  if ($c -eq 0 -and (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
    CR-WriteMarker
    CR-Record 'App checkout' 'done' ('cloned {0} into {1}' -f $Ref, $dir)
  } else {
    CR-Record 'App checkout' 'failed' ('git clone of {0} failed' -f $Ref)
  }
}

function CR-StepBuild {
  if (-not (CR-Has 'npm.cmd')) { CR-Record 'npm ci + build' 'failed' 'npm is not on PATH (install Node.js first)'; return }
  if ($DryRun) {
    CR-Exec 'npm.cmd' @('ci') $InstallDir | Out-Null
    CR-Exec 'npm.cmd' @('run', 'build') $InstallDir | Out-Null
    CR-Record 'npm ci + build' 'planned' 'npm ci, then npm run build'
    return
  }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'package.json'))) {
    CR-Record 'npm ci + build' 'failed' 'app folder is missing (checkout step failed)'
    return
  }
  if ((CR-Exec 'npm.cmd' @('ci') $InstallDir) -ne 0) { CR-Record 'npm ci + build' 'failed' 'npm ci failed'; return }
  if ((CR-Exec 'npm.cmd' @('run', 'build') $InstallDir) -ne 0) { CR-Record 'npm ci + build' 'failed' 'npm run build failed'; return }
  CR-Record 'npm ci + build' 'done' 'dependencies installed and built'
}

function CR-StepConfig {
  $dataDir = CR-DataDir
  $cfg = Join-Path $dataDir 'config.json'
  $default = "{`n  `"language`": `"auto`",`n  `"update`": { `"check`": true, `"channel`": `"stable`" }`n}`n"
  if (Test-Path -LiteralPath $cfg) {
    CR-Record 'config.json' 'skipped' ("kept existing {0}" -f $cfg)
  } elseif ($DryRun) {
    Write-Host ("  [dry-run] write default {0}" -f $cfg) -ForegroundColor DarkGray
    CR-Record 'config.json' 'planned' ("default config in {0}" -f $dataDir)
  } else {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    CR-WriteUtf8 $cfg $default
    CR-Record 'config.json' 'done' ("wrote default {0}" -f $cfg)
  }
  if ($DryRun) { CR-WriteMarker; CR-Record 'Install marker' 'planned' '.cr-install' ; return }
  if (Test-Path -LiteralPath (Join-Path $InstallDir 'package.json')) {
    CR-WriteMarker
    CR-Record 'Install marker' 'done' ('.cr-install written with tag {0}' -f $Ref)
  } else {
    CR-Record 'Install marker' 'failed' 'app folder is missing'
  }
}

function CR-StepShortcuts {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $autostart = Join-Path $InstallDir 'scripts\install-autostart.ps1'
  $crShims = Join-Path $InstallDir 'scripts\install-cr.ps1'
  if (-not $DryRun -and -not ((Test-Path -LiteralPath $autostart) -and (Test-Path -LiteralPath $crShims))) {
    CR-Record 'Startup shortcut + cr' 'failed' 'install-autostart.ps1 / install-cr.ps1 not found in the app folder'
    return
  }
  if (-not (CR-Ask 'Add the Startup shortcut (server starts at sign-in) and the cr command?')) {
    CR-Record 'Startup shortcut + cr' 'skipped' 'declined'
    return
  }
  $a = CR-Exec $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $autostart)
  $c = CR-Exec $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $crShims)
  if ($DryRun) { CR-Record 'Startup shortcut + cr' 'planned' 'install-autostart.ps1 and install-cr.ps1'; return }
  if ($a -eq 0 -and $c -eq 0) {
    CR-Record 'Startup shortcut + cr' 'done' 'shortcut in Startup folder, cr shims in ~/.local/bin (or ~/bin)'
  } else {
    CR-Record 'Startup shortcut + cr' 'failed' ('autostart exit {0}, cr exit {1}' -f $a, $c)
  }
}

function CR-StepVideo {
  if ($NoVideoToolchain) { CR-Record 'Video toolchain' 'skipped' '-NoVideoToolchain'; return }
  if (-not (CR-Ask 'Install the video toolchain (HyperFrames skills, Lemo-Opuscar plugin, lemo styles)? Failures here are warnings.')) {
    CR-Record 'Video toolchain' 'skipped' 'declined'
    return
  }
  $warn = @()
  # skills CLI flags verified with: npx --yes skills add --help (-g, -a <agents>, -s <skills>, -y, --copy; 'claude-code' is a named agent)
  if ((CR-Has 'npx.cmd') -or $DryRun) {
    if ((CR-Exec 'npx.cmd' @('--yes', 'skills', 'add', 'heygen-com/hyperframes', '-g', '-a', 'claude-code', '-s', '*', '-y', '--copy')) -ne 0) { $warn += 'HyperFrames skills' }
  } else { $warn += 'npx missing (HyperFrames skills)' }
  if ((CR-Has 'claude') -or $DryRun) {
    # plugin subcommands verified with: claude plugin --help / marketplace --help / install --help
    if ((CR-Exec 'claude' @('plugin', 'marketplace', 'add', 'lemomo-ai/lemo-opuscar')) -ne 0) { $warn += 'marketplace add (already added?)' }
    if ((CR-Exec 'claude' @('plugin', 'install', 'lemo-opuscar@lemolab', '-y')) -ne 0) { $warn += 'lemo-opuscar plugin install' }
  } else { $warn += 'claude missing (Lemo plugin)' }
  $lemo = Join-Path $InstallDir 'scripts\lemo-styles.mjs'
  if ($DryRun) {
    CR-Exec 'node' @('scripts/lemo-styles.mjs') $InstallDir | Out-Null
  } elseif (Test-Path -LiteralPath $lemo) {
    if ((CR-Exec 'node' @('scripts/lemo-styles.mjs') $InstallDir) -ne 0) { $warn += 'lemo styles' }
  } else {
    $warn += 'scripts/lemo-styles.mjs not in this version (styles skipped)'
  }
  if ($DryRun) { CR-Record 'Video toolchain' 'planned' 'skills, plugin, lemo styles'; return }
  if ($warn.Count -eq 0) { CR-Record 'Video toolchain' 'done' 'skills, plugin and styles installed' }
  else { CR-Record 'Video toolchain' 'warn' ('not fully installed: {0}' -f ($warn -join '; ')) }
}

function CR-ServerUp([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function CR-StepStart {
  $url = 'http://127.0.0.1:' + $Port + '/'
  $vbs = Join-Path $InstallDir 'scripts\start-hidden.vbs'
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if ($DryRun) {
    Write-Host ("  [dry-run] set CR_PORT and PORT = {0}" -f $Port) -ForegroundColor DarkGray
    CR-Exec $wscript @($vbs) | Out-Null
    Write-Host ("  [dry-run] wait up to 60 s for {0}, then open it in the default browser" -f $url) -ForegroundColor DarkGray
    CR-Record 'Start server' 'planned' ('start hidden on port {0}, open {1}' -f $Port, $url)
    return
  }
  if (CR-ServerUp $url) {
    CR-Record 'Start server' 'skipped' ('already answering on {0}' -f $url)
    Start-Process $url
    return
  }
  if (-not (Test-Path -LiteralPath $vbs)) { CR-Record 'Start server' 'failed' 'scripts\start-hidden.vbs not found'; return }
  $oldCr = $env:CR_PORT
  $oldPort = $env:PORT
  try {
    $env:CR_PORT = [string]$Port
    $env:PORT = [string]$Port
    & $wscript $vbs | Out-Host
    $up = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 2
      if (CR-ServerUp $url) { $up = $true; break }
    }
  } finally {
    $env:CR_PORT = $oldCr
    $env:PORT = $oldPort
  }
  if ($up) {
    CR-Record 'Start server' 'done' ('answering on {0}' -f $url)
    Start-Process $url
  } else {
    CR-Record 'Start server' 'failed' ('no answer on {0} after 60 s - see %USERPROFILE%\.claude-control-room\server.log' -f $url)
  }
}

function CR-ResolveRef {
  if ($Ref) { return $Ref }
  try {
    $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/OAKHEN1412/claude-control-room/releases/latest' -Headers @{ 'User-Agent' = 'cr-installer'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 15
    if ($r.tag_name) { return [string]$r.tag_name }
  } catch { }
  return 'main'
}

function CR-Header([int]$n, [string]$title) {
  Write-Host ''
  Write-Host ("[{0}/10] {1}" -f $n, $title) -ForegroundColor Cyan
}

function CR-Main {
  $results = New-Object System.Collections.ArrayList
  CR-EnableTls12
  Write-Host 'Claude Control Room installer' -ForegroundColor Cyan
  if ($DryRun) { Write-Host 'DRY RUN - nothing will be changed.' -ForegroundColor Yellow }
  $Ref = CR-ResolveRef
  Write-Host ("Version: {0}" -f $Ref)
  Write-Host ("App folder: {0}" -f $InstallDir)
  Write-Host ("Data dir: {0}" -f (CR-DataDir))

  $steps = @(
    @{ N = 1; Title = 'Node.js 22.18+'; Fn = 'CR-StepNode'; Name = 'Node.js' },
    @{ N = 2; Title = 'Git'; Fn = 'CR-StepGit'; Name = 'Git' },
    @{ N = 3; Title = 'Claude Code CLI'; Fn = 'CR-StepClaude'; Name = 'Claude Code CLI' },
    @{ N = 4; Title = 'ffmpeg'; Fn = 'CR-StepFfmpeg'; Name = 'ffmpeg' },
    @{ N = 5; Title = 'App checkout'; Fn = 'CR-StepClone'; Name = 'App checkout' },
    @{ N = 6; Title = 'Dependencies and build'; Fn = 'CR-StepBuild'; Name = 'npm ci + build' },
    @{ N = 7; Title = 'Config and install marker'; Fn = 'CR-StepConfig'; Name = 'config.json' },
    @{ N = 8; Title = 'Startup shortcut and cr command'; Fn = 'CR-StepShortcuts'; Name = 'Startup shortcut + cr' },
    @{ N = 9; Title = 'Video toolchain'; Fn = 'CR-StepVideo'; Name = 'Video toolchain' },
    @{ N = 10; Title = 'Start server and open browser'; Fn = 'CR-StepStart'; Name = 'Start server' }
  )
  foreach ($s in $steps) {
    CR-Header $s.N $s.Title
    try {
      & $s.Fn
    } catch {
      CR-Record $s.Name 'failed' ($_.Exception.Message)
    }
  }

  Write-Host ''
  Write-Host 'Summary' -ForegroundColor Cyan
  $results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  Write-Host ('Health check: cd "{0}" and run: npm run doctor' -f $InstallDir)
  Write-Host 'Run "claude" once in a terminal to sign in to Claude Code.'
  Write-Host ('Uninstall later: powershell -ExecutionPolicy Bypass -File "{0}\uninstall.ps1"' -f $InstallDir)
}

# Piped runs get no parameters, so read the env vars. Then run.
if ($env:CR_INSTALL_YES -eq '1') { $Yes = $true }
if ($env:CR_INSTALL_DRYRUN -eq '1') { $DryRun = $true }
if (-not $InstallDir) {
  if ($env:CR_INSTALL_DIR) { $InstallDir = $env:CR_INSTALL_DIR }
  else { $InstallDir = Join-Path $env:LOCALAPPDATA 'ClaudeControlRoom\app' }
}
if (-not $Ref -and $env:CR_INSTALL_REF) { $Ref = $env:CR_INSTALL_REF }

CR-Main
