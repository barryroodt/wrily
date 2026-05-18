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
