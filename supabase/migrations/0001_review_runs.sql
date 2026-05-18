create table review_runs (
  id              uuid primary key default gen_random_uuid(),
  inserted_at     timestamptz not null default now(),

  github_repo     text not null,
  pr_number       int  not null,
  commit_sha      text not null,
  trigger_source  text not null check (trigger_source in ('github_app','local_cli')),
  review_round    int  not null default 0,

  model           text not null,
  review_mode     text not null check (review_mode in ('single','team')),
  scope           text not null check (scope in ('full','delta')),
  max_budget_usd  numeric(10,4),

  status          text not null check (status in ('success','budget_exceeded','timeout','failed')),
  duration_ms     int  not null,
  findings_posted int,

  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  cost_usd            numeric(10,6) not null default 0
);

create index review_runs_repo_inserted on review_runs (github_repo, inserted_at desc);
create index review_runs_inserted      on review_runs (inserted_at desc);

create table review_subagent_runs (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references review_runs(id) on delete cascade,
  inserted_at  timestamptz not null default now(),

  role         text not null,
  model        text not null,
  duration_ms  int not null,

  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  cost_usd            numeric(10,6) not null default 0
);

create index review_subagent_runs_run on review_subagent_runs (run_id);
