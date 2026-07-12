<#
  The ONLY supported way to start Chrome for this system.

  You cannot attach Playwright to a Chrome that was started normally. The debug port only
  exists if Chrome was LAUNCHED with --remote-debugging-port, and Chrome 136+ refuses that
  flag when pointed at the default user-data-dir (a deliberate security fix). So this uses a
  DEDICATED user-data-dir - one that clone-chrome-profile.ps1 fills with a copy of your real,
  already-signed-in Chrome profile, so you never have to log in to Snorkel again.

  ASCII only, deliberately: Windows PowerShell 5.1 reads a BOM-less .ps1 as cp1252, so a
  stray em-dash decodes to a smart quote and the parser dies on an unterminated string.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\launch-chrome.ps1
    powershell -ExecutionPolicy Bypass -File scripts\launch-chrome.ps1 -Port 9222
#>
param(
  # Must match CHROME_AUTOMATION_PROFILE / CDP_URL in .env. $PSScriptRoot is <repo>/scripts,
  # so its parent's parent is the repo parent - never a hard-coded drive letter.
  [string]$UserDataDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ".chrome-automation-profile"),
  [int]$Port = 9222,
  [string]$StartUrl = "https://experts.snorkel-ai.com/home"
)

$ErrorActionPreference = "Stop"

# Normalize before anything quotes it. A trailing "\" ends up as \" inside the --user-data-dir
# flag, where it escapes the closing quote and Chrome eats the rest of the command line as part
# of the path; and a RELATIVE dir would be resolved by Chrome against Start-Process's working
# directory, which is the host process's cwd, not necessarily the one you typed this in.
if (-not [System.IO.Path]::IsPathRooted($UserDataDir)) { $UserDataDir = Join-Path (Get-Location).Path $UserDataDir }
$UserDataDir = [System.IO.Path]::GetFullPath($UserDataDir).TrimEnd('\')

function Test-Cdp([int]$p) {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 2 } catch { return $null }
}

# ---- 1. Already up? -------------------------------------------------------------------
# Never start a second browser on a live port: Playwright attaches to whichever process owns
# the socket, which is not necessarily the window you are looking at.
$v = Test-Cdp $Port
if ($v) {
  Write-Host ""
  Write-Host "Chrome is already exposing CDP on port $Port ($($v.Browser))." -ForegroundColor Green
  Write-Host "Nothing to do - the worker can attach. Verify with: npm run preflight"
  Write-Host ""
  exit 0
}

