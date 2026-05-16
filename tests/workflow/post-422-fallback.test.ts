import { describe, it, expect, vi } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{
  "summary": "two findings — one path is bad",
  "findings": [
    { "action": "new_comment", "severity": "important", "path": "good.ts", "line": 1, "side": "RIGHT", "message": "ok" },
    { "action": "new_comment", "severity": "important", "path": "bad.ts",  "line": 1, "side": "RIGHT", "message": "will-422" }
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

describe('workflow / 422 per-comment fallback', () => {
  it('strips comments, retries body, posts each comment standalone — preserves mixed outcomes', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
    const err422 = Object.assign(new Error('Unprocessable'), { status: 422 });

    let createReviewCalls = 0;
    const createReview = vi.fn().mockImplementation(async (args: any) => {
      createReviewCalls++;
      if (createReviewCalls === 1 && args.comments?.length) throw err422;
      return { data: { id: 1 } };
    });
    const createReviewComment = vi.fn().mockImplementation(async (args: any) => {
      if (args.path === 'bad.ts') throw err422;
      return { data: { id: 99 } };
    });

    const fakeOctokit = {
      rest: {
        pulls: {
          createReview,
          createReviewComment,
          createReplyForReviewComment: vi.fn(),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
        },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: {
        authMethod: 'oauth', anthropicApiKey: null, claudeCodeOauthToken: 'sk-ant-oat01-x',
        githubToken: 'gho_x', prNumber: 1, githubRepository: 'org/repo',
        baseBranch: 'main', commitSha: 'abc', sharedRepo: 'your-org/shared-wrily-skills', sharedToken: '',
        wrilyBotLogin: 'wrily', reviewRoundIndex: 0, scopeOverride: '',
        modeOverride: '', replyFeedbackOverride: '', modelOverride: '', maxBudgetOverride: null, dryRun: false,
        prAuthorLogin: 'human-dev', triggerSource: 'push', actor: 'human-dev',
      },
      cfg: {
        model: 'opus', mode: 'single', team_threshold: 5, team_threshold_unit: 'files',
        max_budget_usd: null, ignore: [], shared_skills: [], request_changes: false,
        style: 'terse', sensitivity: 'minor', reply_feedback: 'off',
      },
      diffFiles: ['good.ts', 'bad.ts'],
      repoPath: process.cwd(),
    };

    const run = workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(createReviewCalls).toBe(2);
    expect(createReviewComment).toHaveBeenCalledTimes(2);
    expect(final.fallbackUsed).toBe(true);
    expect(final.failedComments).toEqual([{ path: 'bad.ts', line: 1, side: 'RIGHT' }]);
  });
});
