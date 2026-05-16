---
name: agent-team-review
description: Parallel multi-agent code review that spawns focused reviewer teammates (correctness, conventions, spec-compliance, contracts, language specialists) via Claude Code Agent Teams, runs CI, cross-references findings between reviewers, and produces a unified merge verdict. Use when the user asks for a team code review, multi-reviewer review, agent team review, parallel diff review across multiple services, or cross-service contract review. Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
compatibility: Claude Code with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1. Requires git, access to project/user/plugin skill directories for specialist discovery, and a shell environment capable of running the repo's CI commands (e.g. pnpm/cargo/go).
metadata:
  version: "2026.4.28"
---

# Agent Team Code Review

Parallel multi-agent code review using Claude Code Agent Teams. Spawns focused reviewer agents that collaborate to produce a unified assessment.

## Prerequisites

This skill requires Agent Teams. If the setting is not enabled, prompt the user to add it:

```json
// In ~/.claude/settings.json or .claude/settings.json (project level)
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Check before proceeding:** Verify the setting exists in either location. If missing, show the user the snippet above and stop until they confirm it's added.

## Invocation

```
/agent-team-review                          # auto-detect scope from git
/agent-team-review services/payments-service   # review specific directory
/agent-team-review --base develop           # diff against a different base branch
```

## Flow

### 1. Detect Scope

Confirm `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set (see Prerequisites above) and stop if not. Then run `git diff main...HEAD --stat` (or the user-specified base branch) to identify changed files. Group changes by top-level service or repo directory.

If no changes are detected, inform the user and stop.

### 2. Discover Specialist Skills → **Checkpoint A: specialist selection**

Specialist sources, in priority order:

1. **Built-in specialist templates** under `templates/` in this skill — currently `go-specialist.md` and `typescript-specialist.md`. These ship with the skill, work offline, and are the default choice when their language is in the diff.
2. **Project skills** (`.claude/skills/`): e.g., `/extension` for Rust/pgrx, `/cloudflare` for TypeScript Workers
3. **User skills** (`~/.claude/skills/`): e.g., `rust-pro`, language-specific reviewers
4. **Plugin skills**: e.g., `beagle-go:go-code-review`, `beagle-go:review-go`

Match by:
- Built-in template ↔ file extension: `.go`/`go.mod`/`go.sum` → `go-specialist`; `.ts`/`.tsx`/`.mts`/`.cts`/`tsconfig*.json`/`package.json` → `typescript-specialist`
- External skill description mentioning the changed repo name
- External-skill language/framework keywords matching file extensions in the diff (`.rs` → Rust skills; `.go` and `.ts` already covered by built-ins above unless the user asks to layer an external skill on top)

When both a built-in template and an external skill apply, default to the built-in unless the user opts in to layering. Layering means spawning the external skill *in addition* — never silently replace the built-in template.

Present discovered specialists to the user:

> Found relevant specialist reviewers for this review:
> - `go-specialist` (built-in template) — Go idiom, error wrapping, context, concurrency
> - `typescript-specialist` (built-in template) — type safety, async correctness, tsconfig/package hygiene
> - `extension` (project skill) — Rust/pgrx Postgres extension conventions
> - `rust-pro` (user skill) — Rust 1.75+ patterns and best practices
>
> Include specialist reviewers? [Yes / No / Select specific ones]

**Checkpoint A:** wait for the user's answer before moving to Step 3. Do not spawn anything yet.

### 3. Present Review Plan → **Checkpoint B: plan approval**

Show the user the planned team composition before spawning:

> **Review plan for `feat/pgbackrest-backup-trigger`** (3 changed directories)
>
> | Reviewer | Template | Scope |
> |----------|----------|-------|
> | correctness | correctness.md | All changed files |
> | spec-compliance | spec-compliance.md | All changed files + docs |
> | conductor-conventions | conventions.md | services/payments-service/ |
> | tm-conventions | conventions.md | services/tenant-manager/ |
> | contracts | contracts.md | Cross-service boundaries |
> | rust-specialist | rust-pro skill | services/payments-service/ (if Rust) |
>
> Proceed? [Yes / Adjust]

**Checkpoint B:** this is the only gate between plan and spawn. Never call `TeamCreate` until the user confirms (see Anti-Patterns).

### 4. Spawn Team

**Before calling `TeamCreate`, ask yourself:**

