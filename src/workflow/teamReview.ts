import type { AgentRunner, AgentResult } from '../agent/runner.js';
import type { WorkflowState } from './state.js';
import { renderUnifyPrompt } from '../prompt/render.js';
import { composeTeam, buildReviewerSystemPrompt, type TeamRole } from './teamRoles.js';
import { buildUnifyPromptContext } from './reviewContext.js';

/**
 * Run a team review: compose a reviewer roster from the changed files, fan the
 * reviewers out in parallel (each on the shared review body plus a guarded role
 * persona), then merge the survivors with one unify pass.
 *
 * Returns `[...reviewerResults, unifyResult]` — the unify result (last) holds the
 * final, postable JSON fence; the earlier entries are the individual reviewer
 * outputs (kept for cost persistence).
 *
 * Resilient by design: a reviewer that fails (provider error, its budget slice,
 * a timeout) is dropped and the survivors are unified; the review fails only if
 * every reviewer fails, re-throwing the first failure so its error type
 * (AgentTimeoutError / AgentBudgetExceededError) drives the failure comment.
 */
export async function runTeamReview(
  runner: AgentRunner,
  state: WorkflowState,
): Promise<AgentResult[]> {
  const workingDir = state.repoPath ?? '/tmp/repo';
  const roles = composeTeam(state.diffFiles ?? []);
  // The $15 team default is the *total* ceiling, split across the N reviewer
  // sessions + the unify session so summed cost stays within budget.
  const totalBudget = state.cfg.max_budget_usd ?? 15;
  const perCallBudget = totalBudget / (roles.length + 1);

  // Fan out in parallel; the await is the barrier. allSettled (not all) so one
  // reviewer failing drops only that reviewer rather than the whole review.
  const settled = await Promise.allSettled(
    roles.map((role) =>
      runner.run({
        prompt: state.renderedPrompt!,
        systemPrompt: buildReviewerSystemPrompt(role),
        model: state.cfg.model,
        maxBudgetUsd: perCallBudget,
        workingDir,
        env: process.env,
      }),
    ),
  );

  const reviewerResults: AgentResult[] = [];
  const survivingRoles: TeamRole[] = [];
  for (const [i, outcome] of settled.entries()) {
    const role = roles[i]!;
    if (outcome.status === 'fulfilled') {
      reviewerResults.push(outcome.value);
      survivingRoles.push(role);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.warn(`[teamReview] reviewer "${role}" failed, dropping from unify: ${reason}`);
    }
  }

  if (reviewerResults.length === 0) {
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    throw rejected ? rejected.reason : new Error('all team reviewers failed');
  }

  const reviewerReports = reviewerResults
    .map((r, i) => `### Reviewer ${i + 1}: ${survivingRoles[i] ?? 'reviewer'}\n\n${r.stdout}`)
    .join('\n\n');

  const unifyResult = await runner.run({
    prompt: renderUnifyPrompt(buildUnifyPromptContext(state, reviewerReports, reviewerResults.length)),
    model: state.cfg.model,
    maxBudgetUsd: perCallBudget,
    workingDir,
    env: process.env,
  });

  return [...reviewerResults, unifyResult];
}
