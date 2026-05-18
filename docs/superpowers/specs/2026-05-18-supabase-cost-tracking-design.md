# Supabase Cost Tracking — Design

**Date:** 2026-05-18
**Status:** Draft (pending implementation plan)
**Branch:** `feat/supabase-cost-tracking`

## Goal

Persist per-review-run cost data (token usage + USD) to a Supabase project so
operators of a self-hosted Wrily fork can answer:

- How much have we spent across all PR reviews in the last 30 days?
- Which repos / models / review modes drive the spend?
- For team-mode runs, which subagent role (correctness, conventions, …)
  burns the most budget?

Closes the "no dashboard for Anthropic spend" gap recorded in
[`docs/followups.md`](../../followups.md#operational-gaps).

## Non-goals (v1)

- Persisting review *findings*, dispute history, or any non-cost data.
- Per-finding cost attribution.
- Multi-tenant / hosted collector. Each Wrily fork owns one Supabase project.
- Row-level security (no end-user reads; service-role only).
- Realtime dashboards, alerting, budget-breach notifications.

## Architecture

```
┌──────────────┐                ┌──────────────┐
│ Review job   │── insert ────▶ │ Supabase     │
│ (container)  │                │ (PostgREST)  │
└──────────────┘                │  + Postgres  │
                                └──────▲───────┘
┌──────────────┐                       │
│ ./wrily costs│── select ─────────────┘
│ (CLI, local) │
└──────────────┘
```

- **One Supabase project per Wrily fork.** Matches the existing single-tenant,
  self-hosted posture (each org runs its own GitHub App + Worker; now also its
  own Supabase project).
- **Service-role JWT for both write and read paths.** No RLS in v1.
- **Opt-in via env presence.** When both `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are set, the workflow persists. When neither is
  set, the workflow is a strict no-op — existing zero-Supabase deployments
  keep working unchanged.
- **Partial env is a hard error.** If exactly one of the two is set, env
  parsing fails loudly; silent disable would hide misconfiguration.
- **Trigger surfaces.** Both the GitHub App path and `./wrily owner/repo PR`
  local runs go through the same insert path; rows are tagged
  `trigger_source ∈ {github_app, local_cli}`.

## Approach

**Approach 1 — Thin (direct PostgREST via `fetch`).** Chosen.

- No new npm runtime deps for inserts/reads.
- Schema lives in plain SQL migration files under `supabase/migrations/`,
  applied via the official `supabase` CLI.
- `@supabase/supabase-js` and a direct `postgres` client were both evaluated
  and rejected for v1: the write pattern is two inserts per run and the read
  pattern is three views; either client is overkill for that surface.

## Schema

Plain SQL migration, `supabase/migrations/0001_review_runs.sql`:

```sql
create table review_runs (
  id              uuid primary key default gen_random_uuid(),
  inserted_at     timestamptz not null default now(),

  -- identity
  github_repo     text not null,                -- "owner/repo"
  pr_number       int  not null,
  commit_sha      text not null,
  trigger_source  text not null check (trigger_source in
                    ('github_app','local_cli')),
  review_round    int  not null default 0,

  -- config snapshot
  model           text not null,                -- opus | sonnet | haiku
  review_mode     text not null check (review_mode in ('single','team')),
  scope           text not null check (scope in ('full','delta')),
  max_budget_usd  numeric(10,4),

  -- outcome
  status          text not null check (status in
                    ('success','budget_exceeded','timeout','failed')),
  duration_ms     int  not null,
  findings_posted int,                          -- null unless status='success'

  -- aggregated usage (sum of subagent rows for team; single child for single)
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

  -- "correctness" | "conventions" | "contracts" | "spec-compliance"
  -- | "unifier" | "single"
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
```

Canned views, `supabase/migrations/0002_views.sql`:

```sql
create view spend_by_repo_30d as
  select github_repo,
         count(*)        as runs,
         sum(cost_usd)   as cost_usd,
         sum(input_tokens + output_tokens) as total_tokens
  from review_runs
  where inserted_at > now() - interval '30 days'
    and status = 'success'
  group by github_repo
  order by cost_usd desc;

create view spend_by_model_30d as
  select model,
         review_mode,
         count(*)      as runs,
         sum(cost_usd) as cost_usd,
         avg(cost_usd) as avg_cost_usd
  from review_runs
  where inserted_at > now() - interval '30 days'
    and status = 'success'
  group by model, review_mode
  order by cost_usd desc;
```

Schema notes:

- `findings_posted` is nullable; only meaningful when `status='success'`.
- `cost_usd` on the parent denormalizes the sum of children for fast top-level
  queries. For single mode there is exactly one child row; the parent equals
  it.
- No `org` column — one project = one org under the self-hosted model.
- No `repos` table — the repo string is a low-cardinality natural key not
  worth normalizing.

## Cost capture (prerequisite, currently broken)

`src/agent/claudeCode.ts` already returns `tokenUsage` as part of
`AgentResult`, but always sets it to `null`. Fix:

- Invoke `claude` with `--output-format=stream-json --verbose`.
- Accumulate stdout as NDJSON.
- Parse the final `type: "result"` event:

```jsonc
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.12,
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 5678,
    "cache_read_input_tokens": 890,
    "cache_creation_input_tokens": 42
  }
}
```

- If the final event is missing (timeout, crash, malformed stream), leave
  `tokenUsage` as `null`. The persistence step writes a row with zeroed
  token/cost fields and a non-`success` status.

This change is required for cost tracking but is also independently useful
(it populates a field other code paths can already read).

## Write path

### New module — `src/persist/supabase.ts`

```ts
export function isPersistenceEnabled(env: RuntimeEnv): boolean;
// true iff env.supabase != null

