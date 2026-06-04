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
 * Thrown when an agent run is aborted because accumulated cost exceeded
 * `maxBudgetUsd`. Distinguishes budget exhaustion from a generic failure so
 * the outer workflow can post a budget-specific failure comment.
 */
export class AgentBudgetExceededError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('agent run exceeded budget');
    this.name = 'AgentBudgetExceededError';
  }
}
