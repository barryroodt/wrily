# Gantry cutover — replacing pi-coding-agent with a gantry subprocess

| | |
|---|---|
| Status | Draft (awaiting review) |
| Date | 2026-06-05 |
| Plan | Created post-approval via `superpowers:write-plan` |
| Author | Barry Roodt (with the brainstorming agent) |
| Supersedes | nothing — extends the PR #32 pi-cutover work |

## Summary

Replace wrily's in-process `@earendil-works/pi-coding-agent` runtime
with the [gantry](https://github.com/barryroodt/gantry) standalone agent
harness, consumed as a subprocess and parsed from its NDJSON event
stream. Wrily owns its own copy of the gantry review profile from day
one. Path A: single-PR full cutover, validated by wrily reviewing its
own cutover PR. The provider matrix narrows to gantry's three
(`anthropic` / `openai` / `google`); the six others wrily currently
declares (`google-vertex`, `mistral`, `azure-openai-responses`,
`cloudflare-workers-ai`, `cloudflare-ai-gateway`, Amazon Bedrock) are
dropped, with the intent to add adapters upstream in gantry later.

## Why

Four motivations, all weighted equally:

1. **Shed wrily complexity.** Gantry's `team` mode + `profiles/review`
   subsume `src/workflow/teamReview.ts`, `src/workflow/teamRoles.ts`,
   `src/workflow/reviewContext.ts`, and most of `src/agent/pi.ts` —
   ~15-18 KB of TS deletable.
2. **Adopt the in-house runtime.** Gantry is a sibling project; wrily
   consuming it removes a third-party dep (`@earendil-works/*`) and
   dogfoods the harness.
3. **Capability gains.** Copy-on-write workspace isolation
   (`--isolate`), output compression at the tool boundary, the `loop`
   mode, an NDJSON event stream that's a clean source for live
   observability and persistence.
4. **Long-term portability.** Gantry's subprocess + NDJSON contract is
   language-agnostic — wrily could move off Node entirely in the future
   if it ever made sense to.

## Locked decisions

1. **Full parity in one PR.** Path A — single-shot cutover. Wrily renders
   the prompt, spawns `gantry --profile profiles/review --mode team`,
   parses the NDJSON stream, and the existing post/persistence flow
   takes over. Validated by wrily reviewing its own cutover PR.

2. **Provider matrix narrows to gantry's three.** `anthropic`,
   `openai`, `google` (Gemini) stay. `google-vertex`, `mistral`,
   `azure-openai-responses`, `cloudflare-workers-ai`,
   `cloudflare-ai-gateway`, Amazon Bedrock are removed from
   `src/config/providers.ts`. Upstream gantry contributions will
   re-add them on the gantry side later (not part of this PR).

3. **Gantry binary distribution: prebuilt release artifact.** Wrily
   pulls a tagged release tarball from gantry's GitHub Releases
   (containing `gantry`), SHA256-verifies it, and copies the binary
   into the wrily Docker image. No Rust toolchain in wrily's build.
   Prerequisite: gantry ships a release pipeline (in progress).

4. **Wrily owns its review profile.** `profiles/review/` lives in
   wrily's tree as a first-class copy, initially forked from gantry's
   `profiles/review/`. Decoupled from gantry's release cadence.
   Divergence allowed.

5. **NDJSON consumption is streaming, behind the existing
   `AgentRunner` interface.** A new `GantryRunner` parses events as
   they arrive, fires per-event hooks (persistence, logging,
   observability), and returns the same `AgentResult` shape the
   workflow consumes today. The fake-runner test seam stays intact.

6. **Model validation + cost rates live in one static manifest** at
   `src/agent/models.ts`. `modelResolver.ts` keeps its public API but
   swaps `ModelLookup` from pi's `ModelRegistry` to a tiny wrapper over
   the manifest. Unknown-model escape hatch: `WRILY_ALLOW_UNKNOWN_MODEL=1`.

7. **Persistence: full mapping, batched flush.** `subagent_done` events
   become `SubagentRecord` rows; an aggregated synthetic `coordinator`
   row captures compose + unify costs. Row count matches today's
   behaviour. Streaming flush (one Supabase write per event) is
   deferred to a follow-up PR alongside the tokens-only schema
   migration.

8. **Skills move into the workdir.** `bridgeSkillsStep` writes to
   `${state.repoPath}/.claude/skills/<name>/` instead of
   `~/.claude/skills/<name>/`. Wrily's profile.toml declares the
   invariant skill set; user-supplied skills from `.wrily.yml` become
   appended `--inject-skill <name>` flags. Eliminates a global-state
   foot-gun in CI.

9. **Failure mapping is direct.** Gantry's `result.exit` translates to:
   `ok` → success path; `budget` → `AgentBudgetExceededError`;
   `timeout` → `AgentTimeoutError`; `error` / `config` → generic
   `Error`. Both existing error classes already carry `stdout` +
   `stderr` — populated from buffered `assistant_text` events.

10. **Gantry version pinning lives in `.gantry-version`** at the repo
    root. Dockerfile reads it via `ARG GANTRY_VERSION`. A weekly cron
    workflow opens a PR when the pinned version drifts from gantry's
    latest GitHub release.

## Architecture

After the cutover the runtime topology is:

```
.wrily.yml + env → config/env.ts (RuntimeEnv)
                ↓
workflow/steps.ts (Mastra) ─→ render prompt
                          → spawn `gantry --profile profiles/review --mode team
                                          --model <slug> --workdir <repo>
                                          --prompt-file <tmp> --max-tokens <n>
                                          --timeout-ms <n>
                                          --inject-skill <user-skill-1> …`
                          → GantryRunner consumes NDJSON on stdout
                            • streams hooks (persistence rows, logs)
                            • buffers final unify JSON → AgentResult.stdout
                            • maps result.exit → AgentResult or thrown error
                          → existing extractFindings / route / post / persist
```

The `AgentRunner` interface (`run({prompt, model, ...}) → AgentResult`)
is the sole seam; the rest of wrily doesn't know whether the runner is
pi or gantry. The fake runners (`FakeAgentRunner`,
`SequenceFakeAgentRunner`) continue to satisfy the interface for
workflow tests.

## Component-level changes

### `src/agent/`

| File | Disposition |
|---|---|
| `runner.ts` | Unchanged — the `AgentRunner` interface is the seam. |
| `factory.ts` | Deleted. The factory returned `new PiRunner()` unconditionally; replace with a direct `new GantryRunner()` at the workflow construction site. |
| `pi.ts` | Deleted. |
| `gantry.ts` | **New.** Implements `AgentRunner`. Spawns gantry; consumes NDJSON streaming; returns `AgentResult`. See "GantryRunner" below. |
| `models.ts` | **New.** The static manifest (slug + aliases + rates) backing both `modelResolver.ts` and cost computation. |
| `modelResolver.ts` | Keep public API. `ModelLookup` impl swaps to wrap `models.ts`. `ALIASES` map moves into `models.ts` (one row per slug carries its aliases). |
| `fake.ts` | Unchanged. |
| `errors.ts` | Unchanged. |

### `src/workflow/`

| File | Disposition |
|---|---|
| `steps.ts` | The `agentCallStep` is rewritten to call a single `runner.run()` with the team prompt; the today-branching on `reviewMode` collapses (gantry's mode comes from the profile or `--mode`). The `persistUsageStep` is reshaped to construct `SubagentRecord` rows from streamed events (see "Persistence" below). All other steps unchanged. |
| `teamReview.ts` | Deleted. Gantry's team mode replaces it. |
| `teamRoles.ts` | Deleted. The reviewer security preamble and role briefs move into `profiles/review/subagent.md`. The deterministic role composition becomes the rule-based prompt in `profiles/review/compose.md`. |
| `reviewContext.ts` | Reshaped or deleted. The unify-prompt context that today fed into `renderUnifyPrompt` either folds into `profiles/review/unify.md` or becomes a small pre-render step that injects task context into the prompt file. Decided in implementation. |
| `index.ts`, `state.ts` | Minor updates: `state.repoPath` is now also the gantry `--workdir` and the skills bridging target. |

### `src/skills/`

`loader.ts` — change the bridge target from `join(homedir(), '.claude', 'skills')` to `join(state.repoPath, '.claude', 'skills')`. `names.ts` unchanged.

### `src/config/`

`providers.ts` — drop the 6 unsupported provider rows; keep `anthropic`, `openai`, `google`. Remove the Bedrock-ambient-AWS branch from `hasAnyProviderAuth`. Update the supporting doc comments.

### `src/persist/`

`types.ts` unchanged for this PR (the schema migration is the follow-up). `supabase.ts` unchanged. The shape of records being written is the same.

### `package.json`

Remove `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from dependencies. No new npm deps added — `GantryRunner` uses only node built-ins (`child_process`, `readline`).

### `Dockerfile`

Multi-stage stays, with a new "fetch gantry" stage:

```dockerfile
ARG GANTRY_VERSION
ARG TARGETARCH

FROM debian:bookworm-slim AS gantry-fetch
ARG GANTRY_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="gantry-${GANTRY_VERSION}-x86_64-unknown-linux-gnu.tar.gz" ;; \
      arm64) asset="gantry-${GANTRY_VERSION}-aarch64-unknown-linux-gnu.tar.gz" ;; \
      *)     echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/barryroodt/gantry/releases/download/${GANTRY_VERSION}"; \
    curl -fsSL "${base}/${asset}" -o /tmp/g.tgz; \
    curl -fsSL "${base}/SHA256SUMS" -o /tmp/SHA256SUMS; \
    (cd /tmp && grep " ${asset}$" SHA256SUMS | sha256sum -c -); \
    tar -xzf /tmp/g.tgz -C /usr/local/bin gantry

