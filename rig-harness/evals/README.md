# wrily-rig evals

## Fixtures

- 001-sql-injection — security finding required
- 002-delta-clean — no findings expected
- 003-team-mode-multi-dir — multi-directory team review
- 004-budget-trip — token cap hit

## Baseline drift policy

- tokens: ±15%
- duration: ±25%

When baseline value is 0, drift check skipped (treated as needs-bootstrap).

## Update flow

1. Run `cargo run --bin wrily-rig-evals` in real env (live API keys).
2. Inspect `baseline.json.new` written alongside.
3. If drifts intentional, replace `baseline.json` with new file + commit `chore(evals): bump baseline for <reason>`.
