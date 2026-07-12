<#
  Bootstrap check for a NEW machine.

  This system is developed on one machine and runs on another. Everything below has a
  failure mode that shows up late and expensively if it is not caught here: a missing
  Playwright browser surfaces at upload time, a dead Docker daemon surfaces six minutes
  into a build, and a Claude login belonging to a different OS user surfaces 45 minutes
  into a session that has already spent your quota.

  So this checks everything, reports everything, and prints the exact command that fixes
  each failure. It never repairs silently except for the two things that are safe to do
  for you (create .env from .env.example, and - if you say yes - run npm install).

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
    powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Yes    # unattended: npm install without asking
#>
param(
  [switch]$Yes
)

# NOT 'Stop'. Windows PowerShell turns a native exe's stderr into a terminating error when
# ErrorActionPreference is Stop, and `docker info` on a dead daemon writes to stderr and
# exits non-zero - which is a RESULT here, not a crash. Every native call checks
# $LASTEXITCODE explicitly instead.
$ErrorActionPreference = "Continue"

# Never hard-code a path. The repo is wherever this script's parent is.
$Repo = Split-Path -Parent $PSScriptRoot

$checks = New-Object System.Collections.ArrayList

function Add-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail,
    [string]$Fix = "",
    [bool]$Required = $true
  )
  [void]$checks.Add([pscustomobject]@{
    Name = $Name; Ok = $Ok; Detail = $Detail; Fix = $Fix; Required = $Required
  })
}

# ASCII markers, not check-mark glyphs: Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI, so any non-ASCII character in this file would print as mojibake on exactly the
# fresh machine this script exists to serve.
function Write-Report {
  Write-Host ""
  foreach ($c in $checks) {
    if ($c.Ok)          { $mark = "[ OK ]"; $color = "Green" }
    elseif ($c.Required){ $mark = "[FAIL]"; $color = "Red" }
    else                { $mark = "[WARN]"; $color = "Yellow" }
    Write-Host ("{0} {1,-22} {2}" -f $mark, $c.Name, $c.Detail) -ForegroundColor $color
    if (-not $c.Ok -and $c.Fix) {
      foreach ($line in $c.Fix -split "`n") {
        Write-Host ("       -> " + $line) -ForegroundColor DarkGray
      }
    }
  }
  Write-Host ""
}

Write-Host ""
Write-Host "Snorkel Automation Workflow - target machine setup" -ForegroundColor Cyan
Write-Host ("repo: " + $Repo) -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. Node
# The version gate is on MAJOR.MINOR, not major alone, and that detail is the whole point.
# Every entrypoint here runs .ts directly under --experimental-strip-types. That flag landed
# in 22.6.0 and was backported only as far back as 20.19.0. On 20.0-20.18, and on the whole
# of 21.x, node does not merely ignore it - it refuses to boot:
#     node: bad option: --experimental-strip-types
# So a bare ">= 20" check greenlights a machine on which literally every npm script in this
# repo dies on its first line. "Node 20 LTS" from an older installer or a corporate image is
# exactly that machine, which makes this the most valuable check in the file.
$NODE_FIX = "Install Node 22 LTS (or newer): https://nodejs.org`nThis repo runs .ts files directly - it never compiles them - and that needs --experimental-strip-types, which exists only in Node >= 22.6 or >= 20.19."
$nodeVersion = $null
try { $nodeVersion = (& node -v) } catch { }

if (-not $nodeVersion) {
  Add-Check "Node.js" $false "node is not on PATH" $NODE_FIX
} else {
  # Tolerate 'v22.6.0', 'v23.0.0-nightly...', and a two-part 'v20.19'.
  $v = $null
  try { $v = [version](($nodeVersion.Trim() -replace '^v', '') -replace '[-+].*$', '') } catch { }

  if (-not $v) {
    Add-Check "Node.js" $false "cannot parse version '$nodeVersion'" $NODE_FIX
  } else {
    $minor = [math]::Max($v.Minor, 0)  # [version]'20' leaves Minor at -1
    $ok =
      if     ($v.Major -ge 23) { $true }            # 23+: type stripping is on by default
      elseif ($v.Major -eq 22) { $minor -ge 6 }     # the release the flag shipped in
      elseif ($v.Major -eq 20) { $minor -ge 19 }    # the LTS backport
      else                     { $false }           # 21.x never got it; <20 predates it

    if ($ok) {
      Add-Check "Node.js" $true "$nodeVersion"
    } else {
      Add-Check "Node.js" $false "$nodeVersion cannot run this repo (need >= 22.6, or >= 20.19)" $NODE_FIX
    }
  }
}