export async function recordReviewRun(
  env: RuntimeEnv,
  run: ReviewRunRecord,
  subagents: SubagentRecord[],
): Promise<void>;
// Retry-then-fail-soft: 2 retries with 250ms / 1s backoff + small jitter.
// 4xx errors are not retried. All failures are logged and swallowed; this
// function NEVER throws into the caller.

export async function queryCosts(
  env: RuntimeEnv,
  query: CostsQuery,
): Promise<CostsResult>;
// CLI-side helper. No retries; errors surface to the user.
```

Implementation: plain `fetch()` against `${SUPABASE_URL}/rest/v1/<table>`
with headers:

```
apikey:        <SERVICE_ROLE_KEY>
Authorization: Bearer <SERVICE_ROLE_KEY>
Content-Type:  application/json
Prefer:        return=minimal
```

Subagent rows are inserted in a single bulk POST (`[{...}, {...}]` body).
Parent insert happens first so the foreign key is satisfied.

### Env additions — `src/config/env.ts`

```ts
SUPABASE_URL:                z.string().url().optional().default(''),
SUPABASE_SERVICE_ROLE_KEY:   z.string().optional().default(''),
```

`parseEnv` post-validation: if exactly one of the two is non-empty, throw.
Map to `RuntimeEnv.supabase: { url, serviceRoleKey } | null` so downstream
code branches on `env.supabase`.

### Workflow wiring — `src/workflow/steps.ts`

New terminal step `persistUsageStep` runs after the existing post step.
Inputs from `WorkflowState`:

- `env`, `cfg` (identity + config snapshot)
- agent run results (single or team — provides per-subagent durations and
  token usage)
- posting outcome (`findings_posted`, derived `status`)

The step:

1. Short-circuits if `!isPersistenceEnabled(env)`.
2. Builds the parent record + one subagent record per role.
3. Calls `recordReviewRun`. The call never throws — failure is logged
   inside `recordReviewRun` and the workflow continues.

Role mapping:

- Single mode → one subagent row with `role='single'`.
- Team mode → one row per role: `correctness`, `conventions`, `contracts`,
  `spec-compliance`, plus `unifier` for the final synthesis pass.

`trigger_source` derives from the existing `WRILY_TRIGGER_SOURCE` env field
(today defaults to `push`). The bash entrypoint sets it explicitly to
`local_cli` for `./wrily owner/repo PR` invocations; the GitHub App
workflow continues to pass `push` / `comment` / `repository_dispatch` which
we collapse to `github_app` at insert time.

### `./wrily costs` CLI subcommand

```bash
./wrily costs                                      # last 30d totals + top 5 repos
./wrily costs --since 7d                           # tunable window (1d|7d|30d|90d)
./wrily costs --repo owner/repo                    # filter
./wrily costs --by model                           # group axis (repo|model|day)
./wrily costs --json                               # machine-readable
```

Implemented in `src/cli/costs.ts`, compiled and invoked from the bash
entrypoint. Reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `.env`.
Hits the `spend_by_repo_30d` / `spend_by_model_30d` views and `review_runs`
directly via PostgREST `select` + `gte` filters. Output rendered with a
hand-rolled table function (no new npm dep).

## `./wrily persistence` subcommand

Adds the official `supabase` CLI as a prerequisite alongside Docker + `gh`,
documented in `docs/self-hosting.md`. Three subcommands:

```bash
./wrily persistence init        # one-shot: create project + write .env + migrate
./wrily persistence migrate     # apply pending migrations to existing project
./wrily persistence status      # report enabled state, migrations, row counts
```

`reset` is deliberately omitted; destructive ops belong in the Supabase
dashboard with full context.

### `persistence init` flow

1. **Prereq check.** Bail with install hint if `supabase` binary is absent.
2. **Sanity.** Refuse if `.env` already contains `SUPABASE_URL`; suggest
   `migrate` instead.
3. **Auth.** `supabase projects list --output json` → if it fails on auth,
   run `supabase login` (opens browser).
4. **Org pick.** Parse list output. Auto-select when the user has 1 org;
   prompt with a numeric menu otherwise.
5. **Inputs.** Prompt for:
   - project name (default `wrily-<random6>`)
   - region (default `us-east-1`)
   - DB password (generate + display with a "save this" warning; the
     password is only needed for dashboard SQL access, not for our writes)
6. **Create.** `supabase projects create <name> --org-id <id> --region <r>
   --db-password <pw> --output json` → parse project ref.
7. **Poll.** Loop `supabase projects api-keys list --project-ref <ref>
   --output json` until a `service_role` key is returned (proxy for project
   readiness). Timeout at 5 minutes.
8. **Capture.** Extract `service_role` key and `https://<ref>.supabase.co`.
9. **Write `.env`.** Append `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
   Never overwrite existing keys silently — if present, abort.
10. **Link.** `supabase link --project-ref <ref> --password <pw>`.
11. **Migrate.** `supabase db push --include-all`.
12. **Verify.** Query `review_runs` count via PostgREST. Print summary.

### `persistence migrate` flow

Idempotent. Used when adding migrations later or when init was partial.

1. Require both env vars; otherwise instruct user to run `init`.
2. Derive project ref from URL (`https://<ref>.supabase.co` → `<ref>`).
3. `supabase link --project-ref <ref>` (idempotent).
4. `supabase db push --include-all`.
5. Print which files were applied.

