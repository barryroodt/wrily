# Reviewer Output Format

All reviewers in the agent-team-review workflow must produce findings in this exact structure. Deviating breaks the lead's cross-review summary in Step 6.

```markdown
## [Reviewer Name] — [Focus Area]

### Verdict: Ready to merge / With fixes / Not ready

### CI Results (conventions reviewers only)
- command: PASS/FAIL (include output on failure)

### Issues

#### Critical
- `file:line` — Description. **Why it matters:** explanation.

#### Important
- `file:line` — Description. **Why it matters:** explanation.

#### Minor
- `file:line` — Description.

### Strengths
- Specific positive observations with file references.

### Notes for Other Reviewers
- [Any cross-cutting concerns flagged to specific reviewers]
```

## Rules

- Every Critical and Important issue must include `file:line` and a **Why it matters** sentence. No vague findings.
- `CI Results` is mandatory for conventions reviewers and omitted by everyone else.
- `Notes for Other Reviewers` is the only place to record cross-lane observations — do not file them as your own Issues.
- `Verdict` is one of the three exact strings; ambiguity forces the lead to guess.