# ------------------------------------------------------- 2. npm install has been run
$nodeModules = Join-Path $Repo "node_modules"
if (-not (Test-Path -LiteralPath $nodeModules)) {
  $doInstall = $Yes
  if (-not $doInstall) {
    $answer = Read-Host "node_modules is missing. Run 'npm install' now? [y/N]"
    $doInstall = ($answer -match '^(y|yes)$')
  }
  if ($doInstall) {
    Write-Host "running npm install ..." -ForegroundColor DarkGray
    Push-Location $Repo
    & npm install
    $installCode = $LASTEXITCODE
    Pop-Location
    if ($installCode -eq 0 -and (Test-Path -LiteralPath $nodeModules)) {
      Add-Check "Dependencies" $true "npm install completed"
    } else {
      Add-Check "Dependencies" $false "npm install exited $installCode" `
        "Run it yourself and read the error:  npm install"
    }
  } else {
    Add-Check "Dependencies" $false "node_modules is missing" `
      "npm install"
  }
} else {
  Add-Check "Dependencies" $true "node_modules present"
}

# --------------------------------------------------------- 3. Playwright browsers
# We drive YOUR Chrome over CDP, so this download is not what clicks the Snorkel buttons.
# Install it anyway: it costs one command and it removes "is Playwright even installed
# properly" from the list of suspects when an attach fails at 2am.
$pwCache = if ($env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH } else { Join-Path $env:LOCALAPPDATA "ms-playwright" }
$chromiumBuild = $null
if (Test-Path -LiteralPath $pwCache) {
  $chromiumBuild = Get-ChildItem -LiteralPath $pwCache -Directory -Filter "chromium-*" | Select-Object -First 1
}
if ($chromiumBuild) {
  Add-Check "Playwright chromium" $true $chromiumBuild.Name -Required $false
} else {
  Add-Check "Playwright chromium" $false "not in $pwCache" `
    "npx playwright install chromium" -Required $false
}

# ------------------------------------------------------------- 4. Docker daemon
# The verify gate IS Docker. Without the daemon there is no oracle run, no null run, and
# no reason to let a build start.
$dockerVersion = $null
try { $dockerVersion = (& docker info --format "{{.ServerVersion}}" 2>$null) } catch { }

if (-not $dockerVersion -or $LASTEXITCODE -ne 0) {
  Add-Check "Docker daemon" $false "docker info did not answer" `
    "Start Docker Desktop and wait for it to report Running, then re-run this script.`nIf 'docker' is not on PATH at all, install Docker Desktop first."
} else {
  Add-Check "Docker daemon" $true ("server v" + ($dockerVersion | Select-Object -First 1))
}

# --------------------------------------------------------- 5. Claude Code login
# The Agent SDK spawns the Claude Code CLI, which reads credentials from ~/.claude.
# There is no API key anywhere in this system, by design. If the worker runs as a
# different OS user than the one that signed in, that directory simply is not there and
# every build fails on auth after it has already started.
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$whoami = "$env:USERDOMAIN\$env:USERNAME"
$credFiles = @(
  (Join-Path $claudeDir ".credentials.json"),
  (Join-Path $claudeDir "credentials.json")
) | Where-Object { Test-Path -LiteralPath $_ }

if ($credFiles) {
  Add-Check "Claude Code login" $true "credentials in $claudeDir (user $whoami)"
} elseif (Test-Path -LiteralPath $claudeDir) {
  # Same tolerance as apps/worker/src/preflight.ts: the CLI may keep the token in the OS
  # credential store rather than a file, so the directory existing is good enough here.
  Add-Check "Claude Code login" $true "$claudeDir exists (user $whoami; token may be in the OS keychain)"
} else {
  Add-Check "Claude Code login" $false "no .claude directory for user $whoami" `
    "Run 'claude login' AS THIS OS USER ($whoami), or sign in with the Claude Code VS Code extension while logged in as this user.`nThe worker MUST run as the same OS user that is signed in - it inherits that login and has no API key to fall back on."
}

# ------------------------------------------------------------------ 6. .env
$envPath = Join-Path $Repo ".env"
$envExample = Join-Path $Repo ".env.example"
$FILL_HINT = "Open .env and set SUPABASE_URL and SUPABASE_SECRET_KEY (the sb_secret_... one - the publishable key cannot write).`nSNORKEL_ROOT only needs setting if documentation/ is NOT in this repo's parent folder."

# Strip the surrounding quotes dotenv would strip, THEN test for the placeholder. Without the
# unquoting, SUPABASE_SECRET_KEY="sb_secret_..." ends in a quote rather than a dot, sails past
# the '...' test as if it were filled in, and the first real Supabase call answers 401 - a
# long way from its cause, which is the exact failure this check exists to pre-empt.
function Get-EnvValue([string]$line) {
  return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'").Trim()
}

if (-not (Test-Path -LiteralPath $envPath)) {
  if (Test-Path -LiteralPath $envExample) {
    Copy-Item -LiteralPath $envExample -Destination $envPath
    Add-Check ".env" $false "created from .env.example - it is not filled in yet" $FILL_HINT
  } else {
    Add-Check ".env" $false ".env and .env.example are both missing" `
      "Restore .env.example from the repo."
  }
} else {
  # A placeholder is worse than a missing value: Supabase answers 401 and the error lands a
  # long way from its cause. Empty, or still ending in '...', means unfilled.
  $envVals = @{}
  foreach ($line in (Get-Content -LiteralPath $envPath)) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k = ($line -split '=', 2)[0].Trim()
    $v = Get-EnvValue $line
    if ($v -ne "" -and $v -notmatch '\.\.\.$') { $envVals[$k] = $v }
  }

  # ONLY these two are read at runtime (packages/shared/src/supabase.ts). Blocking setup on
  # a key nothing reads would train you to ignore this report, so the rest are a warning.
  $missing = @()
  if (-not ($envVals.ContainsKey("SUPABASE_URL") -or $envVals.ContainsKey("NEXT_PUBLIC_SUPABASE_URL"))) { $missing += "SUPABASE_URL" }
  if (-not ($envVals.ContainsKey("SUPABASE_SECRET_KEY") -or $envVals.ContainsKey("SUPABASE_SERVICE_ROLE_KEY"))) { $missing += "SUPABASE_SECRET_KEY" }

  if ($missing.Count -gt 0) {
    Add-Check ".env" $false ("not filled in: " + ($missing -join ", ")) $FILL_HINT
  } else {
    Add-Check ".env" $true "SUPABASE_URL + SUPABASE_SECRET_KEY are set"
  }

  # Everything else in .env.example is reference-only today (the publishable keys and the
  # management token are never read by the worker or the dashboard). Say so rather than
  # letting you wonder whether a placeholder there is about to break something.
  $stale = @()
  foreach ($line in (Get-Content -LiteralPath $envPath)) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k = ($line -split '=', 2)[0].Trim()
    if (-not $envVals.ContainsKey($k)) { $stale += $k }
  }
  $stale = $stale | Where-Object { $_ -notin $missing }
  if ($stale.Count -gt 0) {
    Add-Check ".env extras" $false ("still a placeholder: " + ($stale -join ", ")) `
      "Nothing reads these at runtime - the dashboard reaches Supabase only through its own server-side API routes, and SUPABASE_ACCESS_TOKEN is for schema migrations. Fill them in only if you need them." -Required $false
  }
}

# ------------------------------------------------------------ 7. SNORKEL_ROOT
# Same rule as packages/shared/src/paths.ts, and the same precedence dotenv gives it:
# a real process env var wins, then .env, then the repo's parent folder. The constant is
# NOT duplicated here - we only resolve the folder and look for documentation/ in it,
# because without the docs the playbook cannot be rebuilt and every build is ungrounded.
$snorkelRoot = $env:SNORKEL_ROOT
if (-not $snorkelRoot -and (Test-Path -LiteralPath $envPath)) {
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*SNORKEL_ROOT\s*=' } | Select-Object -First 1
  if ($line) { $snorkelRoot = Get-EnvValue $line }
}
if (-not $snorkelRoot) { $snorkelRoot = Split-Path -Parent $Repo }

# A RELATIVE SNORKEL_ROOT (paths.ts allows one - it just calls resolve()) must be anchored to
# the repo, not to wherever you happened to be standing when you invoked this script.
# [IO.Path]::GetFullPath alone would anchor it to the .NET process CWD, which PowerShell's own
# Set-Location does not even move: the answer would then depend on how the shell was started.
if (-not [System.IO.Path]::IsPathRooted($snorkelRoot)) {
  $snorkelRoot = Join-Path $Repo $snorkelRoot
}
$snorkelRoot = [System.IO.Path]::GetFullPath($snorkelRoot)

$docsDir = Join-Path $snorkelRoot "documentation"
if (Test-Path -LiteralPath $docsDir) {
  $docCount = (Get-ChildItem -LiteralPath $docsDir -Recurse -File | Measure-Object).Count
  Add-Check "SNORKEL_ROOT" $true "$snorkelRoot (documentation/: $docCount files)"
} else {
  Add-Check "SNORKEL_ROOT" $false "no documentation/ under $snorkelRoot" `
    "Set SNORKEL_ROOT in .env to the folder that contains documentation/, Working/ and Accepted/.`nIt defaults to this repo's parent folder, which is how the machine is laid out today."
}

# -------------------------------------------------------- 8. The playbook (summary.txt)
# prompts/summary.txt is the distilled Snorkel documentation that every build prompt is
# grounded in. A truncated one is worse than a missing one: the build still runs, costs
# 45 minutes, and produces a task that breaks a rule nobody told Claude about.
$summary = Join-Path $Repo "prompts\summary.txt"
if (-not (Test-Path -LiteralPath $summary)) {
  Add-Check "Playbook" $false "prompts/summary.txt is missing" `
    "npm run summary:build   (reads $docsDir)"
} else {
  $kb = [math]::Round((Get-Item -LiteralPath $summary).Length / 1KB)
  if ($kb -lt 15) {
    Add-Check "Playbook" $false "prompts/summary.txt is only ${kb} KB - looks truncated" `
      "npm run summary:build   (reads $docsDir)"
  } else {
    Add-Check "Playbook" $true "prompts/summary.txt (${kb} KB)"
  }
}

