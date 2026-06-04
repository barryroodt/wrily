import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{
  "summary": "Looks fine.",
  "findings": [
    { "action": "new_comment", "severity": "important", "path": "src/x.ts", "line": 5, "side": "RIGHT", "message": "x — try y" }
  ],
  "strengths": ["clean code"]
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

describe('workflow / single mode happy path', () => {
  it('runs from fetchDigest through routeFindings', async () => {
    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 1000,
      tokenUsage: null,
    });
    const fakeOctokit = { rest: {} as any };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: {
        anthropicApiKey: null,
        githubToken: 'gho_x',
        prNumber: 1,
        githubRepository: 'org/repo',
        baseBranch: 'main',
        commitSha: 'abc1234',
        sharedRepo: 'your-org/shared-wrily-skills',
        sharedToken: '',
        wrilyBotLogin: 'wrily',
        reviewRoundIndex: 0,
        scopeOverride: '',
        modeOverride: '', replyFeedbackOverride: '',
        modelOverride: '',
        maxBudgetOverride: null,
        dryRun: true,
        prAuthorLogin: 'human-dev',
        triggerSource: 'push',
        actor: 'human-dev',
      },
      cfg: {
        model: 'opus',
        mode: 'single',
        team_threshold: 5,
        team_threshold_unit: 'files',
        max_budget_usd: null,
        ignore: [],
        shared_skills: [],
        request_changes: false,
        style: 'terse',
        sensitivity: 'minor',
        reply_feedback: 'off',
      },
      diffFiles: ['src/x.ts'],
      repoPath: process.cwd(),
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(final.findings).toHaveLength(1);
    expect(final.findings?.[0]?.severity).toBe('important');
    expect(final.actions).toHaveLength(1);
    expect(final.actions?.[0]?.action).toBe('new_comment');
  });
});