# ---- 2. The profile must already exist ------------------------------------------------
# Creating it silently would open a logged-out browser, and every Snorkel page would render
# as a sign-in wall. That reads like a broken scraper, not a missing profile - so refuse.
if (-not (Test-Path -LiteralPath $UserDataDir)) {
  $clone = Join-Path $PSScriptRoot "clone-chrome-profile.ps1"
  # Echo -UserDataDir back into every command we print. A custom dir that is only half-repeated
  # sends the user to the DEFAULT dir on the next run, which is a different empty profile and a
  # genuinely baffling place to end up.
  $defaultUdd = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ".chrome-automation-profile").TrimEnd('\')
  $uddArg = if ($UserDataDir -ine $defaultUdd) { " -UserDataDir `"$UserDataDir`"" } else { "" }
  $cloneDestArg = if ($UserDataDir -ine $defaultUdd) { " -DestDir `"$UserDataDir`"" } else { "" }

  Write-Host ""
  Write-Host "No automation profile at: $UserDataDir" -ForegroundColor Red
  Write-Host ""
  Write-Host "Create it by cloning your signed-in Chrome profile (close Chrome first):" -ForegroundColor Yellow
  Write-Host "    powershell -ExecutionPolicy Bypass -File `"$clone`"$cloneDestArg"
  Write-Host "  (no -SourceProfile needed: it finds the profile that has actually been to"
  Write-Host "   snorkel-ai.com, and if that is ambiguous it lists every profile it can see)"
  Write-Host ""
  Write-Host "Or, if you would rather sign in to Snorkel by hand in a blank browser:" -ForegroundColor Yellow
  Write-Host "    mkdir `"$UserDataDir`""
  Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"$uddArg"
  Write-Host "  ...then sign in once in the window that opens; the session persists there."
  Write-Host ""
  exit 1
}

# Chrome 136+ hard-refuses --remote-debugging-port on the real user-data-dir and exits, which
# looks exactly like "CDP never came up". Catch the mistake here, where we can explain it.
$defaultUdd = (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data").TrimEnd('\')
if ($UserDataDir -ieq $defaultUdd) {
  Write-Host ""
  Write-Host "-UserDataDir points at Chrome's DEFAULT profile directory." -ForegroundColor Red
  Write-Host "Chrome 136+ refuses --remote-debugging-port there, so CDP can never come up."
  Write-Host "Clone that profile into a dedicated dir instead:" -ForegroundColor Yellow
  Write-Host "    powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'clone-chrome-profile.ps1')`""
  Write-Host ""
  exit 1
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "Could not find chrome.exe in Program Files or LOCALAPPDATA." -ForegroundColor Red
  Write-Host "Install Google Chrome, or add its path to the search list at the top of this script." -ForegroundColor Yellow
  exit 1
}

# ---- 3. Launch ------------------------------------------------------------------------
# --profile-directory=Default: the clone lands the profile in Default, but the Local State it
# copied still lists every profile of your real Chrome and names whichever one you had open as
# last-used. Left alone Chrome recreates THAT folder, empty, in here and opens it - a pristine,
# signed-out profile sitting right next to the good one, which is the exact "Snorkel logged me
# out" symptom the clone exists to prevent. Pin it.
# Values are quoted because a user-data-dir path may contain spaces.
$chromeArgs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`"",
  "--profile-directory=Default",
  "--no-first-run",
  "--no-default-browser-check",
  $StartUrl
)

Write-Host ""
Write-Host "Starting Chrome with CDP on port $Port ..." -ForegroundColor Cyan
Write-Host "  profile: $UserDataDir"
$proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru

# ---- 4. Wait for CDP ------------------------------------------------------------------
# A cold start on a freshly-cloned profile is slow (Chrome rebuilds every cache the clone
# skipped), so poll rather than sleep a fixed amount and hope.
$deadline = (Get-Date).AddSeconds(15)
$v = $null
while (-not $v -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $v = Test-Cdp $Port
}

if ($v) {
  Write-Host ""
  Write-Host "CDP is up: $($v.Browser) on http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "  profile: $UserDataDir"
  Write-Host "  Leave this browser open - the worker attaches to it. Closing the window kills CDP."
  Write-Host ""
  exit 0
}

Write-Host ""
Write-Host "Chrome started but nothing is answering CDP on port $Port after 15s." -ForegroundColor Red
Write-Host ""
if ($proc -and $proc.HasExited) {
  # The giveaway: chrome.exe handed its command line to an EXISTING Chrome that already owns
  # this user-data-dir, then exited. That older process was never given --remote-debugging-port,
  # so the port does not exist and never will until every Chrome window is closed.
  Write-Host "The chrome.exe we launched exited immediately (code $($proc.ExitCode))." -ForegroundColor Yellow
  Write-Host "That means another Chrome ALREADY owns this user-data-dir and took over the request."
} else {
  Write-Host "Overwhelmingly the cause: another Chrome already owns this user-data-dir." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Fix it:" -ForegroundColor Yellow
Write-Host "    1. Close ALL Chrome windows (check the system tray), or force it:"
Write-Host "           Stop-Process -Name chrome -Force"
Write-Host "    2. Run this script again:"
Write-Host "           powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
Write-Host ""
Write-Host "If something else is squatting on the port, pick another and set CDP_URL in .env to match:"
Write-Host "           powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port 9333"
Write-Host ""
exit 1
