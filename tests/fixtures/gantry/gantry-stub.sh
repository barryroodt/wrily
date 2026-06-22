#!/bin/sh
# Test double for the gantry binary used by GantryRunner spawn-path tests.
#
# It records its argv, replays a committed NDJSON fixture on stdout, then exits
# with a controlled code — letting the test drive both the result-event-mapping
# path (exit 0; the fixture's `result` event is authoritative) and the
# exit-code-synthesis path (real exit code; fixture has no `result` event).
#
# All inputs arrive via the ENVIRONMENT, never argv: GantryRunner spawns the
# child with `{ env: req.env }`, which REPLACES the environment, so the test
# seeds these vars onto req.env:
#   GANTRY_STUB_FIXTURE   path to the NDJSON fixture to replay (optional)
#   GANTRY_STUB_EXIT      process exit code (default 0)
#   GANTRY_STUB_ARGV_OUT  optional file; receives one argv token per line
#   GANTRY_STUB_RUN_LOG   optional file; one 'x' appended per invocation (spawn counter)
if [ -n "$GANTRY_STUB_ARGV_OUT" ]; then
  : > "$GANTRY_STUB_ARGV_OUT"
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$GANTRY_STUB_ARGV_OUT"
  done
fi
if [ -n "$GANTRY_STUB_RUN_LOG" ]; then
  printf 'x' >> "$GANTRY_STUB_RUN_LOG"
fi
if [ -n "$GANTRY_STUB_FIXTURE" ]; then
  cat "$GANTRY_STUB_FIXTURE"
fi
exit "${GANTRY_STUB_EXIT:-0}"
