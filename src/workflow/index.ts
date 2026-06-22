import { createWorkflow } from '@mastra/core/workflows';
import { makeSteps, workflowStateSchema, type WorkflowDeps } from './steps.js';
import type { WorkflowState } from './state.js';

export function buildReviewWorkflow(deps: WorkflowDeps) {
  const steps = makeSteps(deps);

  return createWorkflow({
    id: 'wrily-review',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
  })
    .then(steps.cloneRepoStep)
    .then(steps.loadConfigStep)
    .then(steps.cloneSharedStep)
    .then(steps.stageSkillsStep)
    .then(steps.fetchDigestStep)
    .then(steps.resolveReviewStep)
    .then(steps.renderPromptStep)
    .then(steps.agentCallStep)
    .then(steps.extractFindingsStep)
    .then(steps.routeFindingsStep)
    // Persist cost BEFORE the external post call so we keep the cost row
    // even when the post step fails (stale commit SHA, GitHub 422, etc.).
    .then(steps.persistUsageStep)
    .then(steps.postToGitHubStep)
    .then(steps.resolveAddressedThreadsStep)
    .commit();
}

export type { WorkflowDeps };
export type { WorkflowState };
