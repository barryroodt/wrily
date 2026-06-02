import type { RuntimeEnv, WrilyConfig, ReviewMode, ReviewType } from '../config/types.js';
import type { Finding, Review } from '../post/extract.js';
import type { PriorFeedbackDigest } from '../post/digest.js';
import type { RoutedAction, SuppressedAction } from '../post/route.js';
import type { AgentResult } from '../agent/runner.js';

export type WorkflowState = {
  // Set by main.ts before workflow start
  env: RuntimeEnv;
  cfg: WrilyConfig;

  // After cloneRepos
  repoPath?: string;
  sharedPath?: string | null;

  // After resolveReview
  reviewMode?: ReviewMode;
  reviewType?: ReviewType;
  diffRange?: string;
  lastReviewedSha?: string | null;
  diffFiles?: string[];
  /**
   * Computed by resolveReviewStep from `priorFeedback.priorReviewsCount + 1`,
   * capped at 5. Falls back to `env.reviewRoundIndex` when undefined (e.g.
   * when reply_feedback is off and there is no digest).
   */
  reviewRoundIndex?: number;

  // After loadSkills
  loadedSkills?: string[];

  // After fetchDigest
  priorFeedback?: PriorFeedbackDigest | null;
  digestFetchFailed?: boolean;
  priorFeedbackDigestPath?: string;

  // After renderPrompt
  renderedPrompt?: string;

  // After agentCall
  agentResults?: AgentResult[];
  /**
   * Index into `agentResults` of the result whose JSON fence holds the final,
   * postable review. Single mode: 0. Team mode: the unify result (last index);
   * the preceding entries are individual reviewer outputs consumed by unify.
   */
  findingsSourceIndex?: number;

  // After extractFindings
  reviews?: Review[];
  findings?: Finding[];

  // After routeFindings
  actions?: RoutedAction[];
  suppressedActions?: SuppressedAction[];

  // After postToGitHub
  reviewBodyMarkdown?: string;
  postedReviewId?: number;
  fallbackUsed?: boolean;
  failedComments?: { path: string; line: number; side: 'LEFT' | 'RIGHT' }[];
  alreadyPosted?: boolean;  // true when watermark dedupe skipped the POST
  checkRunId?: number;

  // After resolveAddressedThreads
  resolvedThreadIds?: string[];
  resolveThreadsFailed?: boolean;
};
