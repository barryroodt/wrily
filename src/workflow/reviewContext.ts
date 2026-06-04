import type { WorkflowState } from './state.js';
import type { PromptContext, UnifyPromptContext } from '../prompt/render.js';
import {
  styleInstruction,
  sensitivityInstruction,
  deltaCleanInstruction,
  resolveThreadsInstruction,
  confidenceInstruction,
  priorFeedbackInstruction,
  triggerContextInstruction,
} from '../prompt/instructions.js';

/**
 * Maps `WorkflowState` to the prompt contexts the agent prompts need. Single
 * source of truth for the instruction strings shared by the review body and the
 * team unify prompt, so the two can never drift.
 *
 * `diffRange` / `reviewType` are non-null by workflow ordering: resolveReview
 * populates them before renderPrompt and agentCall run.
 */

/** Instruction strings common to the review-body prompt and the unify prompt. */
function commonInstructions(state: WorkflowState) {
  return {
    prNumber: state.env.prNumber,
    githubRepository: state.env.githubRepository,
    styleInstruction: styleInstruction(state.cfg.style),
    sensitivityInstruction: sensitivityInstruction(state.cfg.sensitivity),
    deltaCleanInstruction: deltaCleanInstruction(state.reviewType!),
    resolveThreadsInstruction: resolveThreadsInstruction(
      state.cfg.reply_feedback,
      state.priorFeedbackDigestPath ?? '',
    ),
    confidenceInstruction: confidenceInstruction(state.reviewRoundIndex ?? state.env.reviewRoundIndex),
    reviewTypeNote: state.reviewType === 'delta' ? 'Delta review.' : 'Full review.',
  };
}

/** Build the review-body prompt context (single mode and each team reviewer). */
export function buildReviewPromptContext(state: WorkflowState): PromptContext {
  const diffFiles = state.diffFiles ?? [];
  const diffPathFilter = diffFiles.length > 0 ? ` -- ${diffFiles.join(' ')}` : '';
  const diffCommandInstruction =
    state.reviewType === 'delta'
      ? [
          'This is a DELTA review — only review changes the author made since the last reviewed commit.',
          '',
          '```bash',
          `git diff ${state.diffRange}${diffPathFilter}`,
          '```',
        ].join('\n')
      : [
          'Get the full diff of this PR:',
          '',
          '```bash',
          `git diff ${state.diffRange}`,
          '```',
        ].join('\n');

  return {
    ...commonInstructions(state),
    diffRange: state.diffRange!,
    diffCommandInstruction,
    ignorePatterns: state.cfg.ignore.length ? state.cfg.ignore.join(', ') : '(none configured)',
    sharedContextInstruction: '',
    priorFeedbackInstruction: priorFeedbackInstruction(
      state.cfg.reply_feedback,
      state.priorFeedbackDigestPath ?? '',
    ),
    triggerContextInstruction: triggerContextInstruction(state.env.triggerSource, state.env.actor),
  };
}

/** Build the team unify prompt context from the consolidated reviewer reports. */
export function buildUnifyPromptContext(
  state: WorkflowState,
  reviewerReports: string,
  reviewerCount: number,
): UnifyPromptContext {
  return { ...commonInstructions(state), reviewerReports, reviewerCount };
}
