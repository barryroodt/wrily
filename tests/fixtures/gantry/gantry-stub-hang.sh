#!/bin/sh
# Hanging test double: replays an optional NDJSON preamble, then sleeps so its
# stdout never closes. Exercises two GantryRunner safety paths:
#   * the watchdog (wrily-side wedge protection) — the parent force-kills a
#     child whose stream never closes and raises AgentTimeoutError;
#   * SIGTERM forwarding — the parent forwards a received SIGTERM to the child.
#
# On SIGTERM it writes a marker (when asked) and exits, proving the parent
# forwarded the signal. `sleep & wait` (not a bare `sleep`) is required so the
# TERM trap runs promptly instead of only after the full sleep elapses. The
# background sleep's stdio is detached (`</dev/null >/dev/null 2>&1`) so it can
# never inherit — and thus keep alive — the parent's stdout pipe: once this
# shell exits, the pipe EOFs and GantryRunner settles, even if the orphaned
# sleep outlives the TERM trap's best-effort kill.
#   GANTRY_STUB_FIXTURE          optional NDJSON preamble emitted before sleeping
#   GANTRY_STUB_SIGTERM_MARKER   optional file written when SIGTERM is received
#   GANTRY_STUB_SLEEP            sleep seconds (default 30)
term() {
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  if [ -n "$GANTRY_STUB_SIGTERM_MARKER" ]; then
    printf 'got-sigterm' > "$GANTRY_STUB_SIGTERM_MARKER"
  fi
  exit 143
}
trap term TERM
if [ -n "$GANTRY_STUB_FIXTURE" ]; then
  cat "$GANTRY_STUB_FIXTURE"
fi
sleep "${GANTRY_STUB_SLEEP:-30}" </dev/null >/dev/null 2>&1 &
SLEEP_PID=$!
wait "$SLEEP_PID"