FROM node:22-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
COPY --from=gantry-fetch /usr/local/bin/gantry /usr/local/bin/gantry
# … existing wrily layers …
```

The `GANTRY_VERSION` arg is sourced from `.gantry-version` at build time
(CI passes `--build-arg GANTRY_VERSION=$(cat .gantry-version)`).

### `.gantry-version`

**New.** One line: the pinned gantry release tag (e.g. `v0.1.0`). A
weekly cron workflow at `.github/workflows/gantry-version-bump.yml`
calls `gh release view -R <gantry-repo> --json tagName`, compares to
`.gantry-version`, and opens a PR with the updated tag and a one-line
release-note summary when drift exists.

### `profiles/review/`

**New.** Wrily's owned copy. Initial files (with one-line origins):

| File | Origin | Notes |
|---|---|---|
| `profile.toml` | gantry `profiles/review/profile.toml` | Header comment: "Forked from gantry@\<SHA\>; owned by wrily; divergence allowed." |
| `system.md` | gantry equiv | Coordinator persona. |
| `subagent.md` | gantry equiv + `REVIEWER_SECURITY_PREAMBLE` from `teamRoles.ts` | Security guards live here now, not in TS. |
| `compose.md` | gantry equiv | Rule-based reviewer roster prompt. |
| `unify.md` | gantry equiv | Already emits the JSON contract `extractFindings` parses. |

`profile.toml` declares:

```toml
mode = "team"
system = "system.md"
subagent_system = "subagent.md"
compose = "compose.md"
unify = "unify.md"
tools = ["read_file", "list_files", "find_files", "git_diff", "ast_grep", "shell", "skill_load"]
inject_skills = ["agent-team-review", "code-review", "confidence-rating", "caveman-review"]
shell_allow = ["git", "cat", "ls", "find"]
```

`.wrily.yml`-supplied user skills are appended as `--inject-skill <name>` flags at spawn time, augmenting the profile's invariant set.

## GantryRunner

```ts
// src/agent/gantry.ts (signature sketch)
export class GantryRunner implements AgentRunner {
  constructor(private readonly opts: GantryRunnerDeps);
  async run(req: AgentRunOptions): Promise<AgentResult> {
    // 1. write req.prompt to a tmp file inside req.workingDir/.wrily/
    // 2. resolve --model from req.model (already canonical per modelResolver)
    // 3. spawn gantry with flags assembled from req + injected skill list
    // 4. parse stdout line-by-line as NDJSON
    //    - on `assistant_text`: append to per-role text buffer
    //    - on `subagent_spawn`: open in-memory SubagentRecord
    //    - on `subagent_done`: close it, fire onSubagentDone hook
    //    - on `subagent_failed`: close with status, fire hook
    //    - on `agent_turn` (role=coordinator): accumulate into synthetic coordinator record
    //    - on `result`: finalize AgentResult
    // 5. map result.exit → success | AgentBudgetExceededError | AgentTimeoutError | Error
    // 6. on SIGTERM to wrily: forward to gantry child
  }
}
```

The injected hooks are:

```ts
interface GantryHooks {
  onSubagentDone?(record: SubagentRecord): void; // future-extensible
  onEvent?(event: GantryEvent): void;            // for logs / observability
}
```

The hooks are fire-and-forget (sync) for v1. The streaming-flush
follow-up PR will make them async and wire Supabase writes through
them.

## Failure mode mapping

| `result.exit` | Code | Wrily outcome |
|---|---|---|
| `ok` | 0 | Return `AgentResult { stdout: <unify JSON>, tokenUsage, model, durationMs, exitCode: 0 }`. |
| `budget` | 2 | `throw new AgentBudgetExceededError(stdout, stderr)` where `stdout` = concatenated `assistant_text`, `stderr` = captured gantry stderr. |
| `timeout` | 3 | `throw new AgentTimeoutError(timeoutMs, stdout, stderr)`. Wrily's existing failure-comment path posts the timeout-specific message. |
| `error` | 1 | `throw new Error("gantry: <message>")` — generic. Carries gantry's terminal `error` event message if one was emitted. |
| `config` | 4 | `throw new Error("gantry config: <message>")` — should never happen at runtime if wrily's argv assembly is correct; treat as a wrily bug. |

A malformed NDJSON line (rare but possible — e.g. gantry crashes
mid-write) is treated as `error`: log the broken line at warn, throw a
generic `Error` after the subprocess exits. `dependabot-review`'s
"detect early, fail loudly" posture.

## Persistence mapping

For one team review run, the events arrive in this order (per gantry's documented vocabulary):

```
start
  agent_turn (role=coordinator, turn=0)          ← compose pass
  subagent_spawn  (name=correctness, scope=full)
  subagent_spawn  (name=spec-compliance, scope=full)
  subagent_spawn  (name=<dir>-conventions, scope=<dir>)
  …
  agent_turn (role=correctness, turn=…)
  tool_call / tool_result …
  agent_turn (role=spec-compliance, turn=…)
  …
  subagent_done   (name=correctness, totals…)
  subagent_done   (name=spec-compliance, totals…)
  …
  agent_turn (role=coordinator, turn=…)          ← unify pass
