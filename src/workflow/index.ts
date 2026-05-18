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
    .then(steps.bridgeSkillsStep)
    .then(steps.fetchDigestStep)
    .then(steps.resolveReviewStep)
    .then(steps.renderPromptStep)
    .then(steps.agentCallStep)
    .then(steps.extractFindingsStep)
    .then(steps.routeFindingsStep)
    .then(steps.postToGitHubStep)
    .then(steps.resolveAddressedThreadsStep)
    .then(steps.persistUsageStep)
    .commit();
}

export type { WorkflowDeps };
export type { WorkflowState };
