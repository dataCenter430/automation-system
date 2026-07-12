#!/usr/bin/env bash
#
# Start the automation Chrome with CDP on 9222. The ONLY supported way.
#
# You cannot attach Playwright to a Chrome that is already running normally. The debug port
# only exists if Chrome was STARTED with --remote-debugging-port, and since Chrome 136 the
# browser REFUSES that flag when it points at the default user-data-dir. That is a security
# fix, not a Windows quirk — it applies identically on Linux, and we would not want it back:
# otherwise any local process could read the cookies of your everyday browsing profile.
#
# So a dedicated profile directory is unavoidable. Run clone-chrome-profile.sh once first to
# copy your signed-in profile into it, so this browser opens already logged in to Snorkel.
#
# Leave the window open while the worker runs. The worker attaches and detaches around each
# browser stage and never closes your browser.
set -euo pipefail

PORT="${CDP_PORT:-9222}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNORKEL_ROOT="${SNORKEL_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}"
PROFILE="${CHROME_AUTOMATION_PROFILE:-$SNORKEL_ROOT/.chrome-automation-profile}"
START_URL="${START_URL:-https://experts.snorkel-ai.com/}"

BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
if [ -z "$BIN" ]; then
  echo "ERROR: Chrome is not installed (looked for google-chrome / chromium)." >&2
  exit 1
fi

# Refuse to start a second instance. If CDP is already up and we launched another Chrome,
# Playwright would happily attach to the WRONG browser and you would spend an hour wondering
# why your clicks land nowhere.
if curl -sf --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP is already listening on $PORT — leaving the existing browser alone."
  curl -s "http://127.0.0.1:$PORT/json/version" | head -c 200; echo
  exit 0
fi

# Guard against ever pointing this at the real profile: Chrome would refuse the flag anyway,
# but failing here with a clear message beats a silent no-CDP browser.
DEFAULT_DIR="$HOME/.config/google-chrome"
if [ "$(readlink -f "$PROFILE" 2>/dev/null || echo "$PROFILE")" = "$(readlink -f "$DEFAULT_DIR" 2>/dev/null || echo "$DEFAULT_DIR")" ]; then
  echo "ERROR: CHROME_AUTOMATION_PROFILE points at your DEFAULT Chrome profile ($DEFAULT_DIR)." >&2
  echo "       Chrome 136+ refuses --remote-debugging-port there. Use a dedicated directory." >&2
  exit 1
fi

mkdir -p "$PROFILE"
if [ ! -e "$PROFILE/Default/Cookies" ] && [ ! -e "$PROFILE/Default/Preferences" ]; then
  echo "NOTE: $PROFILE looks empty — this Chrome will not be signed in to Snorkel."
  echo "      Run: bash scripts/clone-chrome-profile.sh"
fi

echo "Launching $BIN"
echo "  profile : $PROFILE"
echo "  cdp     : http://127.0.0.1:$PORT"

"$BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --profile-directory=Default \
  --no-first-run \
  --no-default-browser-check \
  "$START_URL" >/dev/null 2>&1 &

for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "CDP is up. Leave this window open while the worker runs."
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: Chrome started but CDP never came up on $PORT." >&2
exit 1
