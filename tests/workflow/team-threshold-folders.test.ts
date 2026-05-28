import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{ "summary": "ok", "findings": [], "strengths": [] }
\`\`\``;

const emptyDigestPage = {
  repository: {
    pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    },
  },
};

const baseEnv = {
  authMethod: 'oauth' as const, anthropicApiKey: null, claudeCodeOauthToken: 'sk-ant-oat01-x',
  githubToken: 'gho_x', prNumber: 1, githubRepository: 'org/repo',
  baseBranch: 'main', commitSha: 'abc', sharedRepo: 'your-org/shared-wrily-skills', sharedToken: '',
  wrilyBotLogin: 'wrily', reviewRoundIndex: 0, scopeOverride: '' as const,
  modeOverride: '' as const, modelOverride: '', maxBudgetOverride: null, dryRun: true,
  prAuthorLogin: 'human-dev', triggerSource: 'push', actor: 'human-dev',
  replyFeedbackOverride: '' as const,
};

const baseCfg = {
  model: 'opus', max_budget_usd: null, ignore: [], shared_skills: [], request_changes: false,
  style: 'terse' as const, sensitivity: 'minor' as const, reply_feedback: 'off' as const,
};

const fakeOctokit = { rest: { pulls: { createReview: () => ({ data: { id: 1 } }), createReviewComment: () => ({}), createReplyForReviewComment: () => ({}) }, checks: { create: () => ({}), update: () => ({}) } } } as any;
const fakeGraphql = { graphql: async () => emptyDigestPage };

async function runWorkflow(initial: WorkflowState): Promise<WorkflowState> {
  const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
  const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
  const run = await workflow.createRun();
  const result = await run.start({ inputData: initial });
  if (result.status !== 'success') throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
  return result.result as unknown as WorkflowState;
}

describe('workflow / team_threshold_unit', () => {
  it('folders unit: auto-flips to team when distinct parent dirs ≥ threshold', async () => {
    const final = await runWorkflow({
      env: baseEnv,
      cfg: { ...baseCfg, mode: 'auto', team_threshold: 3, team_threshold_unit: 'folders' },
      diffFiles: ['src/api/x.ts', 'src/api/y.ts', 'src/db/z.ts', 'scripts/run.sh'],
      repoPath: process.cwd(),
    });
    expect(final.reviewMode).toBe('team');
  });

  it('files unit: stays in single mode when only 2 files changed', async () => {
    const final = await runWorkflow({
      env: baseEnv,
      cfg: { ...baseCfg, mode: 'auto', team_threshold: 3, team_threshold_unit: 'files' },
      diffFiles: ['src/api/x.ts', 'src/api/y.ts'],
      repoPath: process.cwd(),
    });
    expect(final.reviewMode).toBe('single');
  });
});
