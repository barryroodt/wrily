-- Re-key the per-review budget ceiling from a USD amount to a token count.
-- After the gantry cutover budgets are tokens end-to-end (Decision 3); USD is
-- computed only at persist/report time from src/agent/models.ts, so cost_usd
-- stays untouched. Paired down-migration: 0003_review_runs_max_tokens.down.sql.
alter table review_runs rename column max_budget_usd to max_tokens;
alter table review_runs alter column max_tokens type bigint using round(max_tokens)::bigint;