### `persistence status` flow

Does not require the `supabase` binary; pure PostgREST.

1. If env vars missing → print `disabled`, exit 0.
2. `HEAD /rest/v1/review_runs` → reachable?
3. `GET /rest/v1/supabase_migrations.schema_migrations?select=version,name`
   → list applied versions (table the `supabase` CLI maintains
   automatically).
4. Row counts for `review_runs` + `review_subagent_runs` via PostgREST
   `count=exact` header.
5. Print table.

### Implementation layout

```
src/cli/persistence/
  init.ts
  migrate.ts
  status.ts
  supabaseCli.ts   # process spawn wrappers around the `supabase` binary
  env.ts           # .env read/write helpers
```

Bash entrypoint `wrily` dispatches `persistence <sub>` to
`node dist/cli/persistence/<sub>.js`.

## Failure modes

### Review hot path

| Where | Failure | Behavior |
|---|---|---|
| `stream-json` parse | malformed / missing `result` event | Log warn; insert row with actual status (`timeout`/`failed`) and zeroed token fields. Review itself unaffected. |
| `recordReviewRun` HTTP | 5xx, ECONNRESET, DNS | Retry 2× with 250 ms / 1 s backoff + jitter. Final failure → structured error log, swallow. Review post already done. |
| `recordReviewRun` HTTP | 4xx (auth, schema mismatch) | No retry. Structured error log. Swallow. (Indicates misconfig; review still ships.) |
| `recordReviewRun` HTTP | 429 | Retryable; backoff jitter included. |
| Env partial (`URL` set, key missing or vice versa) | misconfig | Fail loud at env-parse time. |