- **Does any reviewer in this plan spawn findings that another reviewer would subsume?** If correctness and a language-specialist would both file the same null-safety finding, drop the narrower one or scope them explicitly.
- **Is each conventions reviewer pointed at exactly one directory?** Cross-directory conventions reviewers produce contradictory CI results (see Anti-Patterns).
- **Is the contracts reviewer earning its spawn?** If the diff only touches one directory, do not spawn it — no cross-service surface to review.
- **Do specialist prompts name the exact `Skill({...})` call to invoke?** Vague instructions ("use rust-pro") skip the skill.

Only after these answers are clean, create the team and spawn each reviewer as a teammate. Exact call shapes:

```
TeamCreate({ team_name: "review-<branch-slug>" })
```

```
Agent({
  description: "<reviewer-name> review",
  subagent_type: "general-purpose",
  team_name: "review-<branch-slug>",
  name: "<reviewer-name>",        // e.g. "correctness", "conductor-conventions"
  prompt: <template contents + scoped diff + AGENTS.md if applicable>
})
```

**Templates — MANDATORY to load the matching one before spawning each reviewer.** Each template defines the reviewer's focus, evaluation criteria, and output format. Do NOT load templates that do not correspond to a spawned reviewer. This table is the single source of truth for team composition:

| Template | Reviewer(s) spawned | One-line purpose | Load when |
|----------|---------------------|------------------|-----------|
| `templates/correctness.md` | `correctness` — 1 instance, full diff | Logic bugs, off-by-one, nil/null, race conditions, incorrect error handling | Always |
| `templates/conventions.md` | `<dir>-conventions` — one per changed directory | Repo-local style and `AGENTS.md` conformance; runs CI | Always, one per changed directory |
| `templates/spec-compliance.md` | `spec-compliance` — 1 instance, full diff + docs | Are requirements met; do docs match behavior | Always |
| `templates/contracts.md` | `contracts` — 1 instance, cross-service surface | Cross-service boundaries, API shape, schema compat | Only when ≥2 directories change |
| `templates/go-specialist.md` | `go-specialist` — 1 instance, full diff | Go idiom, error wrapping, context propagation, goroutine/defer/slice hazards | When the diff touches `.go`/`go.mod`/`go.sum` and the user opted in at Checkpoint A |
| `templates/typescript-specialist.md` | `typescript-specialist` — 1 instance, full diff | Type safety, narrowing, async correctness, tsconfig/package hygiene | When the diff touches `.ts`/`.tsx`/`.mts`/`.cts`/`tsconfig*.json`/`package.json` and the user opted in at Checkpoint A |
| _(n/a — invokes an external specialist skill)_ | `<lang>-specialist` — 1 per applicable external specialist | Language/framework-specific review via an external skill (e.g. `rust-pro`) when no built-in template covers it, or when the user explicitly layers it on top of a built-in | Only when an external specialist is selected at Checkpoint A |

Each reviewer prompt must include:
- The full contents of its template (from `templates/`) — do not paraphrase.
- The git diff scoped to its directory (or the full diff for cross-cutting reviewers).
- The repo's `AGENTS.md` if it exists — required for conventions reviewers.
- CI commands extracted from `AGENTS.md` — conventions reviewers must run them.
- For **built-in specialist** reviewers (`go-specialist`, `typescript-specialist`): the full contents of the matching template from `templates/` — same loading rule as the other reviewers above. No external skill invocation needed.
- For **external specialist** reviewers: an instruction to invoke the relevant Skill at the start of review. Spell out the exact invocation in the prompt — e.g. "Before reviewing, invoke the `rust-pro` skill via `Skill({ skill: 'rust-pro' })` and follow its guidance when grading Rust files." If the teammate's agent type does not have the `Skill` tool, fall back to loading the specialist's SKILL.md body into the prompt at spawn time (see Failure Modes).

**Teammates, not isolated agents.** Reviewers can message each other via `SendMessage({ to: "<reviewer-name>", content: "..." })` and the lead can `broadcast` to all of them in Step 6.

Cleanup at Step 8 uses:

```
SendMessage({ to: "<reviewer-name>", type: "shutdown_request" })   // for each teammate
TeamDelete({ team_name: "review-<branch-slug>" })                  // after all shutdowns complete
```

Order matters: shut down teammates *before* `TeamDelete` (see Anti-Patterns).

### 5. Parallel Review Round

All reviewers work simultaneously. Each produces findings in the structured output format defined in their template.

