# ADR-0001: Cursor Composer 2.5 provider path

**Status:** Accepted  
**Date:** 2026-05-28  
**Deciders:** rig-harness phase-0 (task 0.1)

## Context

`wrily-rig` replaces the Claude Code CLI subprocess with a Rust sidecar that owns the agent tool loop, emits NDJSON on stdout, and routes model calls through a `ProviderAdapter` trait (Phase 1, todo #76–#80). Composer 2.5 is the default evaluation target and the model Wrily uses for `--provider cursor`.

The open design question is whether Composer 2.5 can ride the existing **OpenAI-compatible** provider adapter (`openai.rs` — same `POST /v1/chat/completions` shape, SSE deltas, tool-call JSON) or needs a **dedicated** `cursor.rs` adapter.

### Why this matters

| Constraint | Implication |
|------------|-------------|
| Invariant #5–#6 | `wrily-rig` executes tools (native + allowlisted shell). The provider must return **tool_use intents only**; it must not run Cursor's built-in agent harness. |
| Invariant #4, #7 | `TokenMeter` needs raw token counts after every provider response. Pricing stays in TS. |
| Invariant #8 | No MCP in v1. |
| Composer 2.5 is proprietary | Not served from `api.openai.com`; rejects BYOK OpenAI keys in the IDE ([Cursor forum #156190](https://forum.cursor.com/t/composer-2-broken-when-custom-openai-api-key-is-enabled/156190)). |
| Cursor SDK / Cloud Agents API | Programmatic access is **agent-scoped** (`Agent.create`, `POST /v1/agents`, run streams) — a full harness with Cursor-managed tools, not a drop-in chat-completions surface ([Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript), [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)). |
| Third-party OpenAI proxies | Community proxies (e.g. `cursor-api-proxy` on `localhost:8765/v1`) wrap the Cursor CLI agent loop; they are unofficial and unsuitable as Wrily's production transport. |

### Options considered

1. **Reuse `OpenAiProvider`** — point `OPENAI_BASE_URL` (or equivalent) at an OpenAI-shaped Cursor proxy and pass `composer-2.5` as the model string.
2. **Dedicated `CursorProvider`** — separate adapter with Cursor auth, endpoints, and stream normalization; may share generic HTTP/SSE helpers with `openai.rs` but does **not** inherit its request/response mapping.

## Decision

**Implement a dedicated `CursorProvider` in `rig-harness/src/provider/cursor.rs`. Do not reuse `OpenAiProvider` for Composer models.**

### 1. Provider registration and routing

- CLI flag: `--provider cursor`
- `ProviderRouter` maps these model strings **only** to `CursorProvider` (never to `openai`):

  | CLI / config model | Canonical Cursor model ID |
  |--------------------|---------------------------|
  | `composer-2.5` | `composer-2.5` |
  | `composer-2.5-fast` | `composer-2.5-fast` |
  | `cursor-composer-2.5` | `composer-2.5` (alias) |
  | `cursor-composer-2.5-fast` | `composer-2.5-fast` (alias) |

- Prefix inference (`composer-*`, `cursor-composer-*`) → `--provider cursor`. Ambiguous strings → exit **4** (config), same as other providers.
- Composer model IDs passed to `--provider openai` (or any non-`cursor` provider) → exit **4** with a message to use `--provider cursor`.

### 2. Authentication and configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CURSOR_API_KEY` | yes (when `--provider cursor`) | — | User or service-account API key (`crsr_…`). Basic auth: `-u "$CURSOR_API_KEY:"` per [Cursor API overview](https://cursor.com/docs/api). |
| `CURSOR_API_BASE` | no | `https://api.cursor.com` | Override for staging; production Wrily uses the hosted API. |
| `CURSOR_BRIDGE_URL` | no | `http://127.0.0.1:8765` | Local SDK bridge base URL when running the **bridge-backed** transport (see §3). |

Missing `CURSOR_API_KEY` → exit **4** before any NDJSON is written.

Model parameter validation (e.g. `thinking` effort) uses `GET /v1/models` at startup; unknown `model.params` for the selected ID → exit **4**.

### 3. Transport: bridge-backed model turns (not OpenAI-compat)

`CursorProvider` calls Cursor through the **local SDK bridge** that embeds `@cursor/sdk` (same stack as the official Python `cursor-sdk` package: bridge process + `sdk.v1` Connect protocol). Rationale:

- Composer inference is **hosted by Cursor** even in “local” SDK mode ([SDK docs: “Local means local agent loop, not local model”](https://cursor.com/docs/sdk/typescript)).
- There is **no supported public** `POST /v1/chat/completions` on `api.cursor.com` for Wrily-owned tool schemas.
- Cloud Agents `POST /v1/agents` runs Cursor's tool surface and repo/git lifecycle — incompatible with invariants #5–#6 and workdir-local native tools.

**Wrily-rig does not embed Node or `@cursor/sdk`.** The TS workflow (or Docker entrypoint) starts `cursor-agent-bridge` before spawning `wrily-rig`; the Rust adapter talks HTTP+Connect to `CURSOR_BRIDGE_URL`.

`CursorProvider::complete_turn` (name TBD in trait #76) sends:

- conversation history (system + user + assistant + tool_result messages) in the bridge's **turn request** shape;
- **Wrily `ToolRegistry` JSON schemas** (not Cursor built-in tools);
- `model: { id, params? }` for the canonical Composer ID;
- `cwd: --workdir` (filesystem context for the bridge only; **tool execution stays in Rust**).

The bridge is configured for **model-turn mode**: return assistant text + `tool_use` blocks; **do not** execute tools inside the bridge. (Phase 1 todo #80 pins the exact Connect method after spiking `@cursor/sdk` ≥ 1.0.10; this ADR locks the contract below.)

**Rejected:** wiring `OpenAiProvider` to `CURSOR_BRIDGE_URL/v1/chat/completions` — unofficial proxy surface, agent-mode semantics, and non-deterministic tool ownership.

### Trust boundary

The Cursor bridge is considered an untrusted external process from Wrily's perspective; it receives `cwd` for context but Wrily makes no assumption that the bridge respects workdir isolation. All tool execution and tool output validation remain in `wrily-rig`.

### 4. Streaming normalization (`ProviderResponse`)

Consume bridge/SSE events aligned with the [Cloud Agents run stream](https://cursor.com/docs/cloud-agent/api/endpoints#stream-a-run) and [SDK `SDKMessage`](https://cursor.com/docs/sdk/typescript#stream-events) shapes. Map into the internal `ProviderResponse` used by `AgentCore`:

| Source event | Normalized output |
|--------------|-------------------|
| `assistant` text deltas | Accumulate into assistant content blocks until turn completes. |
| `thinking` / `thinking-delta` | Optional `thinking` field on internal turn; emit `assistant_text` NDJSON only when surfaced to the workflow (default: stderr trace via `tracing`, not stdout). |
| `tool_call` with `status: "running"` and complete `args` | Single `tool_use { id: callId, name, input: args }`. |
| `tool_call` with `status: "completed"` | Ignored for tool dispatch (Wrily already executed via native registry); used only for reconciliation/logging. |
| `interaction_update` / `turn-ended` | **TokenMeter input:** `{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }` from `usage` (field names normalized to snake_case; missing fields = 0). |
| `error` / terminal `result` with `status: "error"` | Provider error → `error` NDJSON on stdout + retry policy in `AgentCore`; does not abort the run unless unrecoverable. |
| Stream disconnect | Retry once with `Last-Event-ID` when event IDs present; otherwise fail the turn and let the model continue after `error` propagation. |

**Parallel tool calls:** Composer may emit multiple `tool_call` events in one turn. `CursorProvider` returns them as an ordered list; `AgentCore` dispatches each and pairs `(role, turn, tool)` per invariant #3.

**Tool payload stability:** Treat `args` / `result` as `unknown` JSON (Cursor documents tool schemas as unstable). Wrily validates against its own `ToolRegistry` after normalization.

### 5. Shared code with `openai.rs`

Allowed shared utilities (new `provider/http.rs` or similar):

- SSE line parsing, reconnect headers, reqwest client timeouts tied to `--timeout-ms`
- Generic JSON buffer helpers

**Not shared:** request body construction, auth headers, stream event discrimination, token field extraction, or model ID tables.

### 6. Phase 1 deliverables (todo #80)

Implement `CursorProvider` with:

- wiremock/fixture tests using captured bridge SSE fixtures (`tests/fixtures/cursor/composer-2.5-turn.jsonl`);
- default eval model `composer-2.5`;
- integration test gated `--ignored` requiring live `CURSOR_API_KEY` + running bridge.

## Consequences

### Positive

- **Correct ownership:** Wrily's native tool registry and allowlisted shell remain authoritative; Composer is a model backend only.
- **Stable routing:** Composer IDs cannot accidentally hit OpenAI/Gemini adapters.
- **Token accounting:** `turn-ended` usage maps cleanly to `TokenMeter` without OpenAI-specific `usage.prompt_tokens` assumptions.
- **Eval target:** Default `--provider cursor --model composer-2.5` matches the product goal without unsupported OpenAI shims.

### Negative

- **Operational dependency:** CI/production must run the Cursor SDK bridge alongside `wrily-rig` (Node sidecar or pre-started service). Document in Phase 8 packaging.
- **Beta surface:** Cursor SDK and stream schemas are public beta; `#80` must pin a minimum `@cursor/sdk` version and re-record fixtures on upgrades.
- **No cloud-agent shortcut:** We cannot use `POST /v1/agents` for Wrily review runs without rewriting the tool loop and violating invariant #6.

### Out of scope (v1)

- MCP servers on Cursor agents (invariant #8).
- Team Admin API keys for SDK auth (unsupported per Cursor docs — use user/service-account keys).
- Calling Composer via OpenAI-compatible third-party proxies.

## References

- Spec: `solo://proj/11/scratchpad/rig-harness-replace--1` — open item #1 (Cursor provider path)
- Plan: `solo://proj/11/scratchpad/rig-harness-implemen--2` — Phase 1 todo #76 (trait), #80 (`cursor.rs`)
- [Cursor Composer 2.5 model docs](https://cursor.com/docs/models/cursor-composer-2-5)
- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor Cloud Agents API — stream a run](https://cursor.com/docs/cloud-agent/api/endpoints#stream-a-run)
- [Cursor API overview — authentication](https://cursor.com/docs/api)
- Shared architectural invariants #3 (tool pairing), #4 (TokenMeter), #5 (soft tool errors), #6 (native tools), #7 (raw tokens in Rust)
