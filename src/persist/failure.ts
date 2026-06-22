import type { RuntimeEnv, WrilyConfig } from '../config/types.js';
import type { ReviewRunRecord } from './types.js';
import { isPersistenceEnabled, recordReviewRun } from './supabase.js';

export type FailureStatus = 'budget_exceeded' | 'timeout' | 'failed';

/**
 * Map a thrown error to a row status. The agent runner throws named
 * errors (`AgentBudgetExceededError`, `AgentTimeoutError`) that may be
 * wrapped by the workflow engine, so we match on `.name` rather than
 * `instanceof` to survive re-wrapping.
 */
export function classifyFailure(err: unknown): FailureStatus {
  if (err instanceof Error) {
    if (err.name === 'AgentBudgetExceededError') return 'budget_exceeded';
    if (err.name === 'AgentTimeoutError') return 'timeout';
    // Some wrappers stash the original under err.cause; check one level.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      if (cause.name === 'AgentBudgetExceededError') return 'budget_exceeded';
      if (cause.name === 'AgentTimeoutError') return 'timeout';
    }
  }
  return 'failed';
}

/**
 * Persist a row for a review that failed before the success-path
 * `persistUsageStep` could run. Best-effort and swallows its own errors
 * via `recordReviewRun`'s retry-then-fail-soft policy.
 *
 * `review_mode` and `scope` are unknown at hard-failure time (the
 * workflow may have failed before resolving them) — default to single /
 * full so the row is still queryable. Dashboards can filter on `status`
 * to isolate failures.
 */
export async function persistFailureRun(
  env: RuntimeEnv,
  cfg: WrilyConfig,
  err: unknown,
): Promise<void> {
  if (!isPersistenceEnabled(env)) return;
  const status = classifyFailure(err);
  const run: ReviewRunRecord = {
    github_repo: env.githubRepository,
    pr_number: env.prNumber,
    commit_sha: env.commitSha,
    trigger_source: env.triggerSource === 'local_cli' ? 'local_cli' : 'github_app',
    review_round: env.reviewRoundIndex,
    model: cfg.model,
    review_mode: 'single',
    scope: 'full',
    max_tokens: cfg.max_tokens ?? null,
    status,
    duration_ms: 0,
    findings_posted: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  };
  await recordReviewRun(env, run, []);
}
