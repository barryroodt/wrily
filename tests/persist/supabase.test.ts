import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPersistenceEnabled, recordReviewRun, queryCosts, aggregateRuns } from '../../src/persist/supabase.js';
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
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'r1' }]), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    await recordReviewRun(enabledEnv, run, subs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0]!;
    const [secondUrl] = fetchMock.mock.calls[1]!;
    expect(firstUrl).toMatch(/\/rest\/v1\/review_runs(\?|$)/);
    expect(secondUrl).toMatch(/\/rest\/v1\/review_subagent_runs(\?|$)/);
  });

  it('passes apikey + Authorization headers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: 'r1' }]), { status: 201 }));
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

describe('aggregateRuns', () => {
  const rows = [
    { inserted_at: '2026-05-18T10:00:00Z', github_repo: 'a/x', model: 'opus', review_mode: 'single' as const, cost_usd: 0.10, input_tokens: 100, output_tokens: 200 },
    { inserted_at: '2026-05-18T11:00:00Z', github_repo: 'a/x', model: 'opus', review_mode: 'team' as const, cost_usd: 0.20, input_tokens: 300, output_tokens: 400 },
    { inserted_at: '2026-05-17T12:00:00Z', github_repo: 'b/y', model: 'sonnet', review_mode: 'single' as const, cost_usd: 0.05, input_tokens: 50, output_tokens: 60 },
  ];

  it('groups by repo, sums cost + tokens, sorts by cost desc', () => {
    const out = aggregateRuns(rows, 'repo');
    expect(out).toEqual([
      { github_repo: 'a/x', runs: 2, cost_usd: 0.3, total_tokens: 1000 },
      { github_repo: 'b/y', runs: 1, cost_usd: 0.05, total_tokens: 110 },
    ]);
  });

  it('groups by model + review_mode, computes avg', () => {
    const out = aggregateRuns(rows, 'model');
    expect(out).toEqual([
      { model: 'opus', review_mode: 'team', runs: 1, cost_usd: 0.2, avg_cost_usd: 0.2 },
      { model: 'opus', review_mode: 'single', runs: 1, cost_usd: 0.1, avg_cost_usd: 0.1 },
      { model: 'sonnet', review_mode: 'single', runs: 1, cost_usd: 0.05, avg_cost_usd: 0.05 },
    ]);
  });

  it('groups by day (YYYY-MM-DD), sorts by day desc', () => {
    const out = aggregateRuns(rows, 'day');
    expect(out).toEqual([
      { day: '2026-05-18', runs: 2, cost_usd: 0.3, total_tokens: 1000 },
      { day: '2026-05-17', runs: 1, cost_usd: 0.05, total_tokens: 110 },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(aggregateRuns([], 'repo')).toEqual([]);
  });

  it('treats numeric strings (PostgREST numeric) the same as numbers', () => {
    const out = aggregateRuns(
      [{ inserted_at: '2026-05-18T10:00:00Z', github_repo: 'a/x', model: 'opus', review_mode: 'single' as const, cost_usd: '0.10' as unknown as number, input_tokens: '100' as unknown as number, output_tokens: '200' as unknown as number }],
      'repo',
    );
    expect(out[0]!.cost_usd).toBe(0.1);
    expect(out[0]!.total_tokens).toBe(300);
  });
});

describe('queryCosts validation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects --repo with --by model before any network call', async () => {
    await expect(
      queryCosts(enabledEnv, { sinceDays: 7, by: 'model', repo: 'a/x' }),
    ).rejects.toThrow(/--repo cannot be combined with --by model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors --since by filtering review_runs.inserted_at, not via 30d views', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await queryCosts(enabledEnv, { sinceDays: 7, by: 'repo' });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/rest\/v1\/review_runs\?/);
    expect(String(url)).toMatch(/inserted_at=gte\./);
    expect(String(url)).not.toMatch(/spend_by_repo_30d/);
  });

  it('appends github_repo filter when --repo is set', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await queryCosts(enabledEnv, { sinceDays: 1, by: 'repo', repo: 'owner/r' });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/github_repo=eq\.owner%2Fr|github_repo=eq\.owner\/r/);
  });
});
