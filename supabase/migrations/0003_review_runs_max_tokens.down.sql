-- Rollback for 0003_review_runs_max_tokens.sql: restore the USD budget column.
alter table review_runs alter column max_tokens type numeric(10,4) using max_tokens::numeric(10,4);
alter table review_runs rename column max_tokens to max_budget_usd;
