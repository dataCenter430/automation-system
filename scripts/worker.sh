#!/usr/bin/env bash
#
# The worker supervisor.
#
# WHY THIS EXISTS. On 2026-07-13 the VM's NIC dropped and re-leased. The worker's poll loop
# was sitting on an un-timed Supabase fetch whose promise never settled; once the last live
# Claude session finished, node's event loop drained and the process exited with code 0 and
# no output whatsoever. Nothing was watching it. It stayed dead for an hour and forty
# minutes while the dashboard went on pulsing VERIFYING at a task nobody was driving.
#
# The worker itself has been hardened (deadlines on every DB call, a watchdog, and a message
# on every exit path) — but "the worker is now correct" is not a restart policy. This is.
#
# The loop below is the whole point: whatever happens to the worker, another one comes up.
# Everything the worker does is crash-safe by construction — state.json lives next to the
# artifacts it describes, and the boot sweep re-enters anything that was mid-flight — so a
# restart costs a few seconds, never a task.
#
#   ./scripts/worker.sh          run in the foreground, restarting on death
#
# DOCKER GROUP: the worker shells out to docker for the gate. If your login session predates
# your docker group membership, `docker` will be denied here even though it works in a fresh
# terminal. Run this under `sg docker -c ./scripts/worker.sh` and the whole supervised tree
# inherits the group. This script does NOT re-exec into sg itself: doing that silently would
# hide a real permissions problem, and getting it wrong would fork-bomb.
set -uo pipefail
cd "$(dirname "$0")/.."

# A worker that dies instantly and forever would spin here, hammering Supabase and filling
# the log. Back off when deaths come fast, and reset the moment one run lasts a real while.
MIN_HEALTHY_SEC=60
backoff=5
MAX_BACKOFF=120

trap 'echo "[supervisor] stopping"; exit 0' INT TERM

echo "[supervisor] starting worker · restarts on exit · Ctrl-C to stop"

while true; do
  started=$(date +%s)
  npm run worker
  code=$?
  ran=$(( $(date +%s) - started ))

  # Exit 0 with `stopping` set is the only intentional way out, and the worker prints its own
  # goodbye in that case. Anything else is a death, and we say so — the failure that started
  # all this was invisible precisely because nobody announced it.
  if [ "$code" -eq 0 ] && [ "$ran" -ge "$MIN_HEALTHY_SEC" ]; then
    echo "[supervisor] worker exited cleanly after ${ran}s — not restarting"
    exit 0
  fi

  if [ "$ran" -ge "$MIN_HEALTHY_SEC" ]; then
    backoff=5   # it ran for a while, so this is a fresh failure, not a crash loop
  fi

  echo "[supervisor] worker exited (code ${code}) after ${ran}s — restarting in ${backoff}s"
  sleep "$backoff"

  if [ "$ran" -lt "$MIN_HEALTHY_SEC" ]; then
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
  fi
done
