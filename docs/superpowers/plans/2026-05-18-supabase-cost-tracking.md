# Supabase Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-review-run token + USD cost to a self-hosted Supabase project; expose a `./wrily costs` CLI for analytics and a `./wrily persistence` bootstrap that wraps the official `supabase` CLI.

**Architecture:** Container POSTs to PostgREST at end of run (best-effort, retry-then-fail-soft). Schema in plain SQL migrations applied via `supabase` CLI. New `./wrily persistence init` shells out to `supabase` to create a project, write `.env`, and migrate.

**Tech Stack:** TypeScript (Node 22, strict mode), vitest, Zod, `fetch` (no new runtime deps), official `supabase` CLI (user-installed prereq).

**Reference spec:** `docs/superpowers/specs/2026-05-18-supabase-cost-tracking-design.md`

## File Structure

**Created:**
- `supabase/migrations/0001_review_runs.sql` — tables, indexes, constraints
- `supabase/migrations/0002_views.sql` — `spend_by_repo_30d`, `spend_by_model_30d`
- `src/persist/supabase.ts` — `isPersistenceEnabled`, `recordReviewRun`, `queryCosts`
- `src/persist/types.ts` — `ReviewRunRecord`, `SubagentRecord`, `CostsQuery`, `CostsResult`
- `src/cli/costs.ts` — `./wrily costs` entrypoint
- `src/cli/persistence/init.ts` — `./wrily persistence init`
- `src/cli/persistence/migrate.ts` — `./wrily persistence migrate`
- `src/cli/persistence/status.ts` — `./wrily persistence status`
- `src/cli/persistence/supabaseCli.ts` — spawn wrappers for `supabase` binary
- `src/cli/persistence/dotenv.ts` — `.env` read/append (refuses overwrite)
- `tests/persist/supabase.test.ts`
- `tests/cli/persistence/dotenv.test.ts`
- `tests/cli/persistence/supabaseCli.test.ts`
- `tests/fixtures/bin/supabase` — stub binary for tests
- `tests/agent/claudeCode-streamJson.test.ts`
- `tests/integration/persistence.int.test.ts` — opt-in via env

