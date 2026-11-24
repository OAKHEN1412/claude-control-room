<#
  Opens Claude Control Room (v2 canvas) as ONE app window spanning every monitor.

  - horizontal extent = union of all screens; vertical extent = intersection of their working areas
    (taskbar excluded), so nothing hides under a taskbar or off the lower/upper edge
  - Chrome if installed, else Edge, with its own --user-data-dir so --window-position / --window-size are
    honoured even while the normal browser is running (this profile has no extensions)
  - the monitor boundaries go into the URL (&seams=1920) as client-x so the page keeps panes and popups off them
  - one screen: just opens the URL normally in the default browser

  -DryRun       print the command line instead of launching
  -ScreensJson  test hook: screens as JSON [{x,y,w,h,wx,wy,ww,wh}] (bounds + working area) instead of reading them
  Mirror of web/src/canvas/wideWindow.ts (same maths, unit-tested together).
#>
[CmdletBinding()]
param(
  [string]$Url = 'http://127.0.0.1:8790/?ui=v2',
  [switch]$DryRun,
  [string]$ScreensJson = '',
  [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'ClaudeControlRoom\wide-profile')
)

$ErrorActionPreference = 'Stop'

function Get-Screens {
  if ($ScreensJson) {
    return @(($ScreensJson | ConvertFrom-Json) | ForEach-Object {
      [pscustomobject]@{ X = [int]$_.x; Y = [int]$_.y; W = [int]$_.w; H = [int]$_.h; WX = [int]$_.wx; WY = [int]$_.wy; WW = [int]$_.ww; WH = [int]$_.wh }
    })
  }
  Add-Type -AssemblyName System.Windows.Forms
  return @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [pscustomobject]@{
      X = $_.Bounds.X; Y = $_.Bounds.Y; W = $_.Bounds.Width; H = $_.Bounds.Height
      WX = $_.WorkingArea.X; WY = $_.WorkingArea.Y; WW = $_.WorkingArea.Width; WH = $_.WorkingArea.Height
    }
  })
}

# Returns @{ X; Y; W; H; Seams = int[] } or $null (one screen / no usable common band).
function Get-WideWindow($screens) {
  if ($screens.Count -lt 2) { return $null }
  $sorted = @($screens | Sort-Object X)
  $left = ($sorted | Measure-Object -Property X -Minimum).Minimum
  $right = ($sorted | ForEach-Object { $_.X + $_.W } | Measure-Object -Maximum).Maximum
  $top = ($sorted | Measure-Object -Property WY -Maximum).Maximum
  $bottom = ($sorted | ForEach-Object { $_.WY + $_.WH } | Measure-Object -Minimum).Minimum
  if (($bottom - $top) -lt 300 -or ($right - $left) -lt 600) { return $null }
  $seams = @()
  foreach ($s in $sorted) {
    $cx = $s.X - $left
    if ($cx -gt 0 -and $cx -lt ($right - $left) -and ($seams -notcontains $cx)) { $seams += $cx }
  }
  return @{ X = $left; Y = $top; W = $right - $left; H = $bottom - $top; Seams = $seams }
}

function Find-Browser {
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

$wide = Get-WideWindow (Get-Screens)
if (-not $wide) {
  if ($DryRun) { Write-Output "OPEN-DEFAULT $Url"; return }
  Start-Process $Url
  return
}

$sep = if ($Url.Contains('?')) { '&' } else { '?' }
$target = $Url + $sep + 'seams=' + ($wide.Seams -join ',')

$browser = Find-Browser
if (-not $browser) {
  if ($DryRun) { Write-Output "OPEN-DEFAULT $target"; return }
  Start-Process $target
  return
}

$argv = @(
  "--app=$target",
  "--window-position=$($wide.X),$($wide.Y)",
  "--window-size=$($wide.W),$($wide.H)",
  "--user-data-dir=$ProfileDir",
  '--no-first-run'
)

$quoted = $argv | ForEach-Object { if ($_ -match '\s') { $i = $_.IndexOf('='); '{0}"{1}"' -f $_.Substring(0, $i + 1), $_.Substring($i + 1) } else { $_ } }

if ($DryRun) {
  Write-Output ('"{0}" {1}' -f $browser, ($quoted -join ' '))
  return
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$p = Start-Process -FilePath $browser -ArgumentList ($quoted -join ' ') -PassThru
Write-Output "PID $($p.Id)"