result (exit, totals…)
```

Wrily's in-memory model during the run:

```ts
interface RunState {
  start: { model, workdir, ts };
  subagents: Map<string /* name */, SubagentDraft>;
  coordinator: { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens };
  finalText: string;            // last assistant_text from role=coordinator
  finalResult?: ResultEvent;
}
```

At workflow `persistUsageStep` time (existing batched-flush model):

- One `ReviewRunRecord` written from `result` totals.
- N `SubagentRecord` rows, one per `subagent_done` event, with
  `role = subagent_spawn.name` (e.g. `correctness`, `<dir>-conventions`).
- One synthetic `SubagentRecord` with `role = 'coordinator'`,
  duration_ms = sum of coordinator-role `agent_turn` durations, tokens
  from the accumulated `coordinator` block.

Cost per row computed from `models.ts` rates × token counts.

## Runtime control flow inside the agent step

```ts
// inside steps.ts agentCallStep (sketch)
const runner: AgentRunner = new GantryRunner({
  binary: process.env.WRILY_GANTRY_BIN ?? 'gantry',
  profileDir: resolveProfileDir(),         // wrily-owned profiles/review/
  injectExtraSkills: state.loadedSkills,   // appended as --inject-skill flags
});

const result = await runner.run({
  prompt: state.renderedPrompt!,
  model: state.cfg.model,                  // already canonical via modelResolver
  workingDir: state.repoPath!,
  maxBudgetUsd: state.cfg.max_budget_usd,
  env: process.env,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

state.agentResults = [result];             // singleton; the team is inside gantry
state.eventLog = runner.events;            // captured for persist + debug
return state;
```

The `agentResults` array stays for backward compat with downstream
steps that iterate it; in the gantry world it's always length 1 (the
team's unify output). The per-subagent telemetry lives on
`state.eventLog`, which `persistUsageStep` consumes.

## Build & distribution

| Concern | Approach |
|---|---|
| Binary architecture | x86_64-unknown-linux-gnu + aarch64-unknown-linux-gnu, glibc. Selected via Docker `TARGETARCH`. |
| Checksum verification | `SHA256SUMS` file pulled alongside the tarball; verified in the Docker build before extraction. |
| Provenance | If gantry releases include sigstore signatures / SLSA provenance, wrily's `dependabot-review` invariants prefer them but don't require them for v1. |
| Image bloat | The fetch stage is discarded; final image gains only the gantry binary (~15-30 MB). |
| Local dev | A `WRILY_GANTRY_BIN` env var lets developers point at a locally-built `gantry` (e.g. `target/release/gantry` from a sibling checkout). |
| Self-hosting | `docs/self-hosting.md` updated: no longer requires Node-side `@earendil-works/*` install — the gantry binary ships in the image. |

## Test strategy

The `AgentRunner` interface + `FakeAgentRunner` + `SequenceFakeAgentRunner`
seam stays. All existing workflow tests that inject a fake continue to
work as-is.

New tests for the runner itself:

- `tests/fixtures/gantry/success.ndjson` — full happy-path team run, ends with `result.exit = ok`.
- `tests/fixtures/gantry/budget-exceeded.ndjson` — terminates with `budget_exceeded` followed by `result.exit = budget`.
- `tests/fixtures/gantry/timeout.ndjson` — terminates with `result.exit = timeout`.
- `tests/fixtures/gantry/subagent-failed.ndjson` — at least one `subagent_failed` event, run still completes.
- `tests/fixtures/gantry/malformed.ndjson` — truncated/garbage NDJSON line mid-stream.
- `tests/fixtures/gantry/gantry-stub.sh` — tiny shell script: `cat $1; exit $2`. Used by spawn tests.
- `tests/agent/gantry.test.ts` — feeds each fixture through the runner's NDJSON parser directly (no subprocess) AND through the stub-binary spawn path; asserts:
  - Final `AgentResult` shape (stdout, tokenUsage, model, exitCode)
  - Correct error type thrown for each non-ok exit
  - Per-event hooks fire in expected order
  - `SubagentRecord` rows reconstruct correctly, including the synthetic coordinator row
  - SIGTERM forwarding works (skipped on Windows runners)

`tests/agent/pi.test.ts` is deleted alongside `pi.ts`.

## Migration plan

**Single PR**: this entire spec lands in one commit-graph. Validated by
wrily reviewing its own gantry-cutover PR (the bot will spawn gantry
against itself).

**Pre-flight (gantry side, not part of this PR)**:

1. Gantry ships a release workflow producing `x86_64-` and
   `aarch64-unknown-linux-gnu.tar.gz` artifacts + `SHA256SUMS`.
2. Gantry cuts the first tagged release (e.g. `v0.1.0`).

**The PR itself**:

1. Add `profiles/review/` (initial fork from gantry's profile).
2. Add `src/agent/gantry.ts`, `src/agent/models.ts`.
3. Rewrite `modelResolver.ts`'s `ModelLookup` impl over `models.ts`.
4. Rewrite `src/workflow/steps.ts`'s `agentCallStep` + `persistUsageStep`.
5. Update `src/skills/loader.ts` target path.
6. Delete `src/agent/pi.ts`, `src/agent/factory.ts`,
   `src/workflow/teamReview.ts`, `src/workflow/teamRoles.ts`,
   `src/workflow/reviewContext.ts`, `tests/agent/pi.test.ts`.
7. Drop the 6 providers from `src/config/providers.ts` + comment updates.
8. Drop `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` from `package.json`; regenerate lockfile.
9. Add `.gantry-version` + `.github/workflows/gantry-version-bump.yml`.
10. Update `Dockerfile` for the multi-stage gantry fetch.
11. Update `docs/adoption.md`, `docs/self-hosting.md`, `README.md`, `.wrily.yml.example` to drop removed-provider references.
12. Add `tests/fixtures/gantry/` + `tests/agent/gantry.test.ts`.
13. Self-review: open the PR; wrily-bot reviews itself; iterate.

**Rollback**: revert the merge commit. The pre-cutover state still
works (PR #32's pi integration is the baseline being replaced).

## Non-goals

- Re-adding the 6 dropped providers as gantry adapters. Tracked
  separately as gantry contributions.
- Tokens-only persistence schema migration. Follow-up wrily PR
  (paired with the streaming-flush rework).
- Streaming per-event Supabase flush. Follow-up wrily PR.
- Supporting gantry deployed separately from wrily's image (no
  out-of-image gantry binary as a first-class deployment mode).
- Backward-compat shim for `@earendil-works/*` consumers — wrily was
  the only consumer; full removal is clean.
- Changing wrily's `.wrily.yml` schema. The `model` and `skills` fields
  keep their current semantics; the model alias set narrows naturally
  because the provider matrix did.

## Operational follow-ups

These land after PR1 merges, in order:

1. Self-hosting docs revision: update `docs/self-hosting.md` to reflect
   the new image content (no Node-side agent deps) and the
   `WRILY_GANTRY_BIN` override for local development.
2. Tokens-only persistence migration (Section 7 option C from the
   brainstorm): drop `cost_usd` from the write path; teach `wrily costs`
   to compute USD at query time from `src/agent/models.ts` rates.
3. Streaming-flush persistence (Section 8 option C from the
   brainstorm): make `GantryHooks` async and route `subagent_done`
   writes through them.
4. Upstream gantry adapter contributions for Bedrock, Vertex, Mistral,
   Azure, Cloudflare-WAI, Cloudflare-AIG. Once each lands in a gantry
   release, wrily re-enables the provider in `providers.ts` and adds
   it to `models.ts`.
