# gantry NDJSON test fixtures

NDJSON event streams + shell stubs backing `tests/agent/gantry.test.ts`.
The tests never invoke the real gantry binary: they replay these committed
streams through `gantry-stub.sh` (set as `GantryRunner`'s `binary`) and through
`GantryRunner`'s parser. The real binary was used **once, to generate the
fixtures**, then they were committed verbatim.

Generated against **gantry `v0.1.0` (`be35ac5`, schema_version `1.1`)** — the
locally-built `target/release/gantry`. Exit-code/event contract: see Solo
scratchpad #49 and `docs/superpowers/specs/2026-06-05-gantry-cutover-design.md`
("Failure mode mapping").

## Exit code ⇄ `result.exit` contract (as shipped)

| `result.exit` | exit code | recoverable |
|---|---|---|
| `ok` | 0 | — |
| `error` | 1 | per `error.recoverable` |
| `budget` | 2 | no |
| `timeout` | 3 | no |
| `config` | 4 | no |
| `rate_limited` | 5 | yes |

## Captured — emitted verbatim by the real `v0.1.0` binary

| File | How captured | Salient shape |
|---|---|---|
| `happy-single.ndjson` | `--mode single` against a mock OpenAI server returning one chat completion | `start` → `agent_turn(role=single)` → `assistant_text` → `result(exit=ok)` |
| `happy-team.ndjson` | `--mode team --profile profiles/review` against a content-routed mock (roster → 2 lane reports → unified findings) | full team vocabulary: coordinator `agent_turn`s, `subagent_spawn`×2, lane `assistant_text`, `subagent_done`×2 (G5 cache/duration), coordinator `assistant_text` (unify), `changes`, `result(exit=ok)` |
| `team-collapse.ndjson` | team run where every subagent busts its budget slice (mock returns oversized usage) | `subagent_failed(reason=budget)`×3 + `subagent_done`×3, `error(kind=team_collapse)`, `result(exit=error)` |
| `error-provider.ndjson` | unreachable base URL (`http://127.0.0.1:9/v1`) | `start` → `error(kind=provider, recoverable=false)` → `result(exit=error)` |
| `budget.ndjson` | `--max-tokens 16` with a mock returning huge usage | `start` → `budget_exceeded{limit,total}` → `result(exit=budget)` |
| `timeout.ndjson` | tiny `--timeout-ms 300` against a hung TCP endpoint | `start` → `result(exit=timeout)` (no `error` event) |
| `config.ndjson` | required `--model` omitted | `error(kind=config)` → `result(exit=config)` — **no `start`** (hence no `schema_version`), per the contract-versioning note |
| `rate-limited.ndjson` | mock returning HTTP 429 | `start` → `error(kind=provider, recoverable=true)` → `result(exit=rate_limited)`. The local provider does **not** surface `retry_after_ms`, so this stream omits the hint — it exercises the `retry_after_ms ?? 0` fallback. |

## Assembled / derived — built from a captured stream, noted here

These are not raw binary output. Each is a minimal edit of a captured stream to
reach a state the local `dummy` provider could not produce on demand. Event
shapes still match the documented schema 1.1 (scratchpad #49).

| File | Derived from | Edit |
|---|---|---|
| `rate-limited-retry-hint.ndjson` | `rate-limited.ndjson` | added `"retry_after_ms": 5` to the `error` event (the provider back-off hint the local provider never emits), so the retry loop can honor a hint with a test-fast delay |
| `malformed-line.ndjson` | `happy-single.ndjson` | injected two unparseable lines mid-stream — a non-JSON garbage line and a JSON object missing the `event` discriminant — before the `result`; both must be skipped (warn) and the run still resolve `ok` |
| `eof-no-result.ndjson` | `happy-single.ndjson` | truncated before the `result` line, so the stream reaches EOF with no terminal event — drives the exit-code synthesis path |

## Stubs

| File | Purpose |
|---|---|
| `gantry-stub.sh` | records argv → `GANTRY_STUB_ARGV_OUT`, replays `GANTRY_STUB_FIXTURE`, exits `GANTRY_STUB_EXIT`. Inputs ride the env because `GantryRunner` spawns with `{ env: req.env }` (which replaces the environment). |
| `gantry-stub-hang.sh` | replays an optional preamble then `sleep & wait` so stdout never closes — drives the watchdog and SIGTERM-forwarding tests; writes `GANTRY_STUB_SIGTERM_MARKER` on SIGTERM. |
