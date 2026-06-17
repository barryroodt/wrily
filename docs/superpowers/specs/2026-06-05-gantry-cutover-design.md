# Gantry cutover — replacing pi-coding-agent with a gantry subprocess

| | |
|---|---|
| Status | Draft v3 — reconciled to gantry v0.1.0 as-shipped contract (awaiting review) |
| Date | 2026-06-17 (v2: 2026-06-11; v1: 2026-06-05) |
| Plan | Created post-approval via `superpowers:write-plan` |
| Author | Barry Roodt (with the brainstorming agent) |
| Supersedes | v2 — folds in gantry v0.1.0 as-shipped deltas (exit codes, schema_version, budget formula) |
| Leverage | Gantry is owned by the same author; its CLI/contract may change where general-purpose (see "Gantry pre-flight contract changes"). Neither project is in active use — no backward compatibility constraints. |
| As-shipped | Gantry **v0.1.0** (`d9e885d`) ships G1–G8; this revision reconciles the spec to the shipped contract. Handoff: `solo://proj/11/scratchpad/gantry-v0-1-0-cutove--49`. |

## Summary

Replace wrily's in-process `@earendil-works/pi-coding-agent` runtime
with the [gantry](https://github.com/barryroodt/gantry) standalone agent
harness, consumed as a subprocess and parsed from its NDJSON event
stream. Wrily owns its own copy of the gantry review profile from day
one. Path A: single-PR full cutover, validated by running the branch's
wrily via `local_cli` against the cutover PR itself. The provider
matrix narrows to gantry's three (`anthropic` / `openai` / `google`);
the six others wrily currently declares (`google-vertex`, `mistral`,
`azure-openai-responses`, `cloudflare-workers-ai`,
`cloudflare-ai-gateway`, Amazon Bedrock) are dropped, with the intent
to add adapters upstream in gantry later.

Budgets are re-keyed in **tokens** end-to-end (`.wrily.yml max_tokens`),
matching gantry's native budget unit and the planned tokens-only
persistence direction. USD never appears between config and the
subprocess; it is computed only at persistence/reporting time from the
`src/agent/models.ts` rate manifest.

## Why

Four motivations, all weighted equally:

1. **Shed wrily complexity.** Gantry's `team` mode + `profiles/review`
   subsume `src/workflow/teamReview.ts`, `src/workflow/teamRoles.ts`,
   the unify half of `src/workflow/reviewContext.ts`, and most of
   `src/agent/pi.ts` — ~15-18 KB of TS deletable.
2. **Adopt the in-house runtime.** Gantry is a sibling project; wrily
   consuming it removes a third-party dep (`@earendil-works/*`) and
   dogfoods the harness.
3. **Capability gains.** Copy-on-write workspace isolation (`--isolate`,
   enabled in wrily's profile — see Decision 11), output compression at
   the tool boundary, an NDJSON event stream that's a clean source for
   live observability and persistence.
4. **Long-term portability.** Gantry's subprocess + NDJSON contract is
   language-agnostic — wrily could move off Node entirely in the future
   if it ever made sense to.

## Gantry pre-flight contract changes

These land in gantry (separate PRs there) **before** wrily PR1
implementation starts. All are general-purpose harness features — none
encodes review/wrily semantics.

| # | Change | Rationale |
|---|---|---|
| G1 | Release pipeline: tagged releases with `gantry-<tag>-x86_64-unknown-linux-gnu.tar.gz` + `gantry-<tag>-aarch64-unknown-linux-gnu.tar.gz` + `SHA256SUMS`. **Pinned layout contract:** each tarball contains a single member `gantry` at archive root (flat, no directory prefix). | Wrily's Dockerfile extracts with `tar -xzf … -C /usr/local/bin gantry`; the flat layout is load-bearing. |
| G2 | Provider slug rename: `gemini/` → `google/` (env var stays `GEMINI_API_KEY`; base-URL override stays `GEMINI_API_BASE`). | Wrily's canonical slug form is `google/<model>`; `google` is also the conventional provider id (OpenRouter, pi-ai). Eliminates a translation layer in wrily. No aliasing — clean rename. |
| G3 | `--unify-file <path>` and `--compose-file <path>` flag overrides, symmetric with the existing `--system-file` / `--subagent-system-file`. Explicit flag overrides the profile value, per gantry's existing precedence rule. | Lets a consumer render per-run dynamic content into the unify/compose phases without templating the profile directory. Wrily's repeat-review contract (digest-driven actions) rides this. |
| G4 | `--skills-dir <dir>` (default: `<workdir>/.claude/skills`). Governs both `--inject-skill` resolution and the `skill_load` tool. | Decouples trusted skill content from the (potentially attacker-controlled) workdir. A review harness pointed at a PR checkout must not resolve injected prompts from that checkout. |
| G5 | Event telemetry: `subagent_done` gains `cache_read`, `cache_write`, `duration_ms`; `agent_turn` gains `duration_ms` (wall time of that model call). | Consumers reconstructing per-role cost rows need cache tokens and durations; gantry already has both at emission time. |
| G6 | Team-mode budget slices: the coordinator distributes the remaining global budget across spawned subagents; a subagent exceeding its slice is failed individually (`subagent_failed`, `reason: "budget"`) and the run continues. The run exits `budget` only when the **global** cap is hit. | Preserves partial-result resilience: today wrily drops a budget-tripped reviewer and unifies survivors. A global-only cap would turn one runaway subagent into a dead run. |
| G7 | Document the budget accounting formula for `--max-tokens`. Recommendation: count uncached `input + output + cache_write`; exclude `cache_read` (≈10% of cost, would otherwise dominate the count on long cache-heavy runs and make budgets provider-cache-sensitive). | Wrily's defaults are sized against this formula; whatever gantry pins, it must be documented. |
| G8 | Pin event `role` semantics in the README event table: `coordinator` for coordinator turns (team mode), the subagent's `name` for subagent turns, `single` in single mode. | Wrily's persistence mapping keys per-role accumulation on this. |

First gantry release tag (e.g. `v0.1.0`) cut after G1–G8 land.

## Locked decisions

1. **Full parity in one PR.** Path A — single-shot cutover. Wrily renders
   the prompt, spawns `gantry --profile profiles/review`, parses the
   NDJSON stream, and the existing post/persistence flow takes over.

2. **Provider matrix narrows to gantry's three.** `anthropic`,
   `openai`, `google` (Gemini) stay. `google-vertex`, `mistral`,
   `azure-openai-responses`, `cloudflare-workers-ai`,
   `cloudflare-ai-gateway`, Amazon Bedrock are removed from
   `src/config/providers.ts`, including the Bedrock-ambient-AWS branch
   of `hasAnyProviderAuth`. Upstream gantry contributions re-add them
   on the gantry side later (not part of this PR). With G2, wrily's
   canonical `google/<model>` slugs pass to `--model` verbatim — no
   translation layer exists anywhere.

3. **Budgets are tokens, end-to-end.** `.wrily.yml max_budget_usd` is
   replaced by `max_tokens` (positive integer); env override `MAX_BUDGET`
   becomes `MAX_TOKENS`. `AgentRunOptions.maxBudgetUsd` becomes
   `maxTokens`. The value passes to gantry's `--max-tokens` verbatim —
   no USD↔token conversion exists anywhere. Defaults:
   `DEFAULT_MAX_TOKENS_SINGLE = 2_000_000`,
   `DEFAULT_MAX_TOKENS_TEAM = 8_000_000` — placeholders to be
   calibrated against supabase token history before merge.
   Gantry shipped the recommended G7 formula verbatim: `--max-tokens`
   counts `input + output + cache_write` and **excludes `cache_read`** —
   size both defaults against exactly this.
   `AgentBudgetExceededError` semantics shift from "USD budget" to
   "token budget"; message text updated, class name and
   `stdout`/`stderr` fields unchanged (the `persist/failure.ts`
   name-matching and `post/failureFallback.ts` instanceof contracts
   survive untouched). Team-mode resilience is preserved by G6
   (per-subagent slices) instead of wrily-side budget splitting.
   PR1 includes a **narrow** supabase migration renaming
   `max_budget_usd` → `max_tokens` (bigint) on `review_runs`; the full
   tokens-only migration (dropping `cost_usd` from the write path)
   remains the follow-up.

4. **Gantry binary distribution: prebuilt release artifact.** Wrily
   pulls a tagged release tarball from gantry's GitHub Releases,
   SHA256-verifies it against `SHA256SUMS`, and copies the binary into
   the wrily Docker image. No Rust toolchain in wrily's build.
   Prerequisite: G1.

5. **Wrily owns its review profile.** `profiles/review/` lives in
   wrily's tree as a first-class copy, initially forked from gantry's
   `profiles/review/`. Decoupled from gantry's release cadence.
   Divergence allowed — and required on day one: the
   `REVIEWER_SECURITY_PREAMBLE` from `teamRoles.ts` is folded into
   **both** `system.md` and `subagent.md` (single mode loads only
   `system.md`; the guards must not be team-mode-only).

6. **Review mode passes through; single mode survives.**
   `resolveReviewStep`'s `mode: single|team|auto` + `team_threshold`
   logic is unchanged; `state.reviewMode` maps directly to gantry's
   `--mode single|team` (overriding the profile's `mode = "team"`
   default, which gantry's precedence rules already support). Single
   mode uses `system.md` + the rendered task prompt, which carries the
   full JSON output contract exactly as today (`render.ts` note: "the
   agent emits JSON only"). `review_mode` persistence
   (`ReviewRunRecord`) and the watermark `mode=` field (`body.ts`) keep
   their existing inputs.

7. **NDJSON consumption is streaming, behind the existing
   `AgentRunner` interface — constructed at the composition root.**
   `GantryRunner` is instantiated once in `main.ts` with **static**
   deps only (`binary`, `profileDir`); all per-run inputs ride
   `AgentRunOptions` (see "Interface changes"). It parses events as
   they arrive, fires per-event hooks (logging/observability), buffers
   the event list, and returns it on `AgentResult.events`. The runner
   holds no per-run state across calls. The fake-runner test seam
   (`WorkflowDeps.agentRunner`) is untouched; fakes simply return
   results without `events`.

8. **Model validation + cost rates live in one static manifest** at
   `src/agent/models.ts` (slug, aliases, per-MTok rates for
   input/output/cache-read/cache-write), seeded from the models
   currently documented for the three retained providers.
   `modelResolver.ts` keeps its public API; `ModelLookup` wraps the
   manifest; the `ALIASES` map moves into the manifest rows.
   **Resolution site:** `GantryRunner.run()` calls `resolveModel()` as
   its first act (mirroring where `defaultPiSessionFactory` did it) —
   raw aliases like `opus` never reach the subprocess.
   Unknown-model escape hatch: `WRILY_ALLOW_UNKNOWN_MODEL=1` (parsed in
   `env.ts`, not ad-hoc `process.env` reads); unknown models persist
   with `cost_usd = 0` and a loud warn.

9. **Persistence: full mapping, batched flush, closure by
   subtraction.** `subagent_done` events become `SubagentRecord` rows
   (tokens/cache/duration from the event per G5, `role` = subagent
   name). The synthetic `coordinator` row is computed as
   **`result` totals − Σ subagent rows** (floored at 0 per field), so
   per-row sums always reconcile exactly with the run record;
   coordinator `duration_ms` = Σ coordinator-role `agent_turn.duration_ms`.
   Role names become semantic (`correctness`, `api-conventions`, …) and
   row count varies with the model-composed roster — an accepted
   consumer-visible change from today's deterministic `team-0..N`.
   When `AgentResult.events` is absent (fakes), `persistUsageStep`
   writes one aggregate row per result (role = review mode), keeping
   existing workflow tests meaningful. Streaming flush (one Supabase
   write per event) is deferred to the follow-up PR alongside the
   tokens-only schema migration.

10. **Skills are staged outside the workdir; the workdir is treated as
    hostile.** A fresh `mkdtemp` staging directory is assembled per
    run: wrily's four invariant skills (`agent-team-review`,
    `code-review`, `confidence-rating`, `caveman-review`) copied from
    wrily's own install tree (`skills/`), plus name-validated user
    skills from the shared-repo clone. A user skill whose name collides
    with an invariant skill is rejected (warn + skip) — `.wrily.yml`
    cannot shadow the review guards. The staging dir passes to gantry
    via `--skills-dir` (G4); user skills append as `--inject-skill`
    flags after the profile's invariant set. Nothing is ever written
    into the PR checkout's `.claude/`, and nothing is ever resolved
    from it. The home-directory bridging foot-gun and the
    PR-ships-a-poisoned-skill vector both disappear.

11. **Isolation on.** Wrily's `profile.toml` sets `isolate = true`:
    the run executes against a copy-on-write shadow of the checkout
    (recursive-copy fallback guarantees availability in CI
    containers). Allowlisted-but-mutating commands (`git checkout`,
    …) cannot corrupt the real checkout mid-review, and the terminal
    `changes` event gives a free audit trail. Motivation #3 is now
    actually exercised.

12. **Failure mapping is direct, with wrily-side wedge protection.**
    Gantry's `result.exit` maps per the table below (full exit set as
    shipped in v0.1.0: `ok`=0, `error`=1, `budget`=2, `timeout`=3,
    `config`=4, `rate_limited`=5). **`rate_limited` (5) is recoverable**:
    `GantryRunner` does a bounded backoff-retry honoring the terminal
    `error` event's `retry_after_ms` hint, capped by the remaining
    timeout budget; on exhaustion it throws `AgentRateLimitedError`.
    Separately, a watchdog at `timeoutMs + 30s` grace handles a wedged
    child: on trip, SIGTERM, SIGKILL after 5s, throw `AgentTimeoutError`.
    If stdout reaches EOF without a `result` event, synthesize the
    outcome from the process exit code via the **same full table**
    (so 4→config, 5→rate_limited are not mislabelled "generic error")
    using the buffered text. A wedged or crashed gantry can never leave
    wrily waiting for the CI reaper. Note: a `config`-exit run emits no
    `start` (hence no `schema_version`) — the EOF path keys on exit code
    alone, not on having seen a `start`.

13. **Gantry version pinning lives in `.gantry-version`** at the repo
    root. Dockerfile reads it via `ARG GANTRY_VERSION`. A weekly cron
    workflow opens a PR when the pinned version drifts from gantry's
    latest GitHub release.

14. **Dynamic review context reaches gantry through two channels.**
    (a) The task prompt (`renderedPrompt`, written to a tmp file
    outside the workdir, passed via `--prompt-file`) — carries the
    diff instructions, style/sensitivity, and (single mode) the full
    output contract, as today. (b) A **per-run rendered unify prompt**
    (team mode), written to the same tmp dir and passed via
    `--unify-file` (G3) — carries the full four-action JSON contract
    (`new_comment` / `reply_in_thread` / `suppress` / `resolve_thread`),
    the digest instructions, and the style/sensitivity/delta-clean/
    confidence instructions that today ride
    `UNIFY_REVIEW_PROMPT_TEMPLATE`. The `REVIEWER_REPORTS` /
    `REVIEWER_COUNT` placeholders are dropped — gantry supplies
    subagent reports to the unify phase itself. The prior-feedback
    digest JSON is written to `<workdir>/.wrily/prior-feedback.json`
    (it must be readable by gantry's **workdir-confined** tools; the
    OS tmpdir location used today would be unreachable by `read_file`).

## Architecture

After the cutover the runtime topology is:

```
.wrily.yml + env → config/env.ts (RuntimeEnv)
                ↓
workflow/steps.ts (Mastra)
  → stage skills into mkdtemp dir (invariant set + user skills)
  → write digest to <repo>/.wrily/prior-feedback.json
  → render task prompt → tmp/prompt.md
  → render unify prompt → tmp/unify.md          (team mode only)
  → runner.run(...)  [GantryRunner, injected via WorkflowDeps]
      spawns: gantry --profile <wrily>/profiles/review
                     --mode <single|team>
                     --model <canonical slug>
                     --workdir <repo>
                     --prompt-file tmp/prompt.md
                     --unify-file tmp/unify.md   (team mode)
                     --skills-dir <staging>
                     --inject-skill <user-skill-1> …
                     --max-tokens <cfg.max_tokens>
                     --timeout-ms <DEFAULT_TIMEOUT_MS>
      • consumes NDJSON on stdout, streams hooks (logs/observability)
      • buffers events; returns them on AgentResult.events
      • maps result.exit → AgentResult or thrown error
  → existing extractFindings / route / post / persist
```

The `AgentRunner` interface remains the sole seam; the rest of wrily
doesn't know whether the runner is gantry or a fake. `FakeAgentRunner`
and `SequenceFakeAgentRunner` continue to satisfy the interface for
workflow tests.

## Interface changes (`src/agent/runner.ts`)

`AgentRunOptions`:

| Field | Change |
|---|---|
| `maxBudgetUsd` | **Replaced** by `maxTokens: number`. |
| `systemPrompt` | **Removed** — only consumer was `teamReview.ts` (deleted). |
| `mode: 'single' \| 'team'` | **New.** Forwarded to `--mode`. |
| `extraSkills?: string[]` | **New.** User skill names → `--inject-skill` flags. |
| `skillsDir?: string` | **New.** Staging dir → `--skills-dir`. |
| `unifyPromptPath?: string` | **New.** Rendered unify file → `--unify-file` (team mode). |
| `prompt`, `model`, `workingDir`, `env`, `timeoutMs` | Unchanged. |

`AgentResult`:

| Field | Change |
|---|---|
| `events?: AgentEvent[]` | **New, optional.** The buffered NDJSON event list. Fakes omit it. |
| everything else | Unchanged. |

## Component-level changes

### `src/agent/`

| File | Disposition |
|---|---|
| `runner.ts` | Extended per "Interface changes" above. |
| `factory.ts` | Deleted. `main.ts` constructs `new GantryRunner({ binary, profileDir })` directly. |
| `pi.ts` | Deleted. `DEFAULT_TIMEOUT_MS` (and its below-CI-ceiling rationale comment) moves to `gantry.ts`. |
| `gantry.ts` | **New.** Implements `AgentRunner`. See "GantryRunner" below. |
| `models.ts` | **New.** Static manifest: canonical slug, aliases, per-MTok rates (input / output / cache-read / cache-write). Backs `modelResolver` and cost computation. |
| `modelResolver.ts` | Keep public API. `ModelLookup` impl wraps `models.ts`; `ALIASES` moves into manifest rows. `WRILY_ALLOW_UNKNOWN_MODEL` honored here. |
| `fake.ts` | Minor: signature follows `AgentRunOptions` changes; optionally accepts canned `events` for persistence tests. |
| `errors.ts` | Budget error message text → tokens. **New `AgentRateLimitedError`** (`retryAfterMs`, `stdout`, `stderr`) thrown on exit-5 retry exhaustion; it falls through `classifyFailure`'s default → `'failed'` status (a dedicated status is a follow-up), so `persist/failure.ts` stays untouched. Existing class names/signatures otherwise unchanged. |

### `src/workflow/`

| File | Disposition |
|---|---|
| `steps.ts` | `bridgeSkillsStep` → `stageSkillsStep` (mkdtemp staging dir, invariant + user skills, collision rejection; sets `state.skillsStagingDir`). `fetchDigestStep` writes the digest under `<repoPath>/.wrily/` instead of OS tmpdir. `renderPromptStep` additionally renders the unify file in team mode. `agentCallStep` calls `runner.run()` once with `mode: state.reviewMode`, `maxTokens`, `skillsDir`, `extraSkills`, `unifyPromptPath`. `persistUsageStep` maps `AgentResult.events` per Decision 9 (aggregate-row fallback when absent). All other steps unchanged. |
| `teamReview.ts` | Deleted. Gantry's team mode + G6 budget slices replace it (including the drop-failed-reviewers resilience; gantry fails the run only on team collapse). |
| `teamRoles.ts` | Deleted. Security preamble → profile `system.md` **and** `subagent.md`. Role briefs/templates → `profiles/review/` content. Deterministic composition is replaced by `compose.md` (model-driven roster). |
| `reviewContext.ts` | **Retained, reshaped** (not deleted — `buildReviewPromptContext` feeds `renderPromptStep` regardless of gantry). The unify half becomes `buildUnifyFileContext` feeding the per-run `--unify-file` render; `reviewerReports`/`reviewerCount` inputs are dropped. |
| `state.ts` | Add `skillsStagingDir?: string`. `agentResults` stays (always length 1 post-cutover; events ride `agentResults[0].events`). |
| `index.ts` | Step id rename only. |

### `src/skills/`

`loader.ts` — `bridgeSkills` becomes `stageSkills(sources, stagingDir)`
with copy-into-fresh-dir semantics (the staging dir is a per-run
`mkdtemp`, so no overwrite/collision flags are needed at the FS level;
name-collision policy lives in the step). `names.ts` unchanged.

### `src/config/`

| File | Disposition |
|---|---|
| `providers.ts` | Drop the 6 unsupported provider rows; keep `anthropic`, `openai`, `google`. Remove the entire Bedrock/AWS ambient-auth branch (`AWS_CREDENTIAL_ENV_VARS`, `hasBedrockAuth`). Update doc comments (pi references go away). |
| `env.ts` | `MAX_BUDGET` → `MAX_TOKENS` (positive-integer string). New: `WRILY_GANTRY_BIN` (optional path, default `gantry`), `WRILY_ALLOW_UNKNOWN_MODEL` (optional `'1'`). All through the zod schema → `RuntimeEnv`; no ad-hoc `process.env` reads. |
| `types.ts` / `wrilyYml.ts` | `max_budget_usd` → `max_tokens` (int, defaults per Decision 3). |

### `src/persist/`

| File | Disposition |
|---|---|
| `types.ts` | `ReviewRunRecord.max_budget_usd` → `max_tokens: number \| null`. `SubagentRecord` unchanged. |
| `failure.ts` | Field rename only; `classifyFailure` untouched. |
| `supabase.ts` | Unchanged. |
| `supabase/migrations/` | **New narrow migration**: rename `review_runs.max_budget_usd` → `max_tokens`, type bigint. (Full tokens-only migration stays the follow-up.) |

### `src/prompt/`

| File | Disposition |
|---|---|
| `templates.ts` | `UNIFY_REVIEW_PROMPT_TEMPLATE` reshaped into the unify-file template: four-action contract + digest instructions + style/sensitivity/delta-clean/confidence; `REVIEWER_REPORTS`/`REVIEWER_COUNT` placeholders removed. `REVIEW_PROMPT_TEMPLATE` unchanged. |
| `render.ts` | `renderUnifyPrompt` → `renderUnifyFile` (same templating, new context type). |
| `instructions.ts` | Unchanged (digest path argument now points into the workdir). |

### `package.json`

Remove `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
No new npm deps — `GantryRunner` uses node built-ins (`child_process`,
`readline`).

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
# … existing wrily layers — MUST include skills/ and profiles/review/ …
```

The `GANTRY_VERSION` arg is sourced from `.gantry-version` at build time
(CI passes `--build-arg GANTRY_VERSION=$(cat .gantry-version)`). The
flat-tar member layout is the G1 contract.

### `.gantry-version`

**New.** One line: the pinned gantry release tag — **`v0.1.0`** (current
release; commit `d9e885d`). A
weekly cron workflow at `.github/workflows/gantry-version-bump.yml`
calls `gh release view -R <gantry-repo> --json tagName`, compares to
`.gantry-version`, and opens a PR with the updated tag and a one-line
release-note summary when drift exists.

### `profiles/review/`

**New.** Wrily's owned copy, forked from gantry's `profiles/review/`
(header comment: "Forked from gantry@\<SHA\>; owned by wrily;
divergence allowed."). Day-one divergences from the upstream copy:

| File | Divergence |
|---|---|
| `profile.toml` | `isolate = true`; `shell_allow` gains `grep` and `rg` (pi reviewers had a grep tool + unrestricted bash; reviewers grep constantly). |
| `system.md` | Coordinator/single-mode persona **+ the security preamble** (from `teamRoles.ts`). |
| `subagent.md` | Reviewer persona **+ the same security preamble**. |
| `compose.md` | As upstream (rule-based roster prompt). |
| `unify.md` | Static fallback only — the live unify prompt is the per-run render passed via `--unify-file` (Decision 14). Kept aligned with the template so a missing override still produces parseable output. |

```toml
mode = "team"
system = "system.md"
subagent_system = "subagent.md"
compose = "compose.md"
unify = "unify.md"
tools = ["read_file", "list_files", "find_files", "git_diff", "ast_grep", "shell", "skill_load"]
inject_skills = ["agent-team-review", "code-review", "confidence-rating", "caveman-review"]
shell_allow = ["git", "cat", "ls", "find", "grep", "rg"]
isolate = true
```

## GantryRunner

```ts
// src/agent/gantry.ts (signature sketch)
export class GantryRunner implements AgentRunner {
  constructor(private readonly deps: {
    binary: string;            // env.wrilyGantryBin ?? 'gantry'
    profileDir: string;        // wrily-owned profiles/review/
    hooks?: GantryHooks;       // static observability hooks
  });

  async run(req: AgentRunOptions): Promise<AgentResult> {
    // 1. resolveModel(req.model, manifest) — aliases never reach the child
    // 2. write req.prompt to mkdtemp (OUTSIDE workdir) → --prompt-file
    // 3. assemble argv: --profile --mode --model --workdir --max-tokens
    //    --timeout-ms [--unify-file] [--skills-dir] [--inject-skill …]
    // 4. spawn; start watchdog at timeoutMs + 30s grace
    //    (trip → SIGTERM, 5s, SIGKILL → throw AgentTimeoutError)
    // 5. parse stdout line-by-line as NDJSON (readline)
    //    NB: assert start.schema_version === "1.1"; warn on mismatch
    //    - assistant_text: append to per-role buffer (capped, 1 MiB)
    //    - all events: push to event list, fire hooks.onEvent
    //    - result: finalize
    //    stderr: captured, capped at 256 KiB
    // 6. map result.exit via the full table: 0 ok | 1 error | 2 budget
    //    | 3 timeout | 4 config | 5 rate_limited. exit 5 is RECOVERABLE:
    //    bounded backoff-retry honoring error.retry_after_ms, capped by
    //    remaining timeout; on exhaustion → AgentRateLimitedError
    // 7. stdout EOF without result event → synthesize via the SAME full
    //    table from the child exit code (incl. 4→config, 5→rate_limited)
    // 8. SIGTERM to wrily → forward to child (cooperates with main.ts's
    //    existing handleTermination; gantry exits `timeout` on SIGTERM)
  }
}

interface GantryHooks {
  onEvent?(event: AgentEvent): void; // logs / observability; sync, fire-and-forget in v1
}
```

The streaming-flush follow-up PR makes hooks async and wires Supabase
writes through them; v1 persistence consumes the buffered
`AgentResult.events` after the run.

## Failure mode mapping

| `result.exit` | Code | Wrily outcome |
|---|---|---|
| `ok` | 0 | Return `AgentResult { stdout: <final coordinator/single text>, tokenUsage (from result totals + models.ts cost), model, durationMs, exitCode: 0, events }`. |
| `budget` | 2 | `throw new AgentBudgetExceededError(stdout, stderr)` — `stdout` = concatenated buffered `assistant_text`, `stderr` = captured gantry stderr. |
| `timeout` | 3 | `throw new AgentTimeoutError(timeoutMs, stdout, stderr)`. |
| `error` | 1 | `throw new Error("gantry: <message>")` — carries the terminal `error` event message (incl. `team_collapse`). |
| `config` | 4 | `throw new Error("gantry config: <message>")` — wrily argv-assembly bug; should never happen at runtime. |
| `rate_limited` | 5 | **Recoverable.** Bounded backoff-retry honoring `error.retry_after_ms` (capped by remaining timeout); on exhaustion `throw new AgentRateLimitedError(retryAfterMs, stdout, stderr)`. |
| *(no result event)* | — | Synthesized from the process exit code via the full table above (incl. 4/5) per GantryRunner step 7. |
| *(no exit at all)* | — | Watchdog per GantryRunner step 4 → `AgentTimeoutError`. |

A malformed NDJSON line is logged at warn and skipped; if the stream
then ends without a `result` event, the EOF synthesis path applies.
"Detect early, fail loudly."

## Persistence mapping

Event order for one team run (per gantry's documented vocabulary + G5/G8):

```
start
  agent_turn (role=coordinator, duration_ms, tokens…)      ← compose
  subagent_spawn (name=correctness, scope=…)
  …
  agent_turn (role=correctness, …) / tool_call / tool_result …
  subagent_done (name=correctness, turns, input_tokens,
                 output_tokens, cache_read, cache_write, duration_ms)
  subagent_failed (name=…, reason)                          ← dropped lane
  …
  agent_turn (role=coordinator, duration_ms, tokens…)       ← unify
result (exit, total_input, total_output, total_cache_read,
        total_cache_write, duration_ms)
```

At `persistUsageStep` (batched-flush model), from `agentResults[0].events`:

- One `ReviewRunRecord` from `result` totals (`duration_ms` from the
  event; `max_tokens` from cfg; cost from `models.ts` rates × totals).
- N `SubagentRecord` rows, one per `subagent_done`, with
  `role = name`, tokens/cache/duration straight off the event (G5),
  `model` = the run's canonical slug (gantry runs one model per run).
- One synthetic `SubagentRecord` with `role = 'coordinator'`:
  **tokens = `result` totals − Σ subagent rows (per field, floored at
  0)**; `duration_ms` = Σ coordinator-role `agent_turn.duration_ms`.
  Closure invariant: run record totals === Σ all subagent rows, by
  construction.
- `subagent_failed` lanes produce no row in v1 (no totals are emitted
  for them); the unify output reports them as gaps.

`subagent_failed.reason` is pinned to `"budget"` (slice exceeded) or
`"panic"`, else free-form provider text — match those literals if the
streaming-flush follow-up ever surfaces dropped lanes.

When `events` is absent (fake runners): one row per `AgentResult`,
`role` = `'single'` or `'coordinator'` by review mode — the existing
workflow tests keep asserting against real behavior.

Cost per row = `models.ts` rates × token counts (0 + warn for
unknown-model runs).

## Runtime control flow inside the agent step

```ts
// main.ts (composition root)
const agentRunner = new GantryRunner({
  binary: env.wrilyGantryBin ?? 'gantry',
  profileDir: resolveProfileDir(),       // wrily-owned profiles/review/
});
const workflow = buildReviewWorkflow({ agentRunner, octokit, graphqlClient });
```

```ts
// inside steps.ts agentCallStep (sketch)
const result = await deps.agentRunner.run({
  prompt: state.renderedPrompt!,
  model: state.cfg.model,                 // resolved inside the runner
  mode: state.reviewMode ?? 'single',
  workingDir: state.repoPath!,
  maxTokens: state.cfg.max_tokens ?? defaultMaxTokens(state.reviewMode),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  skillsDir: state.skillsStagingDir,
  extraSkills: state.loadedSkills,        // user skills only
  unifyPromptPath: state.unifyPromptPath, // team mode only
  env: process.env,
});

state.agentResults = [result];            // singleton; the team is inside gantry
return state;
```

`agentResults` stays an array for downstream compatibility; post-cutover
it is always length 1, and per-subagent telemetry lives on
`result.events`.

## Build & distribution

| Concern | Approach |
|---|---|
| Binary architecture | x86_64 + aarch64 `-unknown-linux-gnu`, glibc. Selected via Docker `TARGETARCH`. |
| Artifact contract | G1: asset naming + flat single-member tar + `SHA256SUMS`, verified in the Docker build before extraction. |
| Provenance | If gantry releases add sigstore/SLSA provenance, prefer but don't require for v1. |
| Image bloat | Fetch stage discarded; final image gains only the gantry binary (~15-30 MB). |
| Local dev | `WRILY_GANTRY_BIN` (via `env.ts`) points at a locally-built `gantry` (e.g. sibling checkout `target/release/gantry`). |
| Self-hosting | `docs/self-hosting.md` updated: no Node-side `@earendil-works/*` install; binary ships in the image. |

## Test strategy

The `AgentRunner` + fake seam stays; all existing workflow tests that
inject fakes continue to work (modulo the `AgentRunOptions` field
renames).

New tests for the runner:

- `tests/fixtures/gantry/*.ndjson` — **generated from real gantry runs**
  (committed verbatim, not hand-written), covering: happy-path team run,
  `budget` exit, `timeout` exit, `rate_limited` (exit 5) carrying a
  `retry_after_ms` hint, `subagent_failed` mid-run with completed run,
  malformed line mid-stream, stream EOF without `result`.
- `tests/fixtures/gantry/gantry-stub.sh` — `cat $1; exit $2` for spawn
  tests; a `sleep`-then-exit variant for the watchdog test.
- `tests/agent/gantry.test.ts` — each fixture through the parser
  directly AND through the stub-binary spawn path; asserts:
  - `AgentResult` shape incl. `events`
  - correct error class per non-ok exit (incl. `AgentRateLimitedError`
    for exit 5 after retry exhaustion), **and per EOF-synthesis path**
  - watchdog kills a hung child and throws `AgentTimeoutError`
  - argv assembly: `--mode` passthrough (single + team), `--skills-dir`,
    `--inject-skill` ordering, `--unify-file` presence only in team mode
  - alias resolution happens before spawn (fake binary records argv)
  - SIGTERM forwarding (skipped on Windows runners)
- `tests/workflow/persist-events.test.ts` — `SubagentRecord`
  reconstruction from a real-run fixture, including the
  coordinator-by-subtraction closure invariant (Σ rows === run totals)
  and the no-events fallback.
- **Unify-contract pin test**: the committed real-run unify output fed
  through `extractFindings` must parse — including at least one fixture
  exercising `reply_in_thread` / `suppress` / `resolve_thread` actions
  (digest-seeded run). This is the guard against the profile fork
  drifting from `extract.ts`'s schema.
- Skills staging test: invariant set staged from install tree; user
  skill colliding with an invariant name is rejected; staging dir is
  fresh per run.

Deleted alongside their subjects: `tests/agent/pi.test.ts`,
`tests/agent/pi-factory.test.ts`, `tests/agent/factory.test.ts`,
`tests/workflow/teamRoles.test.ts`,
`tests/workflow/team-orchestration.test.ts`.
`team-threshold-folders.test.ts` and `single-mode.test.ts` stay (the
threshold + mode logic survives).

## Migration plan

**Phase 0 — gantry pre-flight (gantry repo) — ✅ DONE (v0.1.0):**

1. ✅ G2–G8 contract changes merged to gantry `main` (`d9e885d`),
   PRs #21–#24.
2. ✅ G1 release pipeline landed (PR #25); `v0.1.0` tagged with both
   linux-gnu tarballs + `SHA256SUMS`, flat-member layout verified.

**Phase 1 — the wrily PR:**

1. Add `profiles/review/` (fork + day-one divergences per table).
2. Add `src/agent/gantry.ts`, `src/agent/models.ts`; extend `runner.ts`.
3. Re-back `modelResolver.ts` with the manifest.
4. Rework `steps.ts`: `stageSkillsStep`, digest-into-workdir,
   unify-file render, `agentCallStep`, `persistUsageStep`.
5. Reshape `reviewContext.ts` (keep `buildReviewPromptContext`; unify
   half → unify-file context); reshape `templates.ts`/`render.ts`.
6. Delete `src/agent/pi.ts`, `src/agent/factory.ts`,
   `src/workflow/teamReview.ts`, `src/workflow/teamRoles.ts`, and the
   tests listed above.
7. Config: `max_tokens` (types, wrilyYml, env.ts incl. `MAX_TOKENS`,
   `WRILY_GANTRY_BIN`, `WRILY_ALLOW_UNKNOWN_MODEL`); providers.ts
   narrowed, AWS branch removed.
8. Persistence: `max_tokens` field rename + narrow supabase migration.
9. Drop `@earendil-works/*` deps; regenerate lockfile.
10. `.gantry-version` + `gantry-version-bump.yml` cron.
11. Dockerfile gantry-fetch stage (+ ensure `skills/` and
    `profiles/review/` are in the image).
12. Docs: `docs/adoption.md`, `docs/self-hosting.md`, `README.md`,
    `.wrily.yml.example` — provider narrowing + `max_tokens`.
13. Fixtures + tests per "Test strategy" (fixtures generated against a
    locally-built gantry at the pinned tag).

**Validation (pre-merge, explicit):** the deployed bot still runs the
old pi build, so "the bot reviews the PR" validates nothing about
gantry. Instead: run the **branch's** wrily via `local_cli`
(`./wrily`) against the cutover PR, with `WRILY_GANTRY_BIN` pointing at
the pinned-tag gantry binary — once in team mode, once with
`MODE=single`, once against a PR with prior wrily threads (exercises
the digest → `reply_in_thread`/`resolve_thread` path). Post-merge, the
deployed bot reviewing subsequent PRs is the ongoing confirmation.

**Rollback:** revert the merge commit plus the narrow supabase
migration (paired down-migration committed alongside). The pre-cutover
state (PR #32's pi integration) is the baseline being replaced.

## Non-goals

- Re-adding the 6 dropped providers as gantry adapters. Tracked
  separately as gantry contributions.
- USD-denominated budget config. Could return later as a wrily-level,
  rate-informed conversion on top of `max_tokens`; not in this PR.
- Tokens-only persistence schema migration beyond the narrow
  `max_tokens` column rename. Follow-up wrily PR (paired with the
  streaming-flush rework).
- Streaming per-event Supabase flush. Follow-up wrily PR.
- Per-subagent model selection (gantry runs one model per run; revisit
  upstream if ever needed).
- Supporting gantry deployed separately from wrily's image.
- Backward-compat shims of any kind — neither project is in active
  use; every rename is a clean cutover.

## Operational follow-ups

These land after PR1 merges, in order:

1. Self-hosting docs revision: new image content, `WRILY_GANTRY_BIN`
   local-dev override.
2. Tokens-only persistence migration (Section 7 option C from the
   brainstorm): drop `cost_usd` from the write path; teach `wrily
   costs` to compute USD at query time from `src/agent/models.ts`
   rates. (The `max_tokens` column rename already landed in PR1.)
3. Streaming-flush persistence (Section 8 option C from the
   brainstorm): make `GantryHooks` async and route `subagent_done`
   writes through them.
4. Upstream gantry adapter contributions for Bedrock, Vertex, Mistral,
   Azure, Cloudflare-WAI, Cloudflare-AIG. Once each lands in a gantry
   release, wrily re-enables the provider in `providers.ts` and adds
   it to `models.ts`.