### `./wrily persistence init`

User-driven and interactive — fail loud and actionable.

| Failure | Behavior |
|---|---|
| `supabase` binary missing | Print install hint (`brew install supabase/tap/supabase` or `npm i -g supabase`), exit 1. |
| `supabase login` cancelled | Bubble exit code; no `.env` write. |
| Project creation 4xx (quota, name conflict, region) | Print API error body verbatim, exit 1. |
| Polling timeout (5 min, project not ready) | Print project ref + instruction to re-run `./wrily persistence migrate` once ready. **Do not** clean up — the project belongs to the user now. Exit 1. |
| `supabase db push` fails | Print stderr; leave project + `.env` intact; suggest re-running `migrate` after fix. Exit 1. |
| `.env` already contains `SUPABASE_URL` | Refuse; suggest `migrate` or manual edit. Exit 1. |

## Testing

Three layers, matching existing repo conventions (vitest; no new e2e infra).

### Unit (vitest)

- **`src/agent/claudeCode.test.ts`** — feed canned `stream-json` stdout
  fixtures (success, timeout-truncated, no-`result`-event); assert parsed
  `AgentTokenUsage`.
- **`src/persist/supabase.test.ts`** — mock `fetch`. Cases: 2xx happy path,
  500→retry→200, 500→retry→500 (swallowed), 401 (no retry), missing env
  returns `null` from `isPersistenceEnabled`, partial env throws at parse
  time.
- **`src/cli/persistence/env.test.ts`** — `.env` reader/writer: append when
  keys absent; abort when keys present.
- **`src/cli/persistence/supabaseCli.test.ts`** — spawn wrappers with a stub
  `supabase` script on `PATH` (test-only fixture under
  `tests/fixtures/bin/supabase`). Cases: success, missing binary, non-zero
  exit, JSON parse failure.

### Integration (vitest, opt-in)

- **`tests/integration/persistence.int.test.ts`** — runs only when
  `WRILY_INT_SUPABASE_URL` + `WRILY_INT_SUPABASE_SERVICE_ROLE_KEY` are set.
  Inserts a synthetic run, queries it back, cleans up. Skipped on CI by
  default. Test header documents that the target must be a throwaway
  project.

### Manual verification (added to `docs/self-hosting.md`)

- `./wrily persistence init` → Supabase Studio shows tables + views.
- `./wrily persistence status` → reports `enabled: true`, 0 rows.
- Open a PR (or run `./wrily owner/repo N`) → row appears with non-zero
  `cost_usd`.
- `./wrily costs --since 7d` → shows the run.
- Force a budget breach (`MAX_BUDGET=0.001`) → row appears with
  `status='budget_exceeded'`.
- Point `SUPABASE_URL` at an unreachable host → review still completes;
  structured error logged.

### CI

No CI changes in this PR. Unit tests are vitest and run under the existing
test job (once that job is added per
[`docs/followups.md`](../../followups.md) — separately tracked). The
integration test stays gated by env vars; no CI secret plumbing here.

## Docs touchpoints

- **`.env.example`** — add the two Supabase vars, commented as optional.
- **`docs/self-hosting.md`** — new "Optional: cost tracking" section
  (≤ 30 lines) covering `./wrily persistence init` and the prereq install
  line for the `supabase` CLI.
- **`README.md`** — one-line mention pointing at the section.

## Open questions

None at design time. Any open questions surfaced during implementation will
land in the implementation plan, not here.

## Out of scope (recap)

- RLS / multi-tenant collector / hosted shared service.
- Per-finding cost attribution.
- Realtime dashboards / budget-breach webhooks.
- Cost data for the Worker itself (Worker invocations are essentially free
  on Cloudflare's free tier and don't burn Anthropic credit).
- Replacing the existing `max_budget_usd` config; that stays as the
  per-review ceiling.
