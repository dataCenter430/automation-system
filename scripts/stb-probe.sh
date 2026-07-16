#!/usr/bin/env bash
#
# stb calibration probe — run this ONCE after `stb login`, then paste me the output.
#
# The integration wrapper (apps/worker/src/stb/cli.ts) makes four assumptions the Snorkel docs do
# not pin down. Each is isolated in one parser function so calibrating to reality is a one-line edit.
# This script captures exactly what a real, logged-in `stb` prints for each, so I calibrate against
# fact instead of guessing. It is READ-ONLY — it lists and inspects, it never creates, submits,
# updates, or sends anything to a reviewer. Safe to run any time.
#
#   ./scripts/stb-probe.sh [PROJECT_ID]
#
# If you omit PROJECT_ID it will try to read it from config/pipeline.json (stb.projectId).
set -uo pipefail
cd "$(dirname "$0")/.."

line() { printf '\n══════════════════════════════════════════════════════════════════\n%s\n══════════════════════════════════════════════════════════════════\n' "$1"; }
show() { echo "\$ $*"; "$@" 2>&1; echo "  (exit $?)"; }

line "0. stb is installed and on PATH"
if ! command -v stb >/dev/null 2>&1; then
  echo "  ❌ stb not found. Install it:"
  echo "     uv tool install snorkelai-stb --find-links https://snorkel-python-wheels.s3.us-west-2.amazonaws.com/stb/index.html --python \">=3.12\""
  exit 1
fi
show stb --version

line "1. logged in? (this should show your key/creds, not an auth error)"
show stb keys show

line "1b. NON-INTERACTIVE LOGIN mechanism — the flag/env we need for headless login from .env"
echo "  We need to log in from STB_API_KEY without a browser. Show how login works:"
show stb login --help
echo "  → Look for: --api-key / --key / --token flag, or an env var it reads (STB_API_KEY?),"
echo "    or whether it only reads the key from stdin. Paste this section back to me."

PROJECT="${1:-}"
if [ -z "$PROJECT" ]; then
  PROJECT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('config/pipeline.json','utf8')).stb?.projectId||'')}catch(e){}" 2>/dev/null)
fi

line "2. projects — capture your Terminus PROJECT_ID and confirm you are an active Submitter"
show stb projects list

if [ -z "$PROJECT" ]; then
  echo
  echo "⚠️  No PROJECT_ID given and none in config/pipeline.json (stb.projectId)."
  echo "    Re-run:  ./scripts/stb-probe.sh <PROJECT_ID>   (copy it from the list above)"
  echo "    Skipping the project-scoped probes below."
  exit 0
fi
echo "Using PROJECT_ID: $PROJECT"

line "3. CALIBRATION #1 — submissions list SHAPE (JSON? table? does --json exist?)"
show stb submissions list -p "$PROJECT"
echo "--- trying --json (may be unsupported; the error tells us either way) ---"
show stb submissions list -p "$PROJECT" --json

line "4. CALIBRATION — the revision queue count (how many NEEDS_REVISION → is the 10-cap per-project or account-wide?)"
echo "  Count NEEDS_REVISION in the list above. Then check EVERY other project from step 2 —"
echo "  if the platform's '10 in your revision queue' is account-wide, we must sum across projects."

line "5. help text for the commands we drive (flags, and whether create takes --no-send-to-reviewer)"
show stb submissions create --help
show stb submissions update --help
show stb submissions feedback --help
show stb submissions download --help
show stb harbor run --help

line "5b. THE DIFFICULTY ARTIFACT layout — what does `submissions download` actually produce?"
echo "  Pick any submission id from step 3 that has been through the difficulty check, then:"
echo "     mkdir -p /tmp/stb-dl && cd /tmp/stb-dl && stb submissions download <SUBMISSION_ID>"
echo "     find /tmp/stb-dl -maxdepth 4 -type f | sort"
echo "  I need the folder/file names (esp. anything like 'difficulty_check_artifact', transcripts,"
echo "  per-run scores) so locateArtifacts() targets the real layout instead of guessing by shape."

line "6. CALIBRATION #2 — harbor run -k output SHAPE (how are N runs reported?)"
echo "  NOT run automatically — a real agent run is slow and spends key budget."
echo "  When you have a built task folder, run ONE small probe and paste the tail:"
echo "     stb harbor run -m @openai/gpt-5.5 -p ./workspace/<a-task> -k 2"
echo "  I need to see how it reports the 2 runs (a summary line? a table? JSON?)."

line "DONE — paste the whole output back to me and I'll calibrate the parsers."
