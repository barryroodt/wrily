/**
 * Typed errors thrown by agent runners, lifted out of any specific runner
 * implementation so callers in `src/post/` and `src/persist/` can react to them
 * without importing a runner module.
 *
 * `persist/failure.ts` matches on `err.name` (string) to survive wrapping by
 * the workflow engine; `post/failureFallback.ts` matches on `instanceof` and
 * branches the failure comment by error kind. Keep `name` literals and
 * constructor signatures stable — both are part of the cross-module contract.
 */

/**
 * Thrown when an agent run is aborted because it exceeded its configured
 * timeout. Distinguishes a forced abort from an organic failure so the outer
 * workflow can post a timeout-specific failure comment.
 */
export class AgentTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`agent run timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Thrown when an agent run is aborted because its accumulated token usage
 * exceeded `maxTokens`. The budget unit is tokens end-to-end — no USD ever
 * reaches the subprocess — so the message says tokens. Distinguishes budget
 * exhaustion from a generic failure so the outer workflow can post a
 * budget-specific failure comment.
 */
export class AgentBudgetExceededError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('agent run exceeded token budget');
    this.name = 'AgentBudgetExceededError';
  }
}

/**
 * Thrown when a gantry run exits `rate_limited` (exit 5) and the bounded
 * backoff-retry is exhausted — either the max attempt count or the remaining
 * timeout budget is reached. Mirrors the other runner errors' shape
 * (`stdout`/`stderr` for the failure comment) and adds the provider's last
 * `retry_after_ms` hint. `persist/failure.ts` has no dedicated branch, so
 * `classifyFailure` falls through to `'failed'` (a dedicated status is a
 * follow-up); keep the `name` literal and constructor signature stable.
 */
export class AgentRateLimitedError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`agent run rate-limited; retry budget exhausted (last hint ${retryAfterMs}ms)`);
    this.name = 'AgentRateLimitedError';
  }
}
