<#
  Clone your real, already-signed-in Chrome profile into a DEDICATED user-data-dir that
  Chrome is willing to expose CDP from.

  Why this exists at all:
    Playwright can only attach to a Chrome that was STARTED with --remote-debugging-port,
    and Chrome 136+ refuses that flag when it points at the default user-data-dir (a
    deliberate security fix - otherwise any local process could read your live session).
    So automation needs its own user-data-dir. Cloning it from your real profile is what
    saves you from signing in to Snorkel again in a blank window.

  What actually carries the login: Cookies, "Login Data", "Web Data", "Local Storage",
  "Session Storage", Network\ AND the top-level "Local State" - that last one holds
  os_crypt.encrypted_key, the DPAPI-wrapped key every cookie is encrypted with. Copy the
  cookies without Local State and you get a database of undecryptable bytes, i.e. a
  logged-out browser with none of the obvious symptoms.

  ASCII only, deliberately: Windows PowerShell 5.1 reads a BOM-less .ps1 as cp1252, so a
  stray em-dash decodes to a smart quote and the parser dies on an unterminated string.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\clone-chrome-profile.ps1
    powershell -ExecutionPolicy Bypass -File scripts\clone-chrome-profile.ps1 -SourceProfile "Your Chrome" -Force
#>
param(
  # Empty on purpose. A hard-coded default here is a lie on every machine but one, and the
  # failure it produces ("No profile matching 'Rickie'") looks like a broken script rather
  # than a wrong argument. Left empty we ASK CHROME which profile has actually been used
  # against Snorkel - see Test-UsedSnorkel. Accepts the display name from the avatar menu,
  # the signed-in email, or the raw folder name ("Profile 7").
  [string]$SourceProfile = "",
  [string]$SourceUserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data",
  # Defaults to <repo parent>/.chrome-automation-profile, matching CHROME_AUTOMATION_PROFILE
  # in .env.example. $PSScriptRoot is <repo>/scripts, so its parent's parent is the repo parent.
  [string]$DestDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ".chrome-automation-profile"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# The default Chrome profile folder used to hold the cookie DB at <profile>\Cookies. Since
# Chrome 96 it lives under Network\, and NOTHING on a current install has the old one. Both
# are checked at the end, because reporting "login did not come across" against a path Chrome
# stopped writing in 2021 would call every healthy clone a failure.
$COOKIE_PATHS = @("Network\Cookies", "Cookies")

function Format-Size([double]$bytes) {
  if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
  return "{0:N0} KB" -f ($bytes / 1KB)
}

# Has this profile ever loaded Snorkel? Preferences carries a content-settings / site-engagement
# row per origin the profile has visited, so the profile that has been to experts.snorkel-ai.com
# names itself. This is the one question that matters, and the answer is worth more than any
# name we could bake into a default - it stays right on a machine we have never seen.
function Test-UsedSnorkel([string]$profileDir) {
  $prefs = Join-Path $profileDir "Preferences"
  if (-not (Test-Path -LiteralPath $prefs)) { return $false }
  try { return [System.IO.File]::ReadAllText($prefs).Contains("snorkel-ai.com") } catch { return $false }
}

function Write-ProfileList($items) {
  # Snorkel profiles first: on a machine with 20 profiles the answer must not be buried.
  foreach ($e in ($items | Sort-Object @{ Expression = { -not $_.HasSnorkel } }, Name)) {
    $who = if ($e.UserName) { $e.UserName } elseif ($e.GaiaName) { $e.GaiaName } else { "(no account)" }
    $tag = if ($e.HasSnorkel) { "  <-- has used snorkel-ai.com" } else { "" }
    Write-Host ("    {0,-24} {1,-32} {2,-10}{3}" -f $e.Name, $who, $e.Dir, $tag)
  }
}

# A relative or trailing-backslash -DestDir survives all the way into the --user-data-dir flag
# we print, where a trailing "\" escapes the closing quote and Chrome swallows the rest of the
# command line as part of the path. Normalize once, here, so every later use is absolute.
if (-not [System.IO.Path]::IsPathRooted($DestDir)) { $DestDir = Join-Path (Get-Location).Path $DestDir }
$DestDir = [System.IO.Path]::GetFullPath($DestDir).TrimEnd('\')

# -Force does `Remove-Item -Recurse` on this path. A drive root would take the drive with it.
if (-not (Split-Path $DestDir -Parent)) {
  Write-Host "Refusing to use a drive root ($DestDir) as the automation profile." -ForegroundColor Red
  Write-Host "Pass a real folder, e.g. -DestDir `"$(Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.chrome-automation-profile')`""
  exit 1
}

# ---- 1. Chrome must be closed ---------------------------------------------------------
# A running Chrome holds its SQLite files (Cookies, Login Data) open with a WAL that has not
# been checkpointed. Copying them live gives you a torn database: the copy opens fine, is
# missing the newest writes, and presents as "Snorkel logged me out again" days later.
$running = @(Get-Process -Name chrome -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host ""
  Write-Host "Chrome is running ($($running.Count) process(es)). Refusing to copy a live profile." -ForegroundColor Red
  Write-Host "Copying open Chrome databases produces a corrupt, half-logged-out clone."
  Write-Host ""
  Write-Host "Close ALL Chrome windows (check the tray), then re-run this script." -ForegroundColor Yellow
  Write-Host "If a window is not visible, force it:" -ForegroundColor Yellow
  Write-Host "    Stop-Process -Name chrome -Force"
  Write-Host ""
  exit 1
}

# ---- 2. Map display name -> profile directory via Local State -------------------------
$localState = Join-Path $SourceUserDataDir "Local State"
if (-not (Test-Path -LiteralPath $localState)) {
  Write-Host ""
  Write-Host "No Chrome 'Local State' file at: $localState" -ForegroundColor Red
  Write-Host "That path is not a Chrome User Data directory."
  Write-Host "Pass the right one, e.g.:" -ForegroundColor Yellow
  Write-Host "    -SourceUserDataDir `"$env:LOCALAPPDATA\Google\Chrome\User Data`""
  Write-Host ""
  exit 1
}

$state = Get-Content -LiteralPath $localState -Raw -Encoding UTF8 | ConvertFrom-Json
$cache = $state.profile.info_cache
if (-not $cache) {
  Write-Host "Local State has no profile.info_cache - cannot map '$SourceProfile' to a folder." -ForegroundColor Red
  Write-Host "Open Chrome once with the profile you want, close it, and re-run."
  exit 1
}

# info_cache is keyed by DIRECTORY name ("Default", "Profile 7"); the label lives inside as
# .name. gaia_name/user_name are also carried so you can find a profile by its account when
# the display name has been renamed out from under you.
$entries = @($cache.PSObject.Properties | ForEach-Object {
  $dir = $_.Name
  [pscustomobject]@{
    Dir        = $dir
    Name       = [string]$_.Value.name
    GaiaName   = [string]$_.Value.gaia_name
    UserName   = [string]$_.Value.user_name
    HasSnorkel = Test-UsedSnorkel (Join-Path $SourceUserDataDir $dir)
  }
})

$want = $SourceProfile.Trim()
$match = $null

if ($want) {
  $match = $entries | Where-Object {
    $_.Name.Trim() -ieq $want -or $_.GaiaName.Trim() -ieq $want -or
    $_.UserName.Trim() -ieq $want -or $_.Dir -ieq $want
  } | Select-Object -First 1

  if (-not $match) {
    Write-Host ""
    Write-Host "No Chrome profile matching '$SourceProfile' in $SourceUserDataDir" -ForegroundColor Red
    Write-Host ""
    Write-Host "Profiles that DO exist there (display name / account / folder):" -ForegroundColor Yellow
    Write-ProfileList $entries
    Write-Host ""
    Write-Host "Re-run with a display name, an account, or a folder name from that list:" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SourceProfile `"<name>`""
    Write-Host "Or drop -SourceProfile entirely and let this script find the Snorkel profile itself."
    Write-Host ""
    exit 1
  }
} else {
  # No -SourceProfile: let the evidence choose. Exactly one profile that has been to Snorkel is
  # an unambiguous answer, and it is the invocation README and setup.ps1 tell people to use.
  $snorkel = @($entries | Where-Object { $_.HasSnorkel })

  if ($snorkel.Count -eq 1) {
    $match = $snorkel[0]
    $who = if ($match.UserName) { $match.UserName } else { "no account" }
    Write-Host ""
    Write-Host "Auto-selected the only Chrome profile that has used snorkel-ai.com:" -ForegroundColor Cyan
    Write-Host ("    {0}  ({1})  folder {2}" -f $match.Name, $who, $match.Dir)
    Write-Host "    Wrong one? Re-run with -SourceProfile `"<display name>`"."
  } else {
    Write-Host ""
    if ($snorkel.Count -eq 0) {
      # Cloning a profile that has never seen Snorkel produces a browser with no Snorkel cookie:
      # a clone that "worked" and still lands on a sign-in wall. Refuse instead.
      Write-Host "No Chrome profile here has ever loaded snorkel-ai.com, so there is no Snorkel login to clone." -ForegroundColor Red
      Write-Host ""
      Write-Host "Sign in to https://experts.snorkel-ai.com in the Chrome profile you want to use," -ForegroundColor Yellow
      Write-Host "fully close Chrome, and run this again. Or name a profile anyway:" -ForegroundColor Yellow
    } else {
      Write-Host "$($snorkel.Count) profiles have used snorkel-ai.com. Say which one is signed in:" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-ProfileList $entries
    Write-Host ""
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SourceProfile `"<name>`""
    Write-Host ""
    exit 1
  }
}

$srcProfileDir = Join-Path $SourceUserDataDir $match.Dir
if (-not (Test-Path -LiteralPath $srcProfileDir)) {
  Write-Host "Local State says '$SourceProfile' lives in '$($match.Dir)', but $srcProfileDir does not exist." -ForegroundColor Red
  Write-Host "The profile was probably deleted. Open Chrome, confirm the profile, then re-run."
  exit 1
}

# ---- 3. Destination -------------------------------------------------------------------
if (Test-Path -LiteralPath $DestDir) {
  if (-not $Force) {
    # Echo back only the arguments they actually passed. Printing -SourceProfile "" (the
    # auto-detect default) as something to type back is noise that reads like a broken command.
    $spArg = if ($SourceProfile) { " -SourceProfile `"$SourceProfile`"" } else { "" }
    Write-Host ""
    Write-Host "Destination already exists: $DestDir" -ForegroundColor Red
    Write-Host "Overwrite it (this discards anything you did in the automation browser):" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"$spArg -Force"
    Write-Host ""
    exit 1
  }
  Write-Host "Removing existing $DestDir (-Force)..." -ForegroundColor Yellow
  Remove-Item -LiteralPath $DestDir -Recurse -Force
}
# Not New-Item: it has no -LiteralPath on Windows PowerShell 5.1, and its -Path globs, so a repo
# checked out under a folder with [brackets] in the name would silently create nothing.
[void][System.IO.Directory]::CreateDirectory($DestDir)

# Chrome looks for the profile at <user-data-dir>\Default unless told otherwise, so the
# source folder ("Profile 7") is deliberately renamed on the way in. launch-chrome.ps1 also
# passes --profile-directory=Default, because the copied Local State still names whichever
# folder your real Chrome had open as last-used; left to itself Chrome would create THAT
# folder fresh in here and open it - a pristine, signed-out profile beside the good one.
$destProfileDir = Join-Path $DestDir "Default"

if (-not (Get-Command robocopy -ErrorAction SilentlyContinue)) {
  Write-Host "robocopy is missing from PATH. It ships with Windows; check %SystemRoot%\System32." -ForegroundColor Red
  exit 1
}

# Denylist, not allowlist: copy the whole profile MINUS the junk. An allowlist silently misses
# whatever Chrome adds in the next release, and that failure mode is a logged-out clone.
# Everything below is a regenerable cache - hundreds of MB, and Cache\ is often still locked.
$skipDirs = @(
  (Join-Path $srcProfileDir "Cache"),
  (Join-Path $srcProfileDir "Code Cache"),
  (Join-Path $srcProfileDir "GPUCache"),
  (Join-Path $srcProfileDir "Service Worker\CacheStorage"),
  (Join-Path $srcProfileDir "DawnCache"),
  (Join-Path $srcProfileDir "DawnGraphiteCache"),
  (Join-Path $srcProfileDir "DawnWebGPUCache"),
  (Join-Path $srcProfileDir "GrShaderCache"),
  (Join-Path $srcProfileDir "ShaderCache"),
  (Join-Path $srcProfileDir "Crashpad")
)

Write-Host ""
Write-Host "Cloning '$($match.Name)' ($($match.Dir)) -> $destProfileDir" -ForegroundColor Cyan
Write-Host "This takes a few seconds; caches are skipped."

# /E all subdirs incl. empty, /XJ do not follow junctions (Chrome plants some and robocopy
# would walk in circles), /R:1 /W:1 so one stubborn locked file cannot hang the clone for
# minutes on end.
$rcArgs = @($srcProfileDir, $destProfileDir, "/E", "/XJ", "/R:1", "/W:1", "/MT:16",
            "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
foreach ($d in $skipDirs) { $rcArgs += "/XD"; $rcArgs += $d }

& robocopy @rcArgs | Out-Null
# Robocopy does not use normal exit codes: 0-7 are success (1 = files copied, 2 = extras,
# 3 = both). Only >= 8 is a real failure. Treating nonzero as failure rejects every good run.
if ($LASTEXITCODE -ge 8) {
  Write-Host ""
  Write-Host "robocopy failed (exit $LASTEXITCODE) copying $srcProfileDir" -ForegroundColor Red
  Write-Host "Almost always: Chrome re-opened mid-copy and re-locked the files." -ForegroundColor Yellow
  Write-Host "Close every Chrome window and run this script again."
  Write-Host ""
  exit 1
}

# Local State carries os_crypt.encrypted_key. Without it every cookie in the clone is
# undecryptable ciphertext and the browser silently comes up signed out of everything.
Copy-Item -LiteralPath $localState -Destination (Join-Path $DestDir "Local State") -Force

# ---- 4. Summary -----------------------------------------------------------------------
$copied = (Get-ChildItem -LiteralPath $DestDir -Recurse -File -Force -ErrorAction SilentlyContinue |
           Measure-Object -Property Length -Sum).Sum
$cookies = $COOKIE_PATHS | ForEach-Object { Join-Path $destProfileDir $_ } |
           Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

Write-Host ""
Write-Host "Profile cloned." -ForegroundColor Green
Write-Host ("  Source profile   {0}" -f $match.Name)
Write-Host ("  Resolved folder  {0}" -f $srcProfileDir)
Write-Host ("  Destination      {0}" -f $DestDir)
Write-Host ("  Copied           {0}" -f (Format-Size $copied))
if ($cookies) {
  Write-Host ("  Cookies DB       {0} ({1})" -f (Format-Size (Get-Item -LiteralPath $cookies).Length),
                                               (Split-Path $cookies -Leaf))
} else {
  # Not fatal, but it means the Snorkel session did NOT come across. Say so now, rather than
  # letting the worker discover it when a submit hits a sign-in wall at 2am.
  Write-Host "  Cookies DB       MISSING - the Snorkel login did not come across." -ForegroundColor Yellow
  Write-Host "                   You will have to sign in once in the window launch-chrome.ps1 opens." -ForegroundColor Yellow
}

$launch = Join-Path $PSScriptRoot "launch-chrome.ps1"
$defaultDest = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ".chrome-automation-profile"
$destArg = ""
if ($DestDir -ine $defaultDest.TrimEnd('\')) {
  # A non-default dest is only half-configured: the launcher and .env must be told about it too.
  $destArg = " -UserDataDir `"$DestDir`""
}

Write-Host ""
Write-Host "Next, start the automation browser:" -ForegroundColor Cyan
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$launch`"$destArg"
if ($destArg) {
  Write-Host "    ...and set CHROME_AUTOMATION_PROFILE=$DestDir in .env" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "It should open experts.snorkel-ai.com already signed in. If it does not, sign in"
Write-Host "once in that window - the session then persists in this dedicated profile."
Write-Host ""
exit 0
