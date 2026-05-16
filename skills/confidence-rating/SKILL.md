---
name: confidence-rating
description: Compute a 0 to 100 percent merge-confidence score for a PR after a code review converges, combining application criticality, change complexity, and review-convergence quality. Use after `code-review`, `agent-team-review`, or any review loop completes — to attach a single number plus a per-dimension breakdown to the PR description so reviewers know how much human attention the change warrants. Output is a percentage band (skim / quick / thorough / deep / pair-review), not a 1-to-5 score.
metadata:
  version: "2026.4.29"
---

# Confidence Rating

Computes a single 0–100% merge-confidence score for a finished review and renders it as a Markdown block ready to paste into a PR description. Inputs are the three dimensions defined below; the output is a weighted percentage plus a banded recommendation.

## When to invoke

Run this skill **after** a review process has converged (the `code-review`, `agent-team-review`, or any equivalent loop has finished and findings are categorised). Do not run it before reviewers have produced findings — convergence quality is the heaviest dimension and unreliable until the loop completes.

**Both `code-review` and `agent-team-review` emit a canonical handoff block** (see `## Handoff schema` below) at the end of their review body. When that block is present, parse it for the convergence inputs (rounds, unresolved severity counts, simplification flag) instead of asking the user. If the block is absent, fall back to manual collection.

**Escape hatch — score already in hand.** If the user invokes this skill with a score they have *already computed* (e.g. they're regenerating the PR-description block, or porting an old review's number), skip the formula and the upstream-handoff parsing. The minimum supplied payload to render output is:

- `score` (0–100, integer),
- the three per-dimension scores (`criticality_score`, `complexity_score`, `convergence_score`, each 0–100),
- the five complexity factor levels (Lines / Files / Layers / Tests / Sensitive — each Low / Medium / High),
- the criticality tier (1–4) and label.

These are the bracketed values needed by the mandatory floor of the **Output format** (Confidence header + Score breakdown). If any are missing, refuse and ask the user to either supply the full structured payload or run the formula instead. Optional fields (Review Rounds, Remaining items, Key Areas to Focus On, Simplification Applied) render only when their data is supplied; do not invent them.

## Before you score — three questions to hold

The formula is the contract, but the formula is only as honest as its inputs. Before opening the rubric, hold these three questions in mind so the score reflects judgement, not just arithmetic:

1. **What's the worst-case if this PR ships unread?** Calibrates how punitive the score should feel. A revert-able typo in docs and an auth-flow change that compiles both produce numbers — only one warrants the deep-review band.
2. **Was the loop limited by the time budget or by the change actually being clean?** A "Round 1, no findings" can mean *converged immediately* or *the reviewer ran out of attention*. Treat the latter as if Round 1 had unresolved Important findings.
3. **Does the score I'm about to render agree with my gut?** The numbers are the contract — but a gut mismatch is the cheapest signal that an input was misclassified. If the score lands in "Skim" but you wouldn't merge this without reading it, one of the dimension inputs is wrong; re-examine before reporting.

## Inputs you must collect before scoring

If any of the four input groups is missing, ask the user once to supply it, then proceed. Do not guess.

1. **Application criticality tier** (1–4). Tier 1 = critical (data plane, auth, encryption, wire protocol). Tier 2 = important (control plane, orchestration). Tier 3 = supporting (observability, admin tooling). Tier 4 = development (local-only, docs). Source: project `CLAUDE.md` / `AGENTS.md` if it declares a tier, otherwise ask the user.
2. **Change complexity factors** (5 sub-factors, each Low / Medium / High). Compute these from the diff — neither upstream review skill emits them, because they are deterministic from the diff itself:
    - Lines changed: Low `<50`, Medium `50–300`, High `>300`. Use `git diff --shortstat origin/<base>...HEAD`.
    - Files touched: Low `1–3`, Medium `4–10`, High `>10`.
    - Layers crossed: Low `single layer`, Medium `2 layers`, High `3+ layers`. A "layer" is e.g. transport/protocol/upstream/storage; the `proxy/` package is one layer, `api/` another, `protocol/` another. **Rule of thumb when unsure:** count distinct top-level packages or directories the diff touches (or the number of CI jobs the change makes re-run); cap at "3+ layers" for High.
    - Test coverage: Low `tests included & passing`, Medium `tests exist but incomplete (e.g. happy path only)`, High `no tests for changed code`. **Scope:** unit/integration tests in the diff, NOT whether the branch was deployed/tested in a dev environment — that is the developer's responsibility and is explicitly out of scope.
    - Sensitive paths: Low `none`, Medium `config or non-auth infra`, High `auth, encryption, wire protocol, IAM, secret handling`.