**Modified:**
- `src/config/env.ts` — add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` parsing + partial-env hard error
- `src/config/types.ts` — add `supabase: { url, serviceRoleKey } | null` to `RuntimeEnv`
- `src/agent/runner.ts` — no changes (types already exist)
- `src/agent/claudeCode.ts` — switch to `--output-format=stream-json --verbose`, parse final `result` event
- `src/workflow/state.ts` — no changes (no new fields)
- `src/workflow/steps.ts` — add `persistUsageStep`
- `src/workflow/index.ts` — append `persistUsageStep`
- `wrily` (bash) — dispatch `costs`, `persistence <sub>` subcommands; set `WRILY_TRIGGER_SOURCE=local_cli`
- `.env.example` — document the two new vars
- `docs/self-hosting.md` — new "Optional: cost tracking" section
- `README.md` — one-line mention pointing at the section
- `tsconfig.json` — no changes (existing globs already cover `src/**`)

---

## Phase 1 — Foundation (env + cost capture)

### Task 1: Add Supabase env vars to config

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/types.ts`
- Test: `tests/config/env.test.ts`

- [ ] **Step 1.1: Add the failing test cases**

Append to `tests/config/env.test.ts` (before the closing `});` of the main `describe`):

```ts
  describe('supabase env', () => {
    it('returns env.supabase = null when both vars absent', () => {
      const env = parseEnv(minimal);
      expect(env.supabase).toBeNull();
    });

    it('returns env.supabase populated when both vars set', () => {
      const env = parseEnv({
        ...minimal,
        SUPABASE_URL: 'https://abc.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service-role.key',
      });
      expect(env.supabase).toEqual({
        url: 'https://abc.supabase.co',
        serviceRoleKey: 'eyJ.service-role.key',
      });
    });

    it('throws when only SUPABASE_URL is set', () => {
      expect(() =>
        parseEnv({ ...minimal, SUPABASE_URL: 'https://abc.supabase.co' }),
      ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    });

    it('throws when only SUPABASE_SERVICE_ROLE_KEY is set', () => {
      expect(() =>
        parseEnv({ ...minimal, SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key' }),
      ).toThrow(/SUPABASE_URL/);
    });

    it('rejects malformed SUPABASE_URL', () => {
      expect(() =>
        parseEnv({
          ...minimal,
          SUPABASE_URL: 'not-a-url',
          SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key',
        }),
      ).toThrow();
    });
  });
```

- [ ] **Step 1.2: Run test, confirm failures**

Run: `pnpm test -- tests/config/env.test.ts`
Expected: 5 failures (`env.supabase` is undefined; no partial-env throws).

- [ ] **Step 1.3: Extend `RuntimeEnv` type**

Add to `src/config/types.ts` inside the `RuntimeEnv` type:

```ts
  supabase: { url: string; serviceRoleKey: string } | null;
```

Place it before the closing `};` of `RuntimeEnv`.

- [ ] **Step 1.4: Extend `rawEnvSchema` in `src/config/env.ts`**

Add inside the `z.object({ ... })`, just before the closing `})`:

```ts
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL').optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
```

- [ ] **Step 1.5: Add partial-env check + populate `env.supabase` in `parseEnv`**

In `src/config/env.ts`, locate the auth-method block (`if (!parsed.ANTHROPIC_API_KEY && !parsed.CLAUDE_CODE_OAUTH_TOKEN) { ... }`) and add this directly after it:

```ts
  const url = parsed.SUPABASE_URL;
  const key = parsed.SUPABASE_SERVICE_ROLE_KEY;
  if (!!url !== !!key) {
    throw new Error(
      url
        ? 'SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is missing. Set both or neither.'
        : 'SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is missing. Set both or neither.',
    );
  }
  const supabase = url && key ? { url, serviceRoleKey: key } : null;
```

Add `supabase` to the returned `RuntimeEnv` object literal, alongside the other fields:

```ts
    supabase,
```

- [ ] **Step 1.6: Run test, confirm pass**

Run: `pnpm test -- tests/config/env.test.ts`
Expected: all green, including the new `supabase env` describe block.

- [ ] **Step 1.7: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 1.8: Commit**

```bash
git add src/config/env.ts src/config/types.ts tests/config/env.test.ts
git commit -m "feat(config): add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars"
```

---

### Task 2: Parse cost data from claude CLI stream-json output

**Files:**
- Modify: `src/agent/claudeCode.ts`
- Create: `tests/agent/claudeCode-streamJson.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `tests/agent/claudeCode-streamJson.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStreamJsonUsage } from '../../src/agent/claudeCode.js';

describe('parseStreamJsonUsage', () => {
  it('extracts usage and cost from a well-formed stream-json stdout', () => {
    const stdout = [
      '{"type":"system","subtype":"init","model":"claude-opus-4-7"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.1234,"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}}',
      '',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      costUsd: 0.1234,
    });
  });

  it('returns null when no result event is present', () => {
    const stdout = '{"type":"system","subtype":"init"}\n';
    expect(parseStreamJsonUsage(stdout)).toBeNull();
  });

  it('returns null when result event is malformed JSON', () => {
    const stdout = '{"type":"result","subtype":"success",NOT_JSON\n';
    expect(parseStreamJsonUsage(stdout)).toBeNull();
  });

  it('ignores non-JSON noise lines and keeps parsing', () => {
    const stdout = [
      'some non-json line',
      '{"type":"result","subtype":"success","total_cost_usd":0.05,"usage":{"input_tokens":1,"output_tokens":2}}',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.05,
    });
  });

  it('uses the last result event when multiple present', () => {
    const stdout = [
      '{"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.99,"usage":{"input_tokens":99,"output_tokens":99}}',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)?.costUsd).toBe(0.99);
  });
});
```

- [ ] **Step 2.2: Run test, confirm failure**

Run: `pnpm test -- tests/agent/claudeCode-streamJson.test.ts`
Expected: FAIL — `parseStreamJsonUsage` is not exported.

- [ ] **Step 2.3: Implement `parseStreamJsonUsage` and wire it into the runner**

In `src/agent/claudeCode.ts`:

1. Add this export near the top of the file (after the `BUDGET_RE` constant):

```ts
import type { AgentTokenUsage } from './runner.js';

export function parseStreamJsonUsage(stdout: string): AgentTokenUsage | null {
  const lines = stdout.split(/\r?\n/);
  let last: AgentTokenUsage | null = null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isResultEvent(obj)) continue;
    last = {
      inputTokens: obj.usage.input_tokens ?? 0,
      outputTokens: obj.usage.output_tokens ?? 0,
      cacheReadTokens: obj.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: obj.usage.cache_creation_input_tokens ?? 0,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
    };
  }
  return last;
}

type ResultEvent = {
  type: 'result';
  total_cost_usd?: number;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function isResultEvent(o: unknown): o is ResultEvent {
  return (
    typeof o === 'object' &&
    o !== null &&
    (o as Record<string, unknown>).type === 'result' &&
    typeof (o as Record<string, unknown>).usage === 'object' &&
    (o as Record<string, unknown>).usage !== null
  );
}
```

2. Modify the CLI args array inside `run()` to request stream-json output. Locate:

```ts
    const args = [
      '-p', opts.prompt,
      '--model', opts.model,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];
```

Replace with:

```ts
    const args = [
      '-p', opts.prompt,
      '--model', opts.model,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--output-format', 'stream-json',
      '--verbose',
    ];
```

3. Populate `tokenUsage` in the `resolve()` call. Locate:

```ts
        resolve({
          stdout, stderr, exitCode: code ?? -1, durationMs,
          tokenUsage: null,
        });
```

Replace with:

```ts
        resolve({
          stdout, stderr, exitCode: code ?? -1, durationMs,
          tokenUsage: parseStreamJsonUsage(stdout),
        });
```

- [ ] **Step 2.4: Run test, confirm pass**

Run: `pnpm test -- tests/agent/claudeCode-streamJson.test.ts`
Expected: 5 passing.

- [ ] **Step 2.5: Run full agent suite — make sure existing tests still pass**

Run: `pnpm test -- tests/agent`
Expected: all green. If existing `claudeCode.test.ts` mocks the spawn, the added CLI flags are inert; if it inspects args, update the expectation in the test to include the new flags. (Read `tests/agent/claudeCode.test.ts` first; mirror its assertion style.)

- [ ] **Step 2.6: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 2.7: Commit**

```bash
git add src/agent/claudeCode.ts tests/agent/claudeCode-streamJson.test.ts tests/agent/claudeCode.test.ts
git commit -m "feat(agent): parse token usage + cost from claude CLI stream-json"
```

(Drop `tests/agent/claudeCode.test.ts` from the `git add` if Step 2.5 did not require modifying it.)

---

## Phase 2 — Schema

### Task 3: Author Supabase migrations

**Files:**
- Create: `supabase/migrations/0001_review_runs.sql`
- Create: `supabase/migrations/0002_views.sql`

- [ ] **Step 3.1: Create tables migration**

Create `supabase/migrations/0001_review_runs.sql`:

```sql
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
```

- [ ] **Step 3.2: Create views migration**

Create `supabase/migrations/0002_views.sql`:

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

- [ ] **Step 3.3: Lint with `psql --dry-run` style sanity (offline syntax check)**

Run: `node -e "const fs=require('fs');for(const f of ['supabase/migrations/0001_review_runs.sql','supabase/migrations/0002_views.sql']){const s=fs.readFileSync(f,'utf8');if(!/;\s*$/m.test(s)){throw new Error(f+' missing trailing semicolon');}console.log(f,'ok',s.length,'B');}"`
Expected: both files print `ok` with byte counts.

(Full schema validity is asserted when applied against a real Supabase project in Task 9.)

- [ ] **Step 3.4: Commit**

```bash
git add supabase/migrations/0001_review_runs.sql supabase/migrations/0002_views.sql
git commit -m "feat(db): supabase schema for review_runs + review_subagent_runs + views"
```

---

## Phase 3 — Persistence module

### Task 4: Build the Supabase HTTP client

**Files:**
- Create: `src/persist/types.ts`
- Create: `src/persist/supabase.ts`
- Create: `tests/persist/supabase.test.ts`

- [ ] **Step 4.1: Define record types**

Create `src/persist/types.ts`:

```ts
export type SubagentRecord = {
  role: string;                      // 'single' | 'team' | 'correctness' | 'conventions' | 'contracts' | 'spec-compliance' | 'unifier'
  model: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
};

export type ReviewRunRecord = {
  github_repo: string;
  pr_number: number;
  commit_sha: string;
  trigger_source: 'github_app' | 'local_cli';
  review_round: number;
  model: string;
  review_mode: 'single' | 'team';
  scope: 'full' | 'delta';
  max_budget_usd: number | null;
  status: 'success' | 'budget_exceeded' | 'timeout' | 'failed';
  duration_ms: number;
  findings_posted: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
};

export type CostsQuery = {
  sinceDays: number;                 // 1 | 7 | 30 | 90 etc.
  repo?: string;                     // 'owner/repo' filter
  by: 'repo' | 'model' | 'day';
};

export type CostsRow = Record<string, string | number>;

export type CostsResult = {
  rows: CostsRow[];
};
```

- [ ] **Step 4.2: Write the failing test**

Create `tests/persist/supabase.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPersistenceEnabled, recordReviewRun } from '../../src/persist/supabase.js';
import type { RuntimeEnv } from '../../src/config/types.js';
import type { ReviewRunRecord, SubagentRecord } from '../../src/persist/types.js';

const baseEnv = {
  authMethod: 'oauth',
  anthropicApiKey: null,
  claudeCodeOauthToken: 'tok',
  githubToken: 't',
  prNumber: 1,
  githubRepository: 'o/r',
  baseBranch: 'main',
  commitSha: 'abc',
  sharedRepo: '',
  sharedToken: '',
  wrilyBotLogin: 'wrily',
  reviewRoundIndex: 0,
  scopeOverride: '',
  modeOverride: '',
  modelOverride: '',
  maxBudgetOverride: null,
  dryRun: true,
  prAuthorLogin: '',
  triggerSource: 'push',
  actor: '',
  replyFeedbackOverride: '',
} as unknown as RuntimeEnv;

const enabledEnv: RuntimeEnv = {
  ...baseEnv,
  supabase: { url: 'https://abc.supabase.co', serviceRoleKey: 'eyJ.key' },
};

const disabledEnv: RuntimeEnv = { ...baseEnv, supabase: null };

const run: ReviewRunRecord = {
  github_repo: 'o/r',
  pr_number: 1,
  commit_sha: 'abc',
  trigger_source: 'local_cli',
  review_round: 0,
  model: 'opus',
  review_mode: 'single',
  scope: 'full',
  max_budget_usd: 5,
  status: 'success',
  duration_ms: 1000,
  findings_posted: 3,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0.01,
};

const subs: SubagentRecord[] = [
  { role: 'single', model: 'opus', duration_ms: 1000, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.01 },
];

describe('isPersistenceEnabled', () => {
  it('true when env.supabase is set', () => {
    expect(isPersistenceEnabled(enabledEnv)).toBe(true);
  });
  it('false when env.supabase is null', () => {
    expect(isPersistenceEnabled(disabledEnv)).toBe(false);
  });
});

describe('recordReviewRun', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('happy path: posts parent then children, resolves void', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await recordReviewRun(enabledEnv, run, subs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0]!;
    const [secondUrl] = fetchMock.mock.calls[1]!;
    expect(firstUrl).toMatch(/\/rest\/v1\/review_runs(\?|$)/);
    expect(secondUrl).toMatch(/\/rest\/v1\/review_subagent_runs(\?|$)/);
  });

  it('passes apikey + Authorization headers', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await recordReviewRun(enabledEnv, run, subs);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      apikey: 'eyJ.key',
      Authorization: 'Bearer eyJ.key',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    });
  });

  it('retries on 500 and succeeds on the third attempt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'r1' }]), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const p = recordReviewRun(enabledEnv, run, subs);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    // 3 attempts for parent + 1 for child
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry on 401, swallows error', async () => {
    fetchMock.mockResolvedValue(new Response('bad auth', { status: 401 }));
    await expect(recordReviewRun(enabledEnv, run, subs)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows final failure after retries exhausted', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const p = recordReviewRun(enabledEnv, run, subs);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBeUndefined();
  });

  it('no-ops when env.supabase is null', async () => {
    await recordReviewRun(disabledEnv, run, subs);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4.3: Run test, confirm failure**

Run: `pnpm test -- tests/persist/supabase.test.ts`
Expected: module not found — `src/persist/supabase.ts` doesn't exist yet.

- [ ] **Step 4.4: Implement `src/persist/supabase.ts`**

```ts
import type { RuntimeEnv } from '../config/types.js';
import type { ReviewRunRecord, SubagentRecord, CostsQuery, CostsResult } from './types.js';

export function isPersistenceEnabled(env: RuntimeEnv): boolean {
  return env.supabase !== null;
}

const RETRY_DELAYS_MS = [250, 1000];

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 250);
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function postWithRetry(
  url: string,
  serviceRoleKey: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let lastStatus = 0;
  let lastBody: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: true, status: res.status, data };
    }
    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');
    if (!shouldRetry(res.status)) break;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await new Promise((r) => setTimeout(r, jitter(delay)));
  }
  return { ok: false, status: lastStatus, data: lastBody };
}

function logPersistError(label: string, detail: unknown): void {
  console.warn(JSON.stringify({
    level: 'warn',
    ts: new Date().toISOString(),
    component: 'persist',
    label,
    detail,
  }));
}

export async function recordReviewRun(
  env: RuntimeEnv,
  run: ReviewRunRecord,
  subagents: SubagentRecord[],
): Promise<void> {
  if (!env.supabase) return;
  const { url, serviceRoleKey } = env.supabase;

  const parentRes = await postWithRetry(
    `${url}/rest/v1/review_runs`,
    serviceRoleKey,
    run,
  );
  if (!parentRes.ok) {
    logPersistError('parent-insert-failed', { status: parentRes.status, body: parentRes.data });
    return;
  }

  const inserted = parentRes.data as Array<{ id?: string }> | null;
  const parentId = inserted?.[0]?.id;
  if (!parentId) {
    logPersistError('parent-insert-no-id', { data: parentRes.data });
    return;
  }

  if (subagents.length === 0) return;

  const childBody = subagents.map((s) => ({ ...s, run_id: parentId }));
  const childRes = await postWithRetry(
    `${url}/rest/v1/review_subagent_runs`,
    serviceRoleKey,
    childBody,
  );
  if (!childRes.ok) {
    logPersistError('child-insert-failed', { status: childRes.status, body: childRes.data });
  }
}

export async function queryCosts(env: RuntimeEnv, query: CostsQuery): Promise<CostsResult> {
  if (!env.supabase) throw new Error('Supabase persistence is not configured.');
  const { url, serviceRoleKey } = env.supabase;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const view =
    query.by === 'repo' ? 'spend_by_repo_30d' :
    query.by === 'model' ? 'spend_by_model_30d' :
    null;
  const target = view ? `${url}/rest/v1/${view}?select=*` : buildDayRollupUrl(url, query);
  const filtered = query.repo && view === 'spend_by_repo_30d'
    ? `${target}&github_repo=eq.${encodeURIComponent(query.repo)}`
    : target;
  const res = await fetch(filtered, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase query failed: ${res.status} ${body}`);
  }
  const rows = (await res.json()) as CostsResult['rows'];
  return { rows };
}

function buildDayRollupUrl(url: string, query: CostsQuery): string {
  const since = new Date(Date.now() - query.sinceDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: 'inserted_at,github_repo,model,cost_usd,input_tokens,output_tokens',
    'inserted_at': `gte.${since}`,
    status: 'eq.success',
    order: 'inserted_at.desc',
  });
  if (query.repo) params.append('github_repo', `eq.${query.repo}`);
  return `${url}/rest/v1/review_runs?${params.toString()}`;
}
```

- [ ] **Step 4.5: Run tests, confirm pass**

Run: `pnpm test -- tests/persist/supabase.test.ts`
Expected: all 7 tests green.

- [ ] **Step 4.6: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 4.7: Commit**

```bash
git add src/persist tests/persist
git commit -m "feat(persist): supabase HTTP client with retry-then-fail-soft"
```

---

## Phase 4 — Workflow integration

### Task 5: Add `persistUsageStep` to the workflow

**Files:**
- Modify: `src/workflow/steps.ts`
- Modify: `src/workflow/index.ts`

- [ ] **Step 5.1: Add import + collapse helper near the top of `src/workflow/steps.ts`**

Add to the import block at the top of the file (alongside existing imports):

```ts
import { isPersistenceEnabled, recordReviewRun } from '../persist/supabase.js';
import type { ReviewRunRecord, SubagentRecord } from '../persist/types.js';
```

Add this private helper after the existing utility helpers (e.g., after `sanitizedError`):

```ts
function collapseTriggerSource(raw: string): 'github_app' | 'local_cli' {
  return raw === 'local_cli' ? 'local_cli' : 'github_app';
}

function deriveStatus(state: WorkflowState): 'success' | 'budget_exceeded' | 'timeout' | 'failed' {
  // Workflow only reaches persistUsageStep on success or a soft-handled failure;
  // hard failures are caught upstream in main.ts. We treat absence of agentResults
  // or fallbackUsed as a failed run for accounting purposes.
  if (!state.agentResults || state.agentResults.length === 0) return 'failed';
  if (state.fallbackUsed) return 'failed';
  return 'success';
}
```

- [ ] **Step 5.2: Add the new `persistUsageStep` definition**

Add this step alongside the other `createStep` blocks in `src/workflow/steps.ts` (place it after `resolveAddressedThreadsStep`):

```ts
  const persistUsageStep = createStep({
    id: 'persistUsage',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (!isPersistenceEnabled(state.env)) return state;
      try {
        const status = deriveStatus(state);
        const agentResults = state.agentResults ?? [];
        const totalDuration = agentResults.reduce((sum, r) => sum + r.durationMs, 0);
        const totals = agentResults.reduce(
          (acc, r) => {
            const u = r.tokenUsage;
            if (!u) return acc;
            acc.input += u.inputTokens;
            acc.output += u.outputTokens;
            acc.cacheRead += u.cacheReadTokens ?? 0;
            acc.cacheWrite += u.cacheWriteTokens ?? 0;
            acc.cost += u.costUsd ?? 0;
            return acc;
          },
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        );

        const run: ReviewRunRecord = {
          github_repo: state.env.githubRepository,
          pr_number: state.env.prNumber,
          commit_sha: state.env.commitSha,
          trigger_source: collapseTriggerSource(state.env.triggerSource),
          review_round: state.reviewRoundIndex ?? state.env.reviewRoundIndex ?? 0,
          model: state.cfg.model,
          review_mode: state.reviewMode === 'team' ? 'team' : 'single',
          scope: state.reviewType === 'delta' ? 'delta' : 'full',
          max_budget_usd: state.cfg.max_budget_usd ?? null,
          status,
          duration_ms: totalDuration,
          findings_posted: status === 'success' ? state.findings?.length ?? 0 : null,
          input_tokens: totals.input,
          output_tokens: totals.output,
          cache_read_tokens: totals.cacheRead,
          cache_write_tokens: totals.cacheWrite,
          cost_usd: totals.cost,
        };

        const subagents: SubagentRecord[] = agentResults.map((r, idx) => ({
          role: state.reviewMode === 'team'
            ? (state.renderedPromptsByAgent && state.renderedPromptsByAgent.length > 1
                ? `team-${idx}`
                : 'team')
            : 'single',
          model: state.cfg.model,
          duration_ms: r.durationMs,
          input_tokens: r.tokenUsage?.inputTokens ?? 0,
          output_tokens: r.tokenUsage?.outputTokens ?? 0,
          cache_read_tokens: r.tokenUsage?.cacheReadTokens ?? 0,
          cache_write_tokens: r.tokenUsage?.cacheWriteTokens ?? 0,
          cost_usd: r.tokenUsage?.costUsd ?? 0,
        }));

        await recordReviewRun(state.env, run, subagents);
      } catch (err) {
        console.warn(`[persistUsage] failed: ${(err as Error).message}`);
      }
      return state;
    },
  });
```

- [ ] **Step 5.3: Export `persistUsageStep`**

Locate the `makeSteps` return object (near the bottom of `makeSteps`, currently returning `agentCallStep, ...` etc.) and add `persistUsageStep` to the returned object alongside the others.

- [ ] **Step 5.4: Wire it into the workflow**

In `src/workflow/index.ts`, append one `.then(steps.persistUsageStep)` after `.then(steps.resolveAddressedThreadsStep)`:

```ts
    .then(steps.resolveAddressedThreadsStep)
    .then(steps.persistUsageStep)
    .commit();
```

- [ ] **Step 5.5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. If `state.findings?.length` complains about `noUncheckedIndexedAccess`, narrow with `state.findings ? state.findings.length : 0`.

- [ ] **Step 5.6: Run full test suite — confirm no regressions**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 5.7: Commit**

```bash
git add src/workflow/steps.ts src/workflow/index.ts
git commit -m "feat(workflow): persistUsageStep records cost data to supabase"
```

---

## Phase 5 — CLI (persistence + costs)

### Task 6: `.env` reader / appender

**Files:**
- Create: `src/cli/persistence/dotenv.ts`
- Create: `tests/cli/persistence/dotenv.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `tests/cli/persistence/dotenv.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readDotEnv, appendDotEnv, hasKey } from '../../../src/cli/persistence/dotenv.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('dotenv helpers', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrily-dotenv-'));
    file = join(dir, '.env');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('readDotEnv returns empty object when file missing', () => {
    expect(readDotEnv(file)).toEqual({});
  });

  it('readDotEnv parses KEY=value, skips blanks + comments', () => {
    writeFileSync(file, '# comment\nFOO=bar\n\nBAZ="quoted"\n');
    expect(readDotEnv(file)).toEqual({ FOO: 'bar', BAZ: 'quoted' });
  });

  it('hasKey returns true only when the key exists', () => {
    writeFileSync(file, 'FOO=bar\n');
    expect(hasKey(file, 'FOO')).toBe(true);
    expect(hasKey(file, 'BAR')).toBe(false);
  });

  it('appendDotEnv appends + creates trailing newline', () => {
    writeFileSync(file, 'EXISTING=1');
    appendDotEnv(file, { NEW: 'val' });
    const txt = readFileSync(file, 'utf8');
    expect(txt).toMatch(/EXISTING=1\nNEW=val\n$/);
  });

  it('appendDotEnv refuses to overwrite an existing key', () => {
    writeFileSync(file, 'FOO=bar\n');
    expect(() => appendDotEnv(file, { FOO: 'baz' })).toThrow(/FOO/);
  });

  it('appendDotEnv creates the file when missing', () => {
    expect(existsSync(file)).toBe(false);
    appendDotEnv(file, { FIRST: '1' });
    expect(readFileSync(file, 'utf8')).toBe('FIRST=1\n');
  });
});
```

- [ ] **Step 6.2: Run test, confirm failure**

Run: `pnpm test -- tests/cli/persistence/dotenv.test.ts`
Expected: module not found.

- [ ] **Step 6.3: Implement `src/cli/persistence/dotenv.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

export function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function hasKey(path: string, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(readDotEnv(path), key);
}

export function appendDotEnv(path: string, entries: Record<string, string>): void {
  const existing = readDotEnv(path);
  for (const k of Object.keys(entries)) {
    if (k in existing) throw new Error(`Refusing to overwrite existing .env key: ${k}`);
  }
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (!existsSync(path)) {
    writeFileSync(path, lines, 'utf8');
    return;
  }
  const current = readFileSync(path, 'utf8');
  const needsNewline = current.length > 0 && !current.endsWith('\n');
  appendFileSync(path, (needsNewline ? '\n' : '') + lines, 'utf8');
}
```

- [ ] **Step 6.4: Run test, confirm pass**

Run: `pnpm test -- tests/cli/persistence/dotenv.test.ts`
Expected: 6 passing.

- [ ] **Step 6.5: Commit**

```bash
git add src/cli/persistence/dotenv.ts tests/cli/persistence/dotenv.test.ts
git commit -m "feat(cli): .env reader + safe appender (refuses overwrite)"
```

---

### Task 7: Wrappers for the `supabase` binary

**Files:**
- Create: `src/cli/persistence/supabaseCli.ts`
- Create: `tests/cli/persistence/supabaseCli.test.ts`
- Create: `tests/fixtures/bin/supabase`

- [ ] **Step 7.1: Create the stub binary fixture**

Create `tests/fixtures/bin/supabase` (Unix script; chmod +x in a later step):

```bash
#!/usr/bin/env bash
# Test stub for the `supabase` CLI. Behavior is driven by env vars set by
# the test harness:
#   STUB_SUPABASE_EXIT=<n>      → exit with this code (default 0)
#   STUB_SUPABASE_STDOUT=<json> → echo this to stdout
#   STUB_SUPABASE_STDERR=<msg>  → echo this to stderr
echo "${STUB_SUPABASE_STDOUT:-}"
if [[ -n "${STUB_SUPABASE_STDERR:-}" ]]; then echo "${STUB_SUPABASE_STDERR}" >&2; fi
exit "${STUB_SUPABASE_EXIT:-0}"
```

Then mark it executable:

```bash
chmod +x tests/fixtures/bin/supabase
```

- [ ] **Step 7.2: Write the failing test**

Create `tests/cli/persistence/supabaseCli.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { runSupabase, requireSupabaseBinary } from '../../../src/cli/persistence/supabaseCli.js';
import { resolve } from 'node:path';

const FIXTURE_BIN = resolve(__dirname, '../../fixtures/bin');

describe('supabaseCli', () => {
  beforeEach(() => {
    process.env.PATH = `${FIXTURE_BIN}:${process.env.PATH ?? ''}`;
    delete process.env.STUB_SUPABASE_EXIT;
    delete process.env.STUB_SUPABASE_STDOUT;
    delete process.env.STUB_SUPABASE_STDERR;
  });

  it('requireSupabaseBinary resolves when binary is on PATH', () => {
    expect(() => requireSupabaseBinary()).not.toThrow();
  });

  it('requireSupabaseBinary throws when missing', () => {
    process.env.PATH = '/nonexistent';
    expect(() => requireSupabaseBinary()).toThrow(/supabase CLI not found/);
  });

  it('runSupabase passes args and returns stdout on success', async () => {
    process.env.STUB_SUPABASE_STDOUT = '{"ok":true}';
    const out = await runSupabase(['projects', 'list', '--output', 'json']);
    expect(out.stdout.trim()).toBe('{"ok":true}');
    expect(out.exitCode).toBe(0);
  });

  it('runSupabase rejects with stderr on non-zero exit', async () => {
    process.env.STUB_SUPABASE_EXIT = '2';
    process.env.STUB_SUPABASE_STDERR = 'auth required';
    await expect(runSupabase(['projects', 'list'])).rejects.toThrow(/auth required/);
  });
});
```

- [ ] **Step 7.3: Run test, confirm failure**

Run: `pnpm test -- tests/cli/persistence/supabaseCli.test.ts`
Expected: module not found.

- [ ] **Step 7.4: Implement `src/cli/persistence/supabaseCli.ts`**

```ts
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

export class SupabaseCliMissingError extends Error {
  constructor() {
    super('supabase CLI not found on PATH. Install with `brew install supabase/tap/supabase` or `npm i -g supabase`.');
    this.name = 'SupabaseCliMissingError';
  }
}

export function requireSupabaseBinary(): void {
  try {
    execFileSync('command', ['-v', 'supabase'], { stdio: 'ignore', shell: '/bin/bash' });
  } catch {
    throw new SupabaseCliMissingError();
  }
}

export type SupabaseRunResult = { stdout: string; stderr: string; exitCode: number };

export function runSupabase(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<SupabaseRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('supabase', args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        rejectPromise(new Error(`supabase ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    if (opts.input) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}
```

- [ ] **Step 7.5: Run test, confirm pass**

Run: `pnpm test -- tests/cli/persistence/supabaseCli.test.ts`
Expected: 4 passing.

- [ ] **Step 7.6: Commit**

```bash
git add src/cli/persistence/supabaseCli.ts tests/cli/persistence/supabaseCli.test.ts tests/fixtures/bin/supabase
git commit -m "feat(cli): spawn wrappers around the supabase CLI binary"
```

---

### Task 8: `./wrily persistence status`

**Files:**
- Create: `src/cli/persistence/status.ts`

(No unit tests for `status` — it's a thin terminal wrapper around `fetch`; covered by the manual verification checklist and the integration test in Task 12.)

- [ ] **Step 8.1: Implement `src/cli/persistence/status.ts`**

```ts
import { readDotEnv } from './dotenv.js';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

const ENV_PATH = resolve(process.cwd(), '.env');
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase', 'migrations');

export async function statusCommand(): Promise<number> {
  const env = readDotEnv(ENV_PATH);
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('Wrily persistence: disabled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env)');
    return 0;
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'count=exact',
  };

  // Probe by issuing a count=exact query against review_runs. If the table
  // doesn't exist (404 / 42P01), the project is reachable but migrations have
  // not been applied — report that distinctly from the "unreachable" case.
  const reachable = await fetch(`${url}/rest/v1/review_runs?select=id&limit=0`, { headers });
  if (reachable.status === 404 || reachable.status === 400) {
    console.log('Wrily persistence: project reachable but migrations not applied.');
    console.log('Run `./wrily persistence migrate` to apply them.');
    return 0;
  }
  if (!reachable.ok) {
    console.error(`Wrily persistence: error reaching Supabase (${reachable.status})`);
    return 1;
  }

  const runsCount = parseCount(reachable.headers.get('content-range'));
  const subRes = await fetch(`${url}/rest/v1/review_subagent_runs?select=id&limit=0`, { headers });
  const subsCount = subRes.ok ? parseCount(subRes.headers.get('content-range')) : 'unknown';

  // Migration tracking lives in the `supabase_migrations` schema which isn't
  // exposed to PostgREST by default. Listing the local migration files is the
  // same information (the `supabase` CLI applies them in lex order).
  const localMigrations = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  console.log('Wrily persistence: enabled');
  console.log(`  URL:                       ${url}`);
  console.log(`  review_runs rows:          ${runsCount}`);
  console.log(`  review_subagent_runs rows: ${subsCount}`);
  console.log(`  migration files in repo:   ${localMigrations.length}`);
  for (const m of localMigrations) console.log(`    - ${m}`);
  return 0;
}

function parseCount(contentRange: string | null): string {
  if (!contentRange) return 'unknown';
  const slash = contentRange.indexOf('/');
  return slash >= 0 ? contentRange.slice(slash + 1) : 'unknown';
}

statusCommand().then((code) => process.exit(code)).catch((err) => {
  console.error(`status failed: ${(err as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 8.2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 8.3: Commit**

```bash
git add src/cli/persistence/status.ts
git commit -m "feat(cli): wrily persistence status"
```

---

### Task 9: `./wrily persistence migrate`

**Files:**
- Create: `src/cli/persistence/migrate.ts`

- [ ] **Step 9.1: Implement `src/cli/persistence/migrate.ts`**

```ts
import { readDotEnv } from './dotenv.js';
import { requireSupabaseBinary, runSupabase } from './supabaseCli.js';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

function projectRefFromUrl(url: string): string {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/);
  if (!m || !m[1]) throw new Error(`Cannot derive project ref from SUPABASE_URL: ${url}`);
  return m[1];
}

export async function migrateCommand(): Promise<number> {
  requireSupabaseBinary();
  const env = readDotEnv(ENV_PATH);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Wrily persistence is not configured. Run `./wrily persistence init` first.');
    return 1;
  }
  const ref = projectRefFromUrl(env.SUPABASE_URL);
  console.log(`Linking to project ${ref}...`);
  await runSupabase(['link', '--project-ref', ref]).catch((err) => {
    // `supabase link` is idempotent but exits non-zero when re-linking the same project; treat that as success.
    if (!String(err.message).includes('already linked')) throw err;
  });
  console.log('Applying migrations (supabase db push --include-all)...');
  const res = await runSupabase(['db', 'push', '--include-all']);
  process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  console.log('✓ Migrations applied.');
  return 0;
}

migrateCommand().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 9.2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 9.3: Commit**

```bash
git add src/cli/persistence/migrate.ts
git commit -m "feat(cli): wrily persistence migrate"
```

---

### Task 10: `./wrily persistence init`

**Files:**
- Create: `src/cli/persistence/init.ts`

- [ ] **Step 10.1: Implement `src/cli/persistence/init.ts`**

```ts
import { readDotEnv, appendDotEnv, hasKey } from './dotenv.js';
import { requireSupabaseBinary, runSupabase } from './supabaseCli.js';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ENV_PATH = resolve(process.cwd(), '.env');
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

async function prompt(label: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const ans = await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `);
    return ans.trim() || fallback || '';
  } finally {
    rl.close();
  }
}

async function ensureLoggedIn(): Promise<void> {
  try {
    await runSupabase(['projects', 'list', '--output', 'json']);
  } catch (err) {
    if (!/Access token not provided|login/i.test((err as Error).message)) throw err;
    console.log('Not logged in to Supabase. Opening browser for login...');
    await runSupabase(['login']);
  }
}

type Org = { id: string; name: string };

async function pickOrg(): Promise<Org> {
  const res = await runSupabase(['orgs', 'list', '--output', 'json']);
  const orgs = JSON.parse(res.stdout) as Org[];
  if (orgs.length === 0) throw new Error('No Supabase organizations found for this account.');
  if (orgs.length === 1) {
    console.log(`Using organization: ${orgs[0]!.name} (${orgs[0]!.id})`);
    return orgs[0]!;
  }
  console.log('Available organizations:');
  orgs.forEach((o, i) => console.log(`  ${i + 1}. ${o.name} (${o.id})`));
  const pick = await prompt(`Choose (1-${orgs.length})`, '1');
  const idx = Number.parseInt(pick, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= orgs.length) throw new Error('Invalid org selection.');
  return orgs[idx]!;
}

function defaultProjectName(): string {
  return `wrily-${randomBytes(3).toString('hex')}`;
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

type ApiKey = { name: string; api_key: string };

async function fetchServiceRoleKey(ref: string): Promise<string | null> {
  try {
    const res = await runSupabase(['projects', 'api-keys', 'list', '--project-ref', ref, '--output', 'json']);
    const keys = JSON.parse(res.stdout) as ApiKey[];
    return keys.find((k) => k.name === 'service_role')?.api_key ?? null;
  } catch {
    return null;
  }
}

async function pollUntilReady(ref: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const key = await fetchServiceRoleKey(ref);
    if (key) return key;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Project ${ref} did not become ready within ${Math.round(POLL_TIMEOUT_MS / 60_000)} minutes. ` +
      `Re-run \`./wrily persistence migrate\` once the dashboard shows the project as healthy.`,
  );
}

export async function initCommand(): Promise<number> {
  requireSupabaseBinary();

  const existing = readDotEnv(ENV_PATH);
  if (hasKey(ENV_PATH, 'SUPABASE_URL') || hasKey(ENV_PATH, 'SUPABASE_SERVICE_ROLE_KEY')) {
    console.error(
      '.env already contains Supabase credentials. ' +
        'Run `./wrily persistence migrate` to apply pending migrations to an existing project, ' +
        'or remove the existing entries manually first.',
    );
    return 1;
  }
  void existing;

  await ensureLoggedIn();
  const org = await pickOrg();

  const name = await prompt('Project name', defaultProjectName());
  const region = await prompt('Region', 'us-east-1');
  const password = generatePassword();
  console.log(`Generated DB password: ${password}`);
  console.log('Save this somewhere safe — it is only needed for dashboard SQL access, not for Wrily writes.');

  console.log(`Creating project ${name} in ${region}...`);
  const created = await runSupabase([
    'projects', 'create', name,
    '--org-id', org.id,
    '--region', region,
    '--db-password', password,
    '--output', 'json',
  ]);
  const parsed = JSON.parse(created.stdout) as { id?: string; ref?: string };
  const ref = parsed.ref ?? parsed.id;
  if (!ref) throw new Error(`Could not parse project ref from supabase output: ${created.stdout}`);

  console.log(`Waiting for project ${ref} to become ready (up to 5 min)`);
  const serviceRoleKey = await pollUntilReady(ref);
  console.log(' ready.');

  const url = `https://${ref}.supabase.co`;
  appendDotEnv(ENV_PATH, {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
  console.log(`✓ Credentials written to ${ENV_PATH}`);

  console.log('Linking + applying migrations...');
  await runSupabase(['link', '--project-ref', ref, '--password', password]);
  const push = await runSupabase(['db', 'push', '--include-all']);
  process.stdout.write(push.stdout);

  console.log('');
  console.log(`✓ Project ready: ${name} (${region})`);
  console.log('✓ Migrations applied: 0001_review_runs.sql, 0002_views.sql');
  console.log('Next: open a PR; rows will land here. Query with `./wrily costs`.');
  return 0;
}

initCommand().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 10.2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 10.3: Commit**

```bash
git add src/cli/persistence/init.ts
git commit -m "feat(cli): wrily persistence init (create supabase project + migrate)"
```

---

### Task 11: `./wrily costs`

**Files:**
- Create: `src/cli/costs.ts`

- [ ] **Step 11.1: Implement `src/cli/costs.ts`**

```ts
import { readDotEnv } from './persistence/dotenv.js';
import { queryCosts } from '../persist/supabase.js';
import type { RuntimeEnv } from '../config/types.js';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

type Args = {
  sinceDays: number;
  by: 'repo' | 'model' | 'day';
  repo?: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { sinceDays: 30, by: 'repo', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' || a === '-s') {
      const v = argv[++i] ?? '';
      const m = v.match(/^(\d+)d$/);
      if (!m || !m[1]) throw new Error(`--since expects e.g. 7d or 30d, got: ${v}`);
      out.sinceDays = Number.parseInt(m[1], 10);
    } else if (a === '--by') {
      const v = argv[++i] ?? '';
      if (v !== 'repo' && v !== 'model' && v !== 'day') throw new Error(`--by must be repo|model|day, got: ${v}`);
      out.by = v;
    } else if (a === '--repo') {
      out.repo = argv[++i];
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: wrily costs [--since 30d] [--by repo|model|day] [--repo owner/repo] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmt = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(fmt(cols));
  console.log(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(fmt(cols.map((c) => String(r[c] ?? ''))));
}

async function main(): Promise<number> {
  const env = readDotEnv(ENV_PATH);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Wrily persistence is not configured. Run `./wrily persistence init` first.');
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  const runtimeEnv = { supabase: { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY } } as unknown as RuntimeEnv;
  const result = await queryCosts(runtimeEnv, { sinceDays: args.sinceDays, by: args.by, repo: args.repo });
  if (args.json) {
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    console.log(`Wrily spend (last ${args.sinceDays}d, by ${args.by}):`);
    printTable(result.rows);
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 11.2: Build + smoke compile**

Run: `pnpm build`
Expected: emits `dist/cli/costs.js` and `dist/cli/persistence/*.js` without errors.

- [ ] **Step 11.3: Commit**

```bash
git add src/cli/costs.ts
git commit -m "feat(cli): wrily costs (queries supabase for spend rollups)"
```

---

### Task 12: Wire the bash entrypoint

**Files:**
- Modify: `wrily`

- [ ] **Step 12.1: Add subcommand dispatch at the top of `wrily`**

In the `wrily` bash script, locate the line just after `set -euo pipefail` and `SCRIPT_DIR="..."` (currently before the `# Parse arguments` block). Insert this dispatch:

```bash
# ---------------------------------------------------------------------------
# Subcommand dispatch: `wrily costs ...` and `wrily persistence <sub> ...`
# ---------------------------------------------------------------------------
case "${1:-}" in
  costs)
    shift
    cd "${SCRIPT_DIR}"
    if [[ ! -d node_modules ]]; then pnpm install --frozen-lockfile; fi
    if [[ ! -f dist/cli/costs.js ]]; then pnpm build; fi
    exec node dist/cli/costs.js "$@"
    ;;
  persistence)
    shift
    SUB="${1:-}"; shift || true
    cd "${SCRIPT_DIR}"
    if [[ ! -d node_modules ]]; then pnpm install --frozen-lockfile; fi
    if [[ ! -f dist/cli/persistence/${SUB}.js ]]; then pnpm build; fi
    case "${SUB}" in
      init|migrate|status)
        exec node "dist/cli/persistence/${SUB}.js" "$@"
        ;;
      *)
        echo "Usage: ./wrily persistence {init|migrate|status}"
        exit 1
        ;;
    esac
    ;;
esac
```

- [ ] **Step 12.2: Tag local CLI runs as `local_cli`**

Further down in `wrily`, locate where docker env flags are constructed (`-e` flags passed to `docker run`). Add this `-e` near the existing `WRILY_TRIGGER_SOURCE`-style flags, or create one if none exists:

```bash
-e WRILY_TRIGGER_SOURCE=local_cli
```

If `WRILY_TRIGGER_SOURCE` is already passed, ensure the local invocation overrides it to `local_cli`.

- [ ] **Step 12.3: Update `--help` text**

In the `--help|-h)` block of `wrily`, append:

```bash
      echo ""
      echo "Subcommands:"
      echo "  ./wrily costs [--since 30d] [--by repo|model|day]   Show spend rollups"
      echo "  ./wrily persistence init                            Create Supabase project + migrate"
      echo "  ./wrily persistence migrate                         Apply pending migrations"
      echo "  ./wrily persistence status                          Show persistence health"
```

- [ ] **Step 12.4: Smoke-run the help text**

Run: `./wrily --help | grep persistence`
Expected: subcommand lines visible.

- [ ] **Step 12.5: Smoke-run the subcommand routing (without supabase configured)**

Run: `./wrily persistence status`
Expected: prints `Wrily persistence: disabled (...)` and exits 0.

- [ ] **Step 12.6: Commit**

```bash
git add wrily
git commit -m "feat(cli): wrily entrypoint dispatches costs + persistence subcommands"
```

---

## Phase 6 — Integration test + docs

### Task 13: Opt-in integration test

**Files:**
- Create: `tests/integration/persistence.int.test.ts`

- [ ] **Step 13.1: Write the integration test (skipped unless env present)**

```ts
import { describe, it, expect } from 'vitest';
import { recordReviewRun, queryCosts } from '../../src/persist/supabase.js';
import type { RuntimeEnv } from '../../src/config/types.js';
import type { ReviewRunRecord, SubagentRecord } from '../../src/persist/types.js';

const URL = process.env.WRILY_INT_SUPABASE_URL;
const KEY = process.env.WRILY_INT_SUPABASE_SERVICE_ROLE_KEY;
const integration = URL && KEY ? describe : describe.skip;

// IMPORTANT: point WRILY_INT_SUPABASE_URL at a throwaway project. This test
// inserts and does NOT clean up — it relies on filterable test data.

integration('persistence integration', () => {
  const env = { supabase: { url: URL!, serviceRoleKey: KEY! } } as unknown as RuntimeEnv;

  it('inserts a run + subagent and reads it back', async () => {
    const sha = `test-${Date.now()}`;
    const run: ReviewRunRecord = {
      github_repo: 'wrily-int/test',
      pr_number: 1,
      commit_sha: sha,
      trigger_source: 'local_cli',
      review_round: 0,
      model: 'opus',
      review_mode: 'single',
      scope: 'full',
      max_budget_usd: 5,
      status: 'success',
      duration_ms: 1000,
      findings_posted: 1,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
    };
    const sub: SubagentRecord = {
      role: 'single', model: 'opus', duration_ms: 1000,
      input_tokens: 10, output_tokens: 20,
      cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.01,
    };
    await recordReviewRun(env, run, [sub]);

    const result = await queryCosts(env, { sinceDays: 1, by: 'repo' });
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 13.2: Run (skipped by default)**

Run: `pnpm test -- tests/integration/persistence.int.test.ts`
Expected: 1 test, skipped (no env vars set).

- [ ] **Step 13.3: Commit**

```bash
git add tests/integration/persistence.int.test.ts
git commit -m "test(persist): opt-in supabase integration test"
```

---

### Task 14: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 14.1: Append the two new vars**

Append to `.env.example`:

```bash

# --- Optional: cost tracking via Supabase ---------------------------------
# Set both to persist per-review cost + token usage to a self-hosted Supabase
# project. Bootstrap with `./wrily persistence init`. Leave blank to disable.
# SUPABASE_URL=https://abc.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

- [ ] **Step 14.2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
```

---

### Task 15: Update `docs/self-hosting.md` and `README.md`

**Files:**
- Modify: `docs/self-hosting.md`
- Modify: `README.md`

- [ ] **Step 15.1: Add the cost-tracking section to `docs/self-hosting.md`**

Append a new top-level section near the end of `docs/self-hosting.md`:

```markdown
## Optional: cost tracking

Wrily can persist per-review token + USD cost to a self-hosted Supabase project.
Reviews still work without this enabled — it's purely additive.

### Prerequisites

- The official `supabase` CLI: `brew install supabase/tap/supabase` or `npm i -g supabase`.

### One-shot bootstrap

```bash
./wrily persistence init
```

This walks you through:

1. Logging in to Supabase (browser flow on first run).
2. Picking an org and naming the project (defaults are sensible).
3. Creating the project + waiting for it to become healthy (1–3 min).
4. Writing `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to your fork's `.env`.
5. Applying the schema (`supabase/migrations/*.sql`).

### Day-to-day

```bash
./wrily costs                          # last 30d totals, top repos
./wrily costs --since 7d --by model    # last 7d, grouped by model
./wrily persistence status             # check enabled + row counts
./wrily persistence migrate            # re-apply pending migrations
```

### What gets stored

- Per-run: repo, PR, commit, model, mode, scope, status, duration, findings posted, token usage, USD cost.
- Per-subagent (team mode): the same usage breakdown per parallel reviewer.

Nothing else — no PR content, no findings text, no commit diffs.

### Failure modes

If Supabase is unreachable, the review still ships; the cost row is dropped
after two retries and a structured warning lands in the workflow logs.
```

- [ ] **Step 15.2: Add a one-line README hook**

In `README.md`, near the existing self-hosting paragraph, add a single line:

```markdown
- *(Optional)* Persist per-review cost to a self-hosted Supabase project — see [Optional: cost tracking](docs/self-hosting.md#optional-cost-tracking).
```

- [ ] **Step 15.3: Commit**

```bash
git add docs/self-hosting.md README.md
git commit -m "docs: cost tracking section + README hook"
```

---

### Task 16: Final verification

- [ ] **Step 16.1: Full test suite**

Run: `pnpm test`
Expected: all green; integration test skipped.

- [ ] **Step 16.2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 16.3: Build**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 16.4: Smoke the CLI surface**

Run:
```bash
./wrily --help | grep -E 'costs|persistence'
./wrily persistence status
```
Expected: help shows the new subcommands; `status` reports `disabled` (assuming `.env` has no Supabase vars).

- [ ] **Step 16.5: Final commit (if any uncommitted leftovers)**

```bash
git status
# If clean, no-op. If anything is left (e.g. dist artifacts), .gitignore should cover them.
```

---

## Out of scope reminder

These are intentionally not in this plan and live in
`docs/superpowers/specs/2026-05-18-supabase-cost-tracking-design.md`:

- RLS / multi-tenant / hosted shared collector.
- Per-finding cost attribution.
- Realtime dashboards / budget-breach webhooks.
- Cost data for the Cloudflare Worker itself.
- Changes to the existing `max_budget_usd` per-review ceiling.

## Open follow-ups (post-merge)

- When team-mode actually spawns parallel agents (currently a single call), update `persistUsageStep` to map per-role indices to `'correctness' | 'conventions' | 'contracts' | 'spec-compliance' | 'unifier'` instead of `team-${idx}`.
- Add `pnpm test` to PR CI (separately tracked in `docs/followups.md`); persistence unit tests will run automatically once that job exists.
