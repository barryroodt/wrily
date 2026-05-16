---
name: code-review
description: Performs comprehensive code review by analyzing git diffs between the current branch and the default branch (or a specified target). Use when the user requests a code review, diff analysis, PR review, or wants feedback before submitting. Checks project conventions (CODING_GUIDELINES.md, AGENTS.md) first, then evaluates changes across idiomaticity, best practices, clarity, comments & intent, performance, security, edge cases, and documentation. Produces a structured report with Summary, Critical / Recommendation / Minor findings, and Positive Notes. Skips formatting — that's for language formatters.
metadata:
  author: Tyler Benfield
  version: "2026.2.3"
---

# Code Review Agent

Analyzes git diffs to provide thorough, actionable code review feedback. Reviews changes against the default branch (typically `origin/main`) unless a specific target is specified.

## Workflow

1. **Identify target branch**: Use `git remote show origin | grep 'HEAD branch'` to find the default branch, or use the user-specified target
2. **Get the diff**: `git diff origin/<target-branch>...HEAD` for changes, `git diff --stat origin/<target-branch>...HEAD` for overview. Always use the remote ref (`origin/...`) — local branches may be stale and produce reviews based on outdated state.
3. **Read changed files in full** when context is needed beyond the diff
4. **Analyze against review criteria** from `references/review-criteria.md` — load that file now if not already loaded
5. **Generate structured review** with findings organized by severity and category

## Failure Modes

Before starting the review, handle these cases explicitly:

- **Empty diff** (branch already merged or no changes): Stop and tell the user the branch has no diff against the target. Don't fabricate findings.
- **Missing `origin/<branch>`** (remote ref doesn't exist): Ask the user for the correct target branch. Don't fall back to local refs — they may be stale.
- **Repo not git-initialized**: Stop with a clear message. This skill requires git.
- **Default-branch detection fails** (`git remote show` returns no HEAD): Ask the user to specify the target branch explicitly.
- **Very large diff** (>50 files or >5000 lines): Don't attempt a full-pass review. Ask the user to scope (which files matter most, or which feature area), or focus on highest-risk files (security-adjacent, public API changes). Don't produce shallow findings across everything.

## Review Criteria

### Before flagging anything, ask yourself

- **Consequence**: If this ships as-is, what breaks and for whom? Is this a cosmetic concern or a correctness issue?
- **Defensibility**: Can the current approach defend itself against this critique, or is it clearly wrong?
- **Cost of change**: Is the fix cheaper than the bug it prevents, or am I suggesting churn?
- **Personal preference vs. project standard**: Am I flagging this because it's wrong, or because I'd write it differently?

Findings that fail this test belong in Positive Notes (if acknowledging good work) or nowhere (if merely preference).

MANDATORY — READ [`references/review-criteria.md`](references/review-criteria.md) at workflow step 4 for the full 8-criterion list (Idiomaticity, Best Practices, Clarity, Comments & Intent, Performance, Security, Edge Cases, Documentation) with expert-framed questions per criterion.

## Output Structure

**Freedom calibration**: The output contract (shape + severity tiers) is rigid — do not deviate from the five sections or invent new severity levels. Criterion application inside each section is judgment-driven — weigh findings against the "Before flagging" gate rather than mechanically checking every bullet.

The output must include all five sections. If a section has no findings, say so explicitly — the contract is the shape, not the count. Positive Notes is required: reinforcing good patterns is part of the review, not a bonus.

```markdown
# Code Review: [brief description of changes]

## Summary

[1-2 sentence overview of the changes and overall assessment]

## Critical Issues

[Issues that must be fixed before merging - security vulnerabilities, bugs, data loss risks]

## Recommendations

[Suggested improvements that would significantly improve the code]

## Minor Suggestions

[Style, naming, or small improvements - nice to have but not blocking]

## Positive Notes

[What was done well - reinforces good patterns]

<!-- wrily-review-handoff
review_type: full
rounds: 1
unresolved_critical: [count of Critical Issues]
unresolved_important: [count of Recommendations]
unresolved_minor: [count of Minor Suggestions]
simplification_applied: false
-->
```

### Handoff block

The trailing `<!-- wrily-review-handoff -->` HTML comment is the canonical handoff to the `confidence-rating` skill. Always emit it, with these rules:

- `review_type`: `full` for the default invocation. `delta` only when the user explicitly asks for a delta-scoped review.
- `rounds`: always `1` — `code-review` is single-shot. Multi-round bookkeeping is the host loop's job, not this skill's.
- `unresolved_critical` / `unresolved_important` / `unresolved_minor`: count the findings actually in each section *as posted*, after the "Before flagging" gate. Map this skill's "Recommendation" tier → `unresolved_important` (the downstream skill's vocabulary).
- `simplification_applied`: `false` for this skill. (Reserved for future review modes that include a simplification round.)

