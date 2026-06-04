import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{
  "summary": "ok",
  "findings": [
    { "action": "new_comment", "severity": "minor", "path": "a.ts", "line": 1, "side": "RIGHT", "message": "x" }
  ],
  "strengths": []
}
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

describe('workflow / DRY_RUN=true', () => {
  it('does not call any GH posting APIs (pre-postToGitHub stage)', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
    const fakeOctokit = {
      rest: {
        pulls: {
          createReview: () => { throw new Error('should not call'); },
          createReviewComment: () => { throw new Error('should not call'); },
          createReplyForReviewComment: () => { throw new Error('should not call'); },
        },
        checks: { update: () => { throw new Error('should not call'); }, create: () => { throw new Error('should not call'); } },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: {
        anthropicApiKey: null,
        githubToken: 'gho_x', prNumber: 1, githubRepository: 'org/repo',
        baseBranch: 'main', commitSha: 'abc', sharedRepo: 'your-org/shared-wrily-skills', sharedToken: '',
        wrilyBotLogin: 'wrily', reviewRoundIndex: 0, scopeOverride: '',
        modeOverride: '', replyFeedbackOverride: '', modelOverride: '', maxBudgetOverride: null, dryRun: true,
        prAuthorLogin: 'human-dev', triggerSource: 'push', actor: 'human-dev',
      },
      cfg: {
        model: 'opus', mode: 'single', team_threshold: 5, team_threshold_unit: 'files',
        max_budget_usd: null, ignore: [], shared_skills: [], request_changes: false,
        style: 'terse', sensitivity: 'minor', reply_feedback: 'off',
      },
      diffFiles: ['a.ts'],
      repoPath: process.cwd(),
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    const final = result.result as unknown as WorkflowState;
    expect(final.actions).toHaveLength(1);
    expect(final.actions?.[0]?.action).toBe('new_comment');
  });
});