3. **Review convergence** — parse from the upstream handoff block (see `## Handoff schema` below) when present. If absent, ask the user once:
    - Number of review rounds it took to converge (1 to N; capped at 5 by the host loop). One host-loop iteration = one round, regardless of internal cross-review steps inside `agent-team-review`.
    - Severity counts of findings remaining at convergence: `unresolved_critical`, `unresolved_important`, `unresolved_minor`.
4. **Project context** (optional but encouraged): the path being reviewed and the PR/branch name, for the rendered output header.

## Handoff schema

`code-review` and `agent-team-review` both append a canonical HTML-comment block to the end of their review body. This is the contract for piping convergence data into this skill without round-tripping through the user.

```html
<!-- wrily-review-handoff
review_type: full
rounds: 1
unresolved_critical: 0
unresolved_important: 2
unresolved_minor: 5
simplification_applied: false
-->
```

| Field | Type | Meaning |
|---|---|---|
| `review_type` | `full` \| `delta` | Whether this was a full PR review or a delta against a prior reviewed commit. |
| `rounds` | integer ≥ 1 | Host-loop iteration index at the moment of this review (1 = first review of the PR; N = N-th review pass). Capped at 5 by the host loop. |
| `unresolved_critical` | integer ≥ 0 | Critical findings still open at the moment the review body is posted. |
| `unresolved_important` | integer ≥ 0 | Important / Recommendation findings still open. `code-review` calls this tier "Recommendation"; map it to `unresolved_important` here. |
| `unresolved_minor` | integer ≥ 0 | Minor findings still open. |
| `simplification_applied` | `true` \| `false` | Whether a simplification round ran; drives the optional `Simplification Applied` section in the rendered output. |

**Parsing rule:** scan all PR review bodies (newest first). The block from the most recent review wins. If multiple blocks are present in one body (malformed), use the *first* — earlier ones reflect the earlier state, but a duplicate is a bug to flag, not silently merge.

**Refuse to score** when `review_type=delta` is claimed but no prior review with a handoff block exists for the PR — the rounds count cannot be trusted in that state.

## Scoring formula

The final score is a weighted average of three dimension scores, each computed on 0–100:

```
score = round( 0.30 × criticality_score
             + 0.30 × complexity_score
             + 0.40 × convergence_score )
```

Weights match the originating spec: criticality 30 %, complexity 30 %, convergence 40 %. Convergence is heaviest because the review loop is the most direct signal of "how much was wrong with this change at the moment of review".

### `criticality_score` (0–100)

Lower-tier (less blast-radius) apps get a higher score because a bad merge has less downside.

| Tier | Label | `criticality_score` |
|------|-------|---------------------|
| 1 | Critical | **30** |
| 2 | Important | **60** |
| 3 | Supporting | **85** |
| 4 | Development | **100** |

### `complexity_score` (0–100)

Each of the 5 complexity factors is scored Low=1, Medium=2, High=3. Sum the 5 factors (range 5–15) and map linearly to 100–0:

```
complexity_score = round( 100 × (15 − sum) / 10 )
```

Examples:
- All Low (sum 5) → 100.
- All Medium (sum 10) → 50.
- All High (sum 15) → 0.
- Mixed (sum 8) → 70. Mixed (sum 12) → 30.

### `convergence_score` (0–100)

Take the worst-applicable row. If multiple apply, pick the lowest score.

| Condition at the moment review converged | `convergence_score` |
|---|---|
| Round 1, no Critical or Important left, ≤2 Minor | **100** |
| Round 1–2, no Critical or Important left | **85** |
| Round 3, no Critical or Important left | **70** |
| Round 4–5, only Minor remaining | **55** |
| Any unresolved Important at end of loop | **35** |
| Any unresolved Critical at end of loop, **OR** loop hit the 5-round cap without converging | **15** |

### Post-formula band clamp

The weighted formula alone lets criticality and complexity swamp a bad convergence score. Example: a Tier 4, all-Low-complexity PR with one unresolved Critical computes `round(30 + 30 + 6) = 66` → "Mixed" band, which understates the risk of merging with a known Critical finding open. The skill is meant to *make that state visible*, not hide it under reassuring arithmetic.

After computing `score`, apply this clamp before mapping to a band:

```
if unresolved_critical > 0:
    score = min(score, 29)
elif unresolved_important > 0:
    score = min(score, 54)
```

