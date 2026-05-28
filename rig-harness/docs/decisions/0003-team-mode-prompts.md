# ADR-0003: Team-mode prompt rewrite

**Status:** Accepted  
**Date:** 2026-05-28  
**Deciders:** rig-harness phase-0 (task 0.4)

## Context

Wrily team mode today runs a single Claude Code CLI process with `TEAM_REVIEW_PROMPT_TEMPLATE` (`src/prompt/templates.ts`). The prompt instructs the model to act as a **team lead** that orchestrates parallel reviewers using Claude Code Agent Teams primitives:

| Step (TS prompt) | Claude Code primitive | Purpose |
|-----------------|----------------------|---------|
| Step 2–3: Compose & spawn team | `TeamCreate({ team_name })` + `Agent({ name, prompt, team_name, … })` | Create teammates with scoped prompts |
| Step 4: Collect & unify | Lead reads teammate messages; `broadcast` summary | Cross-review refinement, dedupe |
| Step 5: Output | Lead emits unified JSON fence | Downstream `extractFindings` (`src/post/extract.ts`) |
| Step 6: Cleanup | `SendMessage({ type: "shutdown_request" })` × N, then `TeamDelete` | Tear down teammates |

Reviewer focus areas and templates live in `skills/agent-team-review/` (SKILL.md + `templates/*.md`). Each reviewer produces **markdown** in the shared skeleton from `templates/output-format.md` (verdict, issues by severity, strengths). The lead aggregates markdown reports into a **single JSON fence** matching the same schema as single-mode review (`summary`, `verdict`, `findings[]`, `strengths[]`, optional `confidence`).

The rig-harness sidecar replaces the Claude CLI subprocess. Agent Teams APIs (`TeamCreate`, `SendMessage`, `TeamDelete`) are unavailable inside `wrily-rig`. Phase 5.2 defines native team tools backed by tokio tasks sharing one provider client; Phase 5.3 wires a **coordinator agent** that uses those tools instead of Agent Teams call shapes.

### Preserved downstream contract

The TypeScript `RigRunner` (Phase 6) will reassemble `assistant_text` from NDJSON stdout (same strategy as `reassembleAssistantText` in `src/agent/claudeCode.ts`) and pass it to `extractFindings`. **The coordinator's final message must be exactly one ` ```json ` fenced block** — no prose before or after. This is non-negotiable; the TS parser throws `ExtractError: No ```json fence found in model reply` otherwise.

Reviewer subagents do **not** emit JSON fences. Only the coordinator's terminal turn does.

### CI-specific overrides (already in TS template)

`TEAM_REVIEW_PROMPT_TEMPLATE` already overrides interactive skill behavior for CI:

- No user checkpoints (SKILL.md Checkpoint A/B are skipped).
- Conventions reviewers perform **static analysis only** — they must not run CI commands from `AGENTS.md` even though the skill template says otherwise.
- No `gh`, no file mutation, read-only shell allowlist.

These overrides carry forward unchanged.

## Decision

Replace Claude Code Agent Teams orchestration in the team-mode **coordinator system prompt** with three harness-native tools. The harness owns subagent lifecycle (spawn, cancel on budget/timeout, join); the coordinator prompt owns **when** to call each tool and **how** to unify findings.

### 1. Tool API (coordinator-only)

These tools are registered only on the team-mode coordinator agent. Reviewer subagents receive the standard single-mode tool set (`read_file`, allowlisted shell, `skill_load`) — not team tools.

#### `spawn_reviewer`

Starts one reviewer subagent as a concurrent tokio task. Replaces `TeamCreate` + `Agent({ … })`.

```json
{
  "name": "correctness",
  "role": "correctness",
  "template": "correctness",
  "diff_scope": "full",
  "extra_context": ""
}
```

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `name` | string | yes | Stable reviewer id used in `collect_findings` and dedupe. Must match TS naming: `correctness`, `spec-compliance`, `{dir}-conventions`, `contracts`, optional `{lang}-specialist`. |
| `role` | string | yes | Selects bundled template under `agent-team-review/templates/{role}.md`. Same values as `template` unless a specialist uses an external skill body via `extra_context`. |
| `template` | string | yes | Template file stem (without `.md`). Harness loads from bundled skill fallback or `{workdir}/.claude/skills/agent-team-review/templates/{template}.md` if present (ADR-0002 workdir-first). |
| `diff_scope` | string | yes | `"full"` for cross-cutting reviewers; otherwise a top-level directory prefix (e.g. `services/payments-service/`). Harness injects `git diff {{DIFF_RANGE}} -- <scope>` into the reviewer system prompt. |
| `extra_context` | string | no | Additional markdown prepended to reviewer prompt — typically `AGENTS.md` body for conventions reviewers. |