# ------------------------------------------------------------------- report
Write-Report

$blocking = @($checks | Where-Object { -not $_.Ok -and $_.Required })
$warnings = @($checks | Where-Object { -not $_.Ok -and -not $_.Required })

if ($blocking.Count -gt 0) {
  Write-Host ("$($blocking.Count) required check(s) failed. Fix them and run this again.") -ForegroundColor Red
  Write-Host ""
  exit 1
}
if ($warnings.Count -gt 0) {
  Write-Host ("$($warnings.Count) optional check(s) failed - see above.") -ForegroundColor Yellow
}

Write-Host "All required checks passed." -ForegroundColor Green
Write-Host ""
Write-Host "WHAT TO DO NEXT" -ForegroundColor Cyan
Write-Host "---------------"
Write-Host "1. Apply the database migration, once, in the Supabase SQL editor:"
Write-Host "      scripts\migrate.sql                (additive - safe to re-run)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "2. First run only - clone your signed-in Chrome profile so the automation"
Write-Host "   browser is already logged in to Snorkel:"
Write-Host "      powershell -File scripts\clone-chrome-profile.ps1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "3. Launch the automation Chrome and leave it open (Playwright can only attach"
Write-Host "   to a Chrome that was STARTED with --remote-debugging-port):"
Write-Host "      powershell -File scripts\launch-chrome.ps1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "4. Prove the verify gate works BEFORE spending a Claude session on it - point"
Write-Host "   it at a task you already know is good:"
Write-Host ("      npm run verify:task -- `"" + (Join-Path $snorkelRoot "Accepted\<a-known-good>.zip") + "`"") -ForegroundColor DarkGray
Write-Host ""
Write-Host "5. Start the worker, in its own terminal, AS THIS OS USER ($whoami):"
Write-Host "      npm run worker                     (it re-runs these checks on boot)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "6. Start the dashboard:"
Write-Host "      npm run dev -w @saw/web            -> http://localhost:3100" -ForegroundColor DarkGray
Write-Host ""
Write-Host "7. Paste a task, press Preview, Add to queue. Nothing spends money until you"
Write-Host "   press Start Build."
Write-Host ""
exit 0