When a reviewer discovers something outside their focus area, they should `SendMessage` the relevant reviewer rather than reporting it themselves. Examples:
- Correctness reviewer finds a convention violation → message the conventions reviewer
- Conventions reviewer spots a contract mismatch → message the contracts reviewer

### 6. Cross-Review Summary

After all reviewers report, the lead:
1. Collects all findings
2. Shares a summary with all reviewers via `broadcast`
3. Asks reviewers to amend, withdraw, or escalate findings based on what others found

This refinement round catches:
- Duplicate findings across reviewers
- Findings that are invalid given another reviewer's context
- Issues that become more severe when combined with other findings

### 7. Present Unified Verdict

**The lead composes this section**, not a teammate. Two distinct formats are in play — do not confuse them: each reviewer produces output in the per-reviewer skeleton (`templates/output-format.md`) plus any template-specific additions; the lead then **aggregates** those into the unified verdict below. Aggregation rules: promote any reviewer's `Verdict` that is "Not ready" to the overall verdict; collect all Critical / Important / Minor issues across reviewers; fold the conventions reviewers' CI Results into a single list; pull Spec Compliance from the spec-compliance reviewer's checklist.

```markdown
## Agent Team Code Review — [branch name]

### Overall Verdict: Ready to merge / With fixes / Not ready

### Summary
[2-3 sentence overview of the review]

### CI Results
- format:check: PASS/FAIL
- lint:check: PASS/FAIL
- test: PASS/FAIL

### Critical Issues
[Must fix before merge]

### Important Issues
[Should fix, but not blocking]

### Minor Issues
[Nice to have]

### Spec Compliance
[Requirements checklist with status]

### Strengths
[Positive observations across reviewers]

<!-- wrily-review-handoff
review_type: full
rounds: 1
unresolved_critical: [count of Critical Issues, post-cross-review]
unresolved_important: [count of Important Issues, post-cross-review]
unresolved_minor: [count of Minor Issues, post-cross-review]
simplification_applied: false
-->
```

### Handoff block

The trailing `<!-- wrily-review-handoff -->` HTML comment is the canonical handoff to the `confidence-rating` skill. The lead emits it as part of composing the unified verdict in this step — not the per-reviewer outputs. Rules:

- `review_type`: `full` unless the user invoked the host loop in delta mode (in which case the host loop sets it; this skill always emits `full` for its own invocations).
- `rounds`: always `1`. The internal cross-review refinement step (Step 6) is *not* a separate host-loop round — it is a single team-review pass. Multi-round bookkeeping across pushes is the host loop's job.
- `unresolved_*`: counts of the *converged* findings after Step 6 (post-cross-review), not the pre-refinement raw counts. If a finding was withdrawn during cross-review, it does not count.
- `simplification_applied`: `false`. (Reserved for future review modes.)

If a CI step is FAIL, count it as a Critical finding in `unresolved_critical` even if it doesn't appear under `### Critical Issues` — the verdict is "Not ready" in that state and the downstream skill needs to see it.

Emit the block exactly once at the very end of the verdict body, after `### Strengths`. Do not summarise it in prose.

### 8. Cleanup

Apply the shutdown + delete shapes from Step 4: `SendMessage({ type: "shutdown_request" })` to each reviewer in turn, wait for each to acknowledge, then `TeamDelete`. Never `TeamDelete` while teammates are still alive.

## Failure Modes

| Failure | Signal | Action |
|---------|--------|--------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset | `TeamCreate` errors or is unavailable | Stop at Step 1, show the settings snippet from Prerequisites, wait for user confirmation before retrying |
| User-supplied base branch doesn't exist | `git diff` errors "unknown revision" | Tell the user, list the local branches via `git branch -a`, ask them to pick one |
| Diff is empty | `git diff --stat` returns no files | Stop — nothing to review; confirm with user that the correct base was used |
| Diff contains only binary / generated files | Diff includes `.lock`, minified bundles, vendored code | Exclude from reviewer scope via path filters; note exclusion in the Review Plan at Step 3 |
| Repo has no `AGENTS.md` | File missing when conventions reviewer tries to load it | Downgrade conventions reviewer to "style conventions from source inspection"; flag as Minor in final verdict ("no AGENTS.md — conventions confidence reduced") |
| CI command missing a toolchain | Conventions reviewer's CI step errors with "command not found" | File as **Critical** finding (cannot verify repo invariants) and continue; do NOT substitute static analysis silently (see Anti-Patterns) |
| `TeamCreate` fails | Error response from the tool | Abort before spawning teammates; surface the error and ask user whether to retry or fall back to serial review |
| A teammate fails to respond within the review round | No message back after the round's timeout | `SendMessage` once with a reminder; if still silent, mark that focus area as "unreported" in the final verdict rather than hanging |
| Specialist Skill not invocable from inside a teammate | `Skill` tool unavailable in the teammate context | Load the specialist's reference content into the reviewer's prompt at spawn time as a fallback (see Step 8 on Skill invocation) |
| User interrupts mid-review | Input received during Step 5 or Step 6 | Pause immediately, then run Step 8 Cleanup before acting on the new input — never leave teammates alive |

