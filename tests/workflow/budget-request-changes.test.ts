import { describe, expect, it, vi } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const EMPTY_REPLY = `\`\`\`json
{ "summary": "ok", "findings": [], "strengths": [] }
\`\`\``;

const CRITICAL_REPLY = `\`\`\`json
{
  "summary": "critical issue",
  "findings": [
    { "action": "new_comment", "severity": "critical", "path": "src/x.ts", "line": 5, "side": "RIGHT", "message": "Unsafe path. Guard it." }
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

function baseEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    authMethod: 'oauth',
    anthropicApiKey: null,
    claudeCodeOauthToken: 'sk-ant-oat01-x',
    githubToken: 'gho_x',
    prNumber: 42,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'abc1234',
    sharedRepo: 'your-org/shared-wrily-skills',
    sharedToken: '',
    wrilyBotLogin: 'wrily',
    reviewRoundIndex: 0,
    scopeOverride: '',
    modeOverride: '',
    modelOverride: '',
    maxBudgetOverride: null,
    dryRun: true,
    prAuthorLogin: 'human-dev',
    triggerSource: 'push',
    actor: 'human-dev',
    replyFeedbackOverride: '',
    ...overrides,
  };
}

function baseCfg(overrides: Partial<WrilyConfig> = {}): WrilyConfig {
  return {
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
    ...overrides,
  };
}

async function runWorkflow(
  initial: WorkflowState,
  stdout = EMPTY_REPLY,
  octokit: any = { rest: {} },
): Promise<{ final: WorkflowState; agentRunner: FakeAgentRunner }> {
  const agentRunner = new FakeAgentRunner({
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    tokenUsage: null,
  });
  const workflow = buildReviewWorkflow({
    agentRunner,
    octokit,
    graphqlClient: { graphql: async () => emptyDigestPage },
  });
  const result = await workflow.createRun().start({ inputData: initial });
  if (result.status !== 'success') {
    throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
  }
  return { final: result.result as unknown as WorkflowState, agentRunner };
}

describe('workflow / budget defaults and request_changes', () => {
  it('applies the default budget cap for single mode when max_budget_usd is unset', async () => {
    const { agentRunner } = await runWorkflow({
      env: baseEnv(),
      cfg: baseCfg({ mode: 'single', max_budget_usd: null }),
      repoPath: process.cwd(),
      diffFiles: ['src/x.ts'],
    });

    expect(agentRunner.calls[0]?.maxBudgetUsd).toBe(5);
  });

  it('applies the default budget cap for team mode when max_budget_usd is unset', async () => {
    const { agentRunner } = await runWorkflow({
      env: baseEnv(),
      cfg: baseCfg({ mode: 'team', max_budget_usd: null }),
      repoPath: process.cwd(),
      diffFiles: ['src/x.ts'],
    });

    expect(agentRunner.calls[0]?.maxBudgetUsd).toBe(15);
  });

  it('posts REQUEST_CHANGES for critical findings when request_changes is enabled', async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 123 } });
    const octokit = {
      rest: {
        pulls: {
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          createReview,
          createReviewComment: vi.fn(),
          createReplyForReviewComment: vi.fn(),
        },
      },
    };

    await runWorkflow(
      {
        env: baseEnv({ dryRun: false }),
        cfg: baseCfg({ request_changes: true }),
        repoPath: process.cwd(),
        diffFiles: ['src/x.ts'],
      },
      CRITICAL_REPLY,
      octokit,
    );

    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({ event: 'REQUEST_CHANGES' }));
  });
});
