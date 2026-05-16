import { REVIEW_PROMPT_TEMPLATE, TEAM_REVIEW_PROMPT_TEMPLATE } from './templates.js';
import type { ReviewMode } from '../config/types.js';

// NOTE: `postInstruction` is intentionally absent — Claude no longer produces
// the review body. The workflow renders + posts; Claude emits JSON only.
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
  reviewMode: ReviewMode;
};

const PLACEHOLDER_MAP: Record<string, keyof PromptContext> = {
  PR_NUMBER: 'prNumber',
  GITHUB_REPOSITORY: 'githubRepository',
  DIFF_RANGE: 'diffRange',
  DIFF_COMMAND_INSTRUCTION: 'diffCommandInstruction',
  IGNORE_PATTERNS: 'ignorePatterns',
  SHARED_CONTEXT_INSTRUCTION: 'sharedContextInstruction',
  STYLE_INSTRUCTION: 'styleInstruction',
  SENSITIVITY_INSTRUCTION: 'sensitivityInstruction',
  DELTA_CLEAN_INSTRUCTION: 'deltaCleanInstruction',
  RESOLVE_THREADS_INSTRUCTION: 'resolveThreadsInstruction',
  CONFIDENCE_INSTRUCTION: 'confidenceInstruction',
  PRIOR_FEEDBACK_INSTRUCTION: 'priorFeedbackInstruction',
  TRIGGER_CONTEXT_INSTRUCTION: 'triggerContextInstruction',
  REVIEW_TYPE_NOTE: 'reviewTypeNote',
};

export function renderReviewPrompt(ctx: PromptContext): string {
  const template = ctx.reviewMode === 'team'
    ? TEAM_REVIEW_PROMPT_TEMPLATE
    : REVIEW_PROMPT_TEMPLATE;

  let out = template;
  for (const [placeholder, key] of Object.entries(PLACEHOLDER_MAP)) {
    const value = ctx[key];
    if (value === undefined || value === null) {
      throw new Error(`Prompt context missing required field: ${key}`);
    }
    out = out.replaceAll(`{{${placeholder}}}`, String(value));
  }

  // Defensive: any remaining {{...}} placeholders are bugs.
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unsubstituted placeholders remain: ${leftover.join(', ')}`);
  }

  return out;
}