## Output Format (Per Reviewer)

Skeleton (see `templates/output-format.md` for the authoritative version; every reviewer prompt must include that file verbatim):

```markdown
## [Reviewer Name] — [Focus Area]
### Verdict: Ready to merge / With fixes / Not ready
### CI Results (conventions reviewers only)
### Issues
#### Critical / Important / Minor
  - `file:line` — Description. **Why it matters:** ...
### Strengths
### Notes for Other Reviewers
```

Reviewer-specific additions (Spec Source, Requirements Checklist, Cross-Service Boundaries, Breaking Change Assessment) are defined in the per-reviewer templates — not here. Deviating from this structure breaks the lead's cross-review summary in Step 6.

## Anti-Patterns

**NEVER skip `shutdown_request` before `TeamDelete`.** Orphan teammates continue to consume tokens against the parent context until the harness reaps them. Always shut down each teammate first, then delete the team.

**NEVER spawn more than one conventions reviewer per repo directory.** Duplicate CI runs waste tokens and produce contradictory PASS/FAIL when tests are flaky. One owner per directory, always.

**NEVER let reviewers report cross-lane findings themselves.** A correctness reviewer that writes up a convention violation pollutes the conventions reviewer's output and invites duplicate findings in the cross-review round. `SendMessage` the owning reviewer instead.

**NEVER skip CI in conventions reviews.** Static inspection misses ordering-dependent lint rules and generated-file drift. If CI cannot run (missing toolchain, offline), flag it as a Critical finding — do not silently substitute static review.

**NEVER spawn the team before the user approves the plan at Checkpoint B (Step 3).** Plan approval is the only checkpoint where the user can remove an expensive specialist or a misrouted conventions reviewer before tokens are spent.

**NEVER rename or paraphrase reviewer names across the flow.** The lead uses reviewer names as routing addresses for `SendMessage` and `broadcast`; a renamed reviewer is an unreachable reviewer.

**NEVER silently re-spawn a non-responding teammate.** A new teammate starts with empty context; re-spawning it won't recover the half-written review, just charge twice for the same focus area. If a teammate goes silent after a `SendMessage` reminder, mark that focus area as "unreported" in the final verdict (see Failure Modes) and continue.

## Reviewer Rules

Thinking frameworks — ask these before filing any finding:

1. **Before filing Critical, ask: would another lane reach the same conclusion independently?**
   If yes, this is cross-cutting — `SendMessage` the owning reviewer first so we file it once, not twice. Critical findings the team disagrees on erode the user's trust in the verdict.

2. **Before categorizing severity, ask: what breaks if this ships as-is?**
   Production breakage or data loss = Critical. Team velocity cost or future-rework = Important. Taste or style = Minor. "I'd have done it differently" is not a severity — it's a comment, and usually doesn't belong in the report.

3. **Before writing a finding, ask: what's the single line of code or config that proves it?**
   If you can't point to `file:line`, the finding is a hypothesis, not an observation. Hypotheses go to `Notes for Other Reviewers`, not `Issues`.

4. **Before filing a strength, ask: is this non-obvious?**
   "Code is well-structured" is filler. "Introduces `UnitOfWork` to cap the transaction at one repo write" is a strength — it names the decision and the payoff. If you can't name both, drop it.

Domain rules:

5. **Stay in your lane.** Flag cross-cutting concerns via `SendMessage` to the owning reviewer, not in your own report.
6. **Run CI.** Conventions reviewers must execute the CI commands from `AGENTS.md` and report actual output. Static analysis alone is insufficient and files a Critical finding if CI cannot run (see Anti-Patterns).
7. **Read AGENTS.md first.** Conventions reviewers must read the repo's `AGENTS.md` before reviewing — otherwise the bar is guesswork.
8. **Give a clear verdict.** "Ready to merge", "With fixes" (list them), or "Not ready" (explain why). Ambiguous verdicts force the lead to guess.
