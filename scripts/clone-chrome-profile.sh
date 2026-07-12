#!/usr/bin/env bash
#
# One-time: clone your signed-in Chrome profile into the automation profile directory, so
# the automation browser opens already logged in to Snorkel and nobody has to keep a second
# set of credentials around.
#
# A NOTE ON COOKIE ENCRYPTION, because the Windows version of this script is misleading here:
# on Windows, cookies are encrypted with a DPAPI key stored in the profile's `Local State`,
# so that file must be copied. On Linux there is no DPAPI — Chrome encrypts cookies with a
# key held in gnome-keyring/kwallet (or the fixed "peanuts" fallback), which lives OUTSIDE
# the profile. Copying `Local State` here is harmless but does nothing. The clone decrypts
# because it runs as the same Linux user against the same keyring. Which also means: this
# only works for YOUR user, on THIS machine. It is not a portable credential.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNORKEL_ROOT="${SNORKEL_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}"
SRC="${SOURCE_PROFILE:-$HOME/.config/google-chrome}"
DEST="${CHROME_AUTOMATION_PROFILE:-$SNORKEL_ROOT/.chrome-automation-profile}"

if [ ! -d "$SRC" ]; then
  echo "ERROR: no Chrome profile at $SRC" >&2
  exit 1
fi

# Chrome must be CLOSED. Copying a live profile gives you a locked, half-written cookie
# database, and the clone silently comes up signed out.
if pgrep -x chrome >/dev/null 2>&1 || pgrep -f "google-chrome" >/dev/null 2>&1; then
  echo "ERROR: Chrome is running. Close every Chrome window first — copying a live profile" >&2
  echo "       yields a half-written cookie database and the clone comes up signed out." >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required (sudo apt install rsync)." >&2
  exit 1
fi

echo "Cloning $SRC"
echo "     -> $DEST"
mkdir -p "$DEST"

# Skip the caches: they are large, worthless to us, and regenerate on first run.
rsync -a --delete \
  --exclude 'Cache/' \
  --exclude 'Code Cache/' \
  --exclude 'GPUCache/' \
  --exclude 'DawnCache/' \
  --exclude 'DawnGraphiteCache/' \
  --exclude 'DawnWebGPUCache/' \
  --exclude 'GrShaderCache/' \
  --exclude 'ShaderCache/' \
  --exclude 'Service Worker/CacheStorage/' \
  --exclude 'Crashpad/' \
  "$SRC/" "$DEST/"

echo "Done. Now run: bash scripts/launch-chrome.sh"
echo "If the browser opens signed OUT of Snorkel, sign in once in that window — the profile"
echo "persists, so you only ever do it once."