The clamp pins the band to "Low" (Pair review) when any Critical is unresolved and to at most "Weak" (Deep review) when any Important is unresolved, regardless of how clean criticality and complexity look. The clamp is **not** a weight re-tune — weights stay 30 / 30 / 40 — it is a band-level fail-closed rule layered on top of the weighted sum.

### Bands and recommended team action

| Score | Band | Team action |
|---|---|---|
| **90–100 %** | High confidence | Skim and merge. |
| **75–89 %** | Solid | Quick review of key changes; merge after a sanity check. |
| **55–74 %** | Mixed | Thorough review recommended; trace the highlighted areas. |
| **30–54 %** | Weak | Deep review required; do not merge solo. |
| **0–29 %** | Low | Pair review or design discussion before merge. |

The band is determined entirely by the rounded `score` after the documented post-formula clamp — no other overrides.

**Read the band as "how much of your day this PR is allowed to consume":**
- Skim and merge → ~30 s eyeball.
- Quick review of key changes → ~5 min, focused on the highlighted areas.
- Thorough review recommended → ~30 min, trace each Critical / Important finding to the diff.
- Deep review required → ~2 h with a fresh head; do not merge solo.
- Pair review or design discussion → blocked on a synchronous session, not an async approval.

If the band's time anchor doesn't match what the reviewer can actually spend, escalate (push back to the author, or split the PR) instead of merging on a softer band.

### Worked examples

**MANDATORY before scoring the user's PR:** silently re-derive both scores below from scratch and confirm they land at 79 (Solid) and 29 (Low) respectively, including the post-formula clamp. If either computation diverges, one of the anchor numbers in this skill has been edited but the example wasn't updated — stop and ask the user to re-confirm the rubric instead of proceeding.

**Example 1 — clean Tier 1 bug-fix (clamp inactive).** A bug-fix on `payments-service` (Tier 1, critical):
- Lines: 42 (Low=1). Files: 2 (Low=1). Layers: 1, only `proxy/throttle.go` (Low=1). Tests: included & passing (Low=1). Sensitive paths: none (Low=1). Sum 5 → `complexity_score = 100`.
- `criticality_score = 30` (Tier 1).
- Convergence: 1 round, only 1 Minor left → `convergence_score = 100`.

`score = round(0.30·30 + 0.30·100 + 0.40·100) = round(9 + 30 + 40) = 79`. No unresolved Critical or Important, so the clamp is inactive. Band: **75–89 %, Solid — quick review of key changes**. Tier 1 holds the score back even with a clean diff; that's the design.

**Example 2 — Tier 4 docs PR with an unresolved Critical (clamp activates).** A docs-only PR on a Tier 4 internal tool, but a reviewer flagged a Critical leak of an internal hostname:
- Lines: 18 (Low=1). Files: 1 (Low=1). Layers: 1 (Low=1). Tests: N/A — docs (Low=1, see Failure modes). Sensitive paths: none (Low=1). Sum 5 → `complexity_score = 100`.
- `criticality_score = 100` (Tier 4).
- Convergence: 1 round, 1 unresolved Critical → `convergence_score = 15`.

`score = round(0.30·100 + 0.30·100 + 0.40·15) = round(30 + 30 + 6) = 66`. Pre-clamp band would be "Mixed". Clamp triggers (`unresolved_critical > 0`): `score = min(66, 29) = 29`. Band: **0–29 %, Low — pair review or design discussion before merge**. The clamp is the point: the unresolved Critical is the merge-blocker, not the docs-y context.

## Output format

The output has a **mandatory floor** (always rendered) and **conditional sections** (rendered only when their backing data is present). Do not paraphrase or rename headings on the sections that do render — downstream tooling looks for these exact anchors. Do not synthesise placeholder content for a conditional section just because the template would otherwise feel incomplete: an absent section means absent data, and inventing it is worse than omitting it.

### Mandatory floor

Always render these two blocks. Anti-pattern #4 forbids reporting the score without the per-dimension breakdown, so the breakdown is part of the floor — not optional.

```markdown
## Automated Review Summary

**Confidence: [score] %** ([band label]) | Criticality: Tier [N] ([label]) | Complexity: [Low/Mixed-Low/Mixed/Mixed-High/High] | Convergence: [Round count, e.g. "Round 1, clean"]

### Score breakdown
- Criticality: [criticality_score] / 100 (weight 30 %)
- Complexity: [complexity_score] / 100 (weight 30 %) — factors: Lines [L/M/H], Files [L/M/H], Layers [L/M/H], Tests [L/M/H], Sensitive [L/M/H]
- Convergence: [convergence_score] / 100 (weight 40 %)
```