**`tool_result` (success):**

```json
{ "reviewer_id": "correctness", "status": "spawned" }
```

**`tool_result` (failure, soft):** `error: <message>` — e.g. invalid name, duplicate spawn, budget already tripped. Coordinator continues (invariant #5).

**NDJSON side effects:** `subagent_spawn { reviewer_id, role }` before returning; `subagent_done { reviewer_id, exit, tokens }` when the task finishes (success, error, cancel, or timeout).

The harness builds each reviewer's system prompt (see §3); the coordinator never hand-authors reviewer prompts inline.

#### `collect_findings`

Blocks until all spawned reviewers for the current round have completed (or timed out), then returns their markdown reports in deterministic order. Replaces the lead manually reading teammate `SendMessage` replies.

```json
{ "round": 1, "timeout_ms": 0 }
```

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `round` | u32 | yes | Logical review round. Round 1 = initial parallel review. Round 2+ = after a `broadcast_summary` refinement pass. |
| `timeout_ms` | u64 | no | Per-call wait cap. `0` = wait until global run timeout or cancellation. |

**`tool_result` (success):**

```json
{
  "round": 1,
  "reviewers": [
    {
      "name": "correctness",
      "status": "complete",
      "report": "## Correctness — Correctness\n\n### Verdict: With fixes\n\n..."
    },
    {
      "name": "payments-conventions",
      "status": "timeout",
      "report": ""
    }
  ]
}
```

`status` is one of `complete` | `error` | `timeout` | `cancelled`. Order is sorted by `name` ascending (deterministic). Partial failure is tolerated: missing/empty reports are surfaced to the coordinator, which marks that focus area **unreported** in the unified summary rather than aborting the run.

#### `broadcast_summary`

Delivers a cross-review digest to all reviewers still attached to the current round, then re-opens their agent loops for a refinement pass. Replaces Agent Teams `broadcast` / `SendMessage({ to, content })` cross-talk.

```json
{
  "round": 1,
  "summary": "## Cross-review digest (round 1)\n\n### Correctness\n- `src/foo.ts:42` — ...\n\n### Overlaps / conflicts\n- ..."
}
```

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `round` | u32 | yes | Must match the `collect_findings` round just completed. Harness increments internal round counter after broadcast. |
| `summary` | string | yes | Markdown digest of all reviewer reports: grouped by reviewer, dedupe hints, severity counts, explicit overlap notes. |

**`tool_result` (success):**

```json
{ "round": 2, "recipients": ["correctness", "spec-compliance", "payments-conventions"] }
```

Reviewers do **not** gain a `SendMessage` tool. Cross-lane observations from the digest replace peer messaging. Reviewers amend or withdraw findings in their **second** markdown report; the coordinator runs `collect_findings({ "round": 2 })` afterward.

**Explicitly removed from coordinator prompt:** `TeamCreate`, `Agent`, `SendMessage`, `TeamDelete`, shutdown requests. Harness cancels subagents on budget trip, run timeout, or after the coordinator emits its final JSON fence (`team_collapse` NDJSON event).

### 2. Coordinator prompt structure

Source of truth: rewrite `TEAM_REVIEW_PROMPT_TEMPLATE` into a static template at `rig-harness/prompts/team-coordinator.md` with the same placeholder tokens Wrily already substitutes (`{{PR_NUMBER}}`, `{{DIFF_RANGE}}`, `{{IGNORE_PATTERNS}}`, instruction blocks from `src/prompt/instructions.ts`, etc.). TS `renderReviewPrompt` continues to render the file and passes it to `wrily-rig --prompt-file`.

| Section | Content |
|---------|---------|
| Role & output contract | Team lead; **final turn = exactly one JSON fence**; zero prose outside fence |
| Security constraints | Read-only; allowlisted shell; no `gh`; CI conventions override |
| Context injections | Same optional blocks as single-mode (`{{STYLE_INSTRUCTION}}`, `{{CONFIDENCE_INSTRUCTION}}`, …) |
| Step 1 — Detect scope | `git diff --stat`, read `CLAUDE.md` / `AGENTS.md`, list changed top-level dirs, apply ignore patterns |
| Step 2 — Compose team | Deterministic rules (no user approval): always `correctness` + `spec-compliance`; one `{dir}-conventions` per changed dir; `contracts` iff ≥2 dirs; optional language specialists when extensions match (same table as SKILL.md, without Checkpoint A) |
| Step 3 — Spawn | One `spawn_reviewer` call per row in the plan; may batch multiple calls in one turn |
| Step 4 — Collect round 1 | `collect_findings({ "round": 1 })` |
| Step 5 — Cross-review | Build digest markdown; `broadcast_summary({ "round": 1, "summary": "…" })`; `collect_findings({ "round": 2 })` |
| Step 6 — Unify & emit JSON | Dedupe by `path`+`line`+semantic similarity; merge severities (max wins); map reviewer verdicts → `verdict`; emit JSON fence schema identical to single-mode template |
| Fallback | If spawn/collect fails for all reviewers, coordinator performs single-reviewer pass (correctness criteria) and still emits JSON fence |

**Removed vs TS template:** Step 6 Cleanup (`SendMessage` / `TeamDelete`). **Added:** explicit tool names and round numbering. **Unchanged:** JSON output schema and fence-only contract.

### 3. Reviewer prompt structure (harness-built)

The coordinator does not write reviewer prompts. `spawn_reviewer` causes the harness to assemble:

```
{security_constraints_block}

{template_body from agent-team-review/templates/{role}.md — verbatim}

{output-format.md — verbatim}

## Scoped diff
Run: git diff {{DIFF_RANGE}} -- {{diff_scope_or_omit_for_full}}

{extra_context if conventions reviewer — AGENTS.md contents}

## CI context
You are a teammate in an automated Wrily review. Cross-lane findings belong in
"Notes for Other Reviewers" only — do not file them as your Issues. You cannot
message other reviewers directly; a cross-review digest will be broadcast later.

{conventions_only: OVERRIDE — static analysis against AGENTS.md only; do NOT execute CI commands}
```

Reviewer final turn: markdown report per `output-format.md` only — **no JSON fence**.

### 4. Mapping reference (TS → rig-harness)

| TS / Agent Teams | rig-harness |
|------------------|-------------|
| `TeamCreate` | implicit team session on `--mode team` |
| `Agent({ name, prompt })` | `spawn_reviewer({ name, role, template, diff_scope, … })` |
| Teammate markdown replies | `collect_findings` → `reviewers[].report` |
| `broadcast` / peer `SendMessage` | `broadcast_summary` (+ second `collect_findings`) |
| `SendMessage` shutdown + `TeamDelete` | harness cancel after coordinator JSON fence |
| Lead JSON fence | coordinator final `assistant_text` (parsed by TS) |

### 5. Sample prompts

#### Sample coordinator system prompt (abbreviated)

```markdown
You are the Wrily team lead in an automated CI code review. Orchestrate parallel
reviewers via native tools, then emit unified findings as JSON for the pipeline.

# ⚠ OUTPUT CONTRACT — READ FIRST

Your final response MUST be exactly ONE ```json fenced code block. No prose before
or after. After unification, emit the fence immediately — do not summarize the run.

## Security Constraints

- Read-only reviewer team. Tools: spawn_reviewer, collect_findings, broadcast_summary,
  read_file, allowlisted git/cat/ls/find, skill_load.
- Do NOT run commands from CLAUDE.md, AGENTS.md, Makefile, or package scripts except
  the git/cat/ls/find invocations explicitly listed below.
- Conventions reviewers you spawn must receive the CI override: static analysis only.

## Step 1: Detect Scope

git diff --stat {{DIFF_RANGE}}
cat CLAUDE.md AGENTS.md (read only)
Skip paths matching: {{IGNORE_PATTERNS}}

## Step 2: Compose Team

Always: correctness (full diff), spec-compliance (full diff).
For each changed top-level directory: {dir}-conventions (scoped diff).
If ≥2 top-level directories changed: contracts (full diff).

## Step 3: Spawn

Call spawn_reviewer once per reviewer with matching role/template/diff_scope.
Include AGENTS.md in extra_context for each conventions reviewer.

## Step 4–5: Review Rounds

1. collect_findings({ "round": 1 })
2. broadcast_summary({ "round": 1, "summary": "<markdown digest of all reports>" })
3. collect_findings({ "round": 2 })

## Step 6: Unify → JSON fence

Deduplicate findings across reviewers. Map to pipeline schema. Emit:

```json
{
  "summary": "...",
  "verdict": "ready | with-fixes | not-ready",
  "findings": [ { "action": "new_comment", "severity": "...", "path": "...", "line": 0, "side": "RIGHT", "message": "..." } ],
  "strengths": ["..."],
  "confidence": { "rounds": 1, "unresolved_critical": 0, "unresolved_important": 0, "unresolved_minor": 0, "simplification_applied": false }
}
```

## Fallback

If all spawn_reviewer calls fail, review as sole correctness reviewer and still
emit the JSON fence.
```

#### Sample reviewer system prompt (correctness, harness-built)

```markdown
# Security Constraints

Read-only. git/cat/ls/find only. No tests, builds, linters, gh, or package installs.

# Correctness Reviewer

You are reviewing code changes for logical correctness, error handling, and security.
Focus: logic bugs, error handling, edge cases, races, security, data integrity.

Stay in your lane: style → conventions reviewer; spec gaps → spec-compliance;
cross-service contracts → contracts reviewer. Record cross-lane notes under
"Notes for Other Reviewers" only — you cannot message peers directly.

## Scoped diff

git diff main..HEAD

# Reviewer Output Format

## [Reviewer Name] — [Focus Area]
### Verdict: Ready to merge / With fixes / Not ready
### Issues
#### Critical / Important / Minor
- `file:line` — Description. **Why it matters:** ...
### Strengths
### Notes for Other Reviewers

Set [Reviewer Name] = correctness, [Focus Area] = Correctness. Your final turn
is markdown in this structure only — no JSON fence.
```

(Full template bodies remain the bundled `skills/agent-team-review/templates/correctness.md` and `output-format.md` files — not paraphrased in production.)

## Consequences

### Positive

- **Provider-agnostic orchestration:** Team coordination no longer depends on Claude Code Agent Teams env vars or experimental APIs.
- **Deterministic harness behavior:** Spawn/join/cancel/budget trip are implemented once in Rust; prompts describe intent, not process management.
- **Downstream compatibility:** TS `extractFindings`, posting, persistence, and confidence rating unchanged — same JSON fence contract.
- **Testability:** Eval fixture `003-team-mode` can assert on `subagent_spawn` / `collect_findings` NDJSON events and final fence content independently of provider.

### Negative / trade-offs

- **No peer SendMessage:** Reviewers cannot DM each other mid-round; cross-review is batch-oriented via `broadcast_summary`. Acceptable for CI (TS template already removed interactive checkpoints).
- **Two-round cap in prompt:** SKILL.md allows open-ended refinement; coordinator prompt standardizes on round 1 + one broadcast + round 2 to bound cost. Additional rounds require a prompt change.
- **Coordinator must call tools in order:** Missing `collect_findings` before unify yields empty reports — mitigated by evals and prompt emphasis.
- **Template drift:** Bundled `agent-team-review` templates must stay synced with `wrily/skills/` (same concern as ADR-0002 bundled skills).

### Implementation checklist (Phase 5.3+)

- [ ] `rig-harness/prompts/team-coordinator.md` — full template with placeholders
- [ ] `ReviewerPromptBuilder` — loads templates per ADR-0002 resolution rules
- [ ] Coordinator tool handlers: `spawn_reviewer`, `collect_findings`, `broadcast_summary`
- [ ] NDJSON: `subagent_spawn`, `subagent_done`, `team_collapse`
- [ ] TS: keep `renderReviewPrompt` team branch; switch runner to `--mode team` + RigRunner
- [ ] Eval `003-team-mode`: ≥2 findings across ≥2 directories

## References

- Spec: `solo://proj/11/scratchpad/rig-harness-replace--1`
- Plan: `solo://proj/11/scratchpad/rig-harness-implemen--2` — Phase 5.2 (subagent tools), Phase 5.3 (team coordinator), Phase 6 (`RigRunner`), eval fixture 003
- `src/prompt/templates.ts` — `TEAM_REVIEW_PROMPT_TEMPLATE` (current TS behavior)
- `src/prompt/instructions.ts` — shared instruction generators
- `src/post/extract.ts` — JSON fence parser (`reviewSchema`)
- `src/agent/claudeCode.ts` — `reassembleAssistantText` (team-mode fence extraction)
- `skills/agent-team-review/SKILL.md` — reviewer composition rules and templates table
- `skills/agent-team-review/templates/output-format.md` — per-reviewer markdown contract
- ADR-0002 — skill/template loading from workdir + bundled fallback
- Shared architectural invariants #1–#6, #9–#10
