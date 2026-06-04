import type { Octokit } from '@octokit/rest';
import type { RuntimeEnv } from '../config/types.js';
import { AgentTimeoutError, AgentBudgetExceededError } from '../agent/pi.js';

/**
 * Records workflow-crash context to logs only. No GH comment is posted.
 *
 * Rationale: a failed review should not write an explanatory comment back to
 * the consumer PR — the `Wrily / review` check-run conclusion (set to
 * `failure` by the dispatching workflow) is the user-visible signal. Posting
 * a comment additionally clutters the PR with internal noise (schema dumps,
 * timeouts) that consumers cannot act on.
 *
 * - DRY_RUN: logs intended kind for parity with the prior posting behaviour.
 * - Non-DRY_RUN: logs the kind and error message, returns without writing.
 */
export async function maybePostFailure(
  env: RuntimeEnv,
  _octokit: Pick<Octokit, 'rest'>,
  err: Error,
): Promise<void> {
  const kind: 'timeout' | 'budget' | 'failure' =
    err instanceof AgentTimeoutError ? 'timeout'
    : err instanceof AgentBudgetExceededError ? 'budget'
    : 'failure';

  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'review failed — no PR comment posted (check-run conclusion is the signal)',
      kind,
      dryRun: env.dryRun,
      err: { name: err.name, message: err.message },
    }),
  );
}