### Conditional sections

Render each only if the listed input is supplied (from the handoff block, manual collection, or the escape-hatch payload). If the input is absent, omit the heading entirely — do not render an empty section.

| Section | Render when | Source |
|---|---|---|
| `### Review Rounds` | Round-by-round history is supplied (≥1 round entry with severity counts). | Upstream review skills' multi-round history (delta reviews stitched across host-loop iterations) or manual collection. |
| `### Remaining items` | At least one unresolved finding has a known `file:line`. | Handoff block `unresolved_*` counts > 0 *and* findings list is parseable from the upstream review body. |
| `### Key Areas to Focus On` | Reviewer flagged specific areas worth a closer look. | Manual / structured supplied content; do not auto-generate from severity counts alone. |
| `### Simplification Applied` | `simplification_applied: true` in the handoff block. | Handoff block. |

Conditional templates (only render the matching block when its input is present):

```markdown
### Review Rounds
- **Round N**: M findings ([critical / important / minor breakdown]) → [fixed | accepted | open]
```

```markdown
### Remaining items
- [ ] [item — severity — file:line]
```

```markdown
### Key Areas to Focus On
- **[Area name]** (`path/to/file.ts:L10-L45`, `other/file.go:L88`) — what to check and why.
```

```markdown
### Simplification Applied
- [description]
```

The "Complexity" qualitative label (Low/Mixed-Low/Mixed/Mixed-High/High) is derived from the factor sum:
- 5 → Low. 6–7 → Mixed-Low. 8–11 → Mixed. 12–13 → Mixed-High. 14–15 → High.

## Anti-patterns

- **NEVER add a "branch tested on dev environment" factor.** That is the developer's responsibility, deliberately out of scope, and would conflate two different signals (review confidence vs. ops readiness).
- **NEVER round individual dimension scores before the weighted sum.** Round only the final `score`. Pre-rounding accumulates >2 % drift across realistic inputs.
- **NEVER bump the score above the band cap because the change "feels safe".** The numbers are the contract. If a Tier 1 diff scores 79 % the band is "Solid — quick review", not "Skim and merge". The whole point is to make confidence legible, not negotiable.
- **NEVER report the score without the per-dimension breakdown.** A bare percentage hides which dimension dragged it down and prevents the reviewer from prioritising.
- **NEVER substitute a default for a missing input.** If the user can't tell you the criticality tier or test coverage, ask once. If they still can't, abort with a clear message — half-real inputs produce confidently-wrong scores.
- **NEVER re-tune the dimension weights per repo or per PR.** The 30 / 30 / 40 split between criticality, complexity, and convergence is the contract. Reweighting per project (e.g. "this repo is mostly docs, drop criticality to 10 %") hides exactly the projects that should worry the reviewer most, and makes scores incomparable across PRs. If a project genuinely needs different weights, that's a fork-the-skill conversation, not a per-invocation tweak.
- **NEVER skip the post-formula band clamp when an unresolved Critical or Important is present.** The weighted formula alone lets criticality and complexity swamp a bad convergence score, producing reassuring "Mixed" or even "Solid" bands while a Critical sits open. The clamp is fail-closed and runs *after* the weighted sum; do not "round up" past it on the basis that the diff feels small or the change is in a docs-y area.
- **NEVER fabricate a conditional section to fill the template.** If `Review Rounds`, `Remaining items`, `Key Areas to Focus On`, or `Simplification Applied` has no backing data, omit the heading entirely. Manufactured rounds or invented focus areas erode the contract: downstream tooling and human readers both stop trusting any section once one of them is hallucinated.

## Failure modes

| Failure | Action |
|---|---|
| User can't supply criticality tier | Ask once, citing the four-tier definition above. If still unknown, refuse to score and tell the user to check `CLAUDE.md` or `AGENTS.md` for the project's tier classification. |
| Review loop hasn't converged yet | Refuse to score. Tell the user to finish the review loop first — convergence is the heaviest dimension and the only one that requires the loop to be done. |
| Review loop stopped at the 5-round cap with unresolved Important or Critical findings | Score it (`convergence_score = 15`). The point of the rating is to make this state visible, not hide it. |
| Diff is empty (branch already merged) | Refuse to score. There's no change to rate. |
| One complexity factor is genuinely indeterminate (e.g. "test coverage" for a docs-only PR) | Treat it as Low for that factor and note the substitution in the breakdown ("Tests: N/A — docs-only diff"). |
