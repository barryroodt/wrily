import { REVIEW_PROMPT_TEMPLATE, UNIFY_REVIEW_PROMPT_TEMPLATE } from './templates.js';

// NOTE: `postInstruction` is intentionally absent — the agent no longer produces
// the review body. The workflow renders + posts; the agent emits JSON only.
export type PromptContext = {
  prNumber: number;
  githubRepository: string;
  diffRange: string;
  diffCommandInstruction: string;
  ignorePatterns: string;
  sharedContextInstruction: string;
  styleInstruction: string;
  sensitivityInstruction: string;
  deltaCleanInstruction: string;
  resolveThreadsInstruction: string;
  confidenceInstruction: string;
  priorFeedbackInstruction: string;
  triggerContextInstruction: string;
  reviewTypeNote: string;
};

/** Context for the team-mode unify pass that merges reviewer reports. */
export type UnifyPromptContext = {
  prNumber: number;
  githubRepository: string;
  reviewerCount: number;
  reviewerReports: string;
  styleInstruction: string;
  sensitivityInstruction: string;
  deltaCleanInstruction: string;
  resolveThreadsInstruction: string;
  confidenceInstruction: string;
  reviewTypeNote: string;
};

function applyTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${placeholder}}}`, value);
  }
  // Defensive: any remaining {{...}} placeholders are bugs (a value was not mapped).
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unsubstituted placeholders remain: ${leftover.join(', ')}`);
  }
  return out;
}

/**
 * Render the review prompt body. Used both for single-mode reviews and, in team
 * mode, as the shared base body for every reviewer (each reviewer layers its
 * role persona on top via the runner's `systemPrompt`).
 */
export function renderReviewPrompt(ctx: PromptContext): string {
  return applyTemplate(REVIEW_PROMPT_TEMPLATE, {
    PR_NUMBER: String(ctx.prNumber),
    GITHUB_REPOSITORY: ctx.githubRepository,
    DIFF_RANGE: ctx.diffRange,
    DIFF_COMMAND_INSTRUCTION: ctx.diffCommandInstruction,
    IGNORE_PATTERNS: ctx.ignorePatterns,
    SHARED_CONTEXT_INSTRUCTION: ctx.sharedContextInstruction,
    STYLE_INSTRUCTION: ctx.styleInstruction,
    SENSITIVITY_INSTRUCTION: ctx.sensitivityInstruction,
    DELTA_CLEAN_INSTRUCTION: ctx.deltaCleanInstruction,
    RESOLVE_THREADS_INSTRUCTION: ctx.resolveThreadsInstruction,
    CONFIDENCE_INSTRUCTION: ctx.confidenceInstruction,
    PRIOR_FEEDBACK_INSTRUCTION: ctx.priorFeedbackInstruction,
    TRIGGER_CONTEXT_INSTRUCTION: ctx.triggerContextInstruction,
    REVIEW_TYPE_NOTE: ctx.reviewTypeNote,
  });
}

/** Render the team-mode unify prompt that consolidates reviewer reports. */
export function renderUnifyPrompt(ctx: UnifyPromptContext): string {
  return applyTemplate(UNIFY_REVIEW_PROMPT_TEMPLATE, {
    PR_NUMBER: String(ctx.prNumber),
    GITHUB_REPOSITORY: ctx.githubRepository,
    REVIEWER_COUNT: String(ctx.reviewerCount),
    REVIEWER_REPORTS: ctx.reviewerReports,
    STYLE_INSTRUCTION: ctx.styleInstruction,
    SENSITIVITY_INSTRUCTION: ctx.sensitivityInstruction,
    DELTA_CLEAN_INSTRUCTION: ctx.deltaCleanInstruction,
    RESOLVE_THREADS_INSTRUCTION: ctx.resolveThreadsInstruction,
    CONFIDENCE_INSTRUCTION: ctx.confidenceInstruction,
    REVIEW_TYPE_NOTE: ctx.reviewTypeNote,
  });
}