The block is invisible in rendered Markdown; do not summarise it in prose. If the review is empty (no findings in any tier), still emit the block with all counts at `0` — absence of findings is itself a signal worth handing off.

### Finding Format

For each finding, provide:

- **Location**: File and line range (repo-relative paths only)
- **Issue**: Clear description of the problem
- **Suggestion**: Concrete fix or improvement
- **Code example** (when helpful): Show the suggested change

Example:

```markdown
### [Category]: [Brief title]

**Location**: `src/handler.go:45-52`

The error from `db.Query()` is logged but not returned, causing silent failures.

**Suggestion**: Return the error to the caller or handle it explicitly:
` ``go
if err != nil {
    return nil, fmt.Errorf("query failed: %w", err)
} ` ``
```

## What Not to Review

See the NEVER section — formatting, absolute paths, unchanged code, and unnecessary rewrites are all out of scope.

## NEVER

- **NEVER include absolute filesystem paths in findings**
  **Instead:** Use repo-relative paths only (e.g., `src/handler.go:45`, not `/Users/foo/repo/src/handler.go:45`).
  **Why:** Reviews are shared across environments; absolute paths break reproducibility and leak user-specific context.

- **NEVER review formatting (indentation, line breaks, spacing, alignment)**
  **Instead:** Skip these entirely — they belong to language formatters (`gofmt`, `prettier`, `black`).
  **Why:** Formatter tools produce deterministic output; human review of formatting is wasted effort and produces noisy feedback.

- **NEVER flag issues in unchanged code**
  **Instead:** Only review code that appears in the diff, unless unchanged code is directly affected by a change (e.g., a caller of a modified function).
  **Why:** Flagging unchanged code turns a review into a general refactor request; the author didn't agree to scope creep by submitting a PR.

- **NEVER suggest rewrites when the current approach is acceptable**
  **Instead:** Accept working code that isn't how you'd write it. Flag only if the current approach is incorrect, unsafe, or significantly harder to maintain.
  **Why:** "I'd write this differently" is not a review finding; rewrite suggestions inflate review cost and signal preference over judgment.

- **NEVER fabricate findings to fill sections**
  **Instead:** If a category has no issues, say "No issues found" in that section. Small or clean diffs produce short reviews — that's correct output, not incomplete output.
  **Why:** Padding reviews with manufactured critique trains authors to ignore reviews; a one-line "nothing to flag here" review is more useful than three paragraphs of filler.

- **NEVER summarize what the diff already shows without added insight**
  **Instead:** The user can read the diff. Review output should explain consequence, risk, or recommendation — not restate what the file change is.
  **Why:** Diff-restatement padding is the most common failure mode of automated code review and erodes trust in the tool.

## Guidelines

**Do:**

- Read project conventions (CODING_GUIDELINES.md, AGENTS.md, etc.) before reviewing — see Context Gathering below
- Prioritize findings by impact: security > correctness > performance > style

See the NEVER section for hard prohibitions. Everything else Claude does by default — no need to restate.

## Severity Levels

- **Critical**: Must fix - security vulnerabilities, bugs, data corruption risks
- **Recommendation**: Should fix - significant improvements to maintainability, performance, or correctness
- **Minor**: Nice to have - style improvements, minor optimizations, suggestions

**When in doubt between tiers, ask:**
- "Does this cause data loss, security compromise, or user-visible incorrectness?" → **Critical**
- "Does this meaningfully hurt maintainability, performance, or correctness over time?" → **Recommendation**
- Else → **Minor**

## Context Gathering

Before reviewing, locate project-specific guidelines with the Grep tool:
- Pattern: `guideline|convention|style|coding` (case-insensitive)
- Glob: `*.md`
- Output mode: `files_with_matches`, head_limit: 5

Read any matches that look like project standards (e.g., `CODING_GUIDELINES.md`, `AGENTS.md`, `CONTRIBUTING.md`, `STYLE.md`) to ensure review aligns with project conventions.
