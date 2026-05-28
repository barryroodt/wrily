import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';

const FAKE_REPLY = `\`\`\`json
{
  "summary": "ok",
  "findings": [],
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

const watermarkDigestPage = {
  repository: {
    pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [] },
      reviews: {
        nodes: [{ body: '<!-- auto-reviewer: commit=deadbee, status=clean -->\nwrily-review-handoff' }],
      },
    },
  },
};

function baseEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    authMethod: 'oauth',
    anthropicApiKey: null,
    claudeCodeOauthToken: 'sk-ant-oat01-x',
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
    reply_feedback: 'on',
    ...overrides,
  };
}

async function runWorkflow(initial: WorkflowState, digestPage: unknown) {
  const agentRunner = new FakeAgentRunner({
    stdout: FAKE_REPLY,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    tokenUsage: null,
  });
  const fakeOctokit = { rest: {} as any };
  const fakeGraphql = { graphql: async () => digestPage };
  const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
  const run = await workflow.createRun();
  const result = await run.start({ inputData: initial });
  if (result.status !== 'success') {
    throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
  }
  return result.result as unknown as WorkflowState;
}

describe('workflow / SCOPE_OVERRIDE', () => {
  it('full override forces full review even when watermark is present', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ scopeOverride: 'full' }),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      watermarkDigestPage,
    );
    expect(final.reviewType).toBe('full');
    expect(final.lastReviewedSha).toBeNull();
  });

  it('delta override with watermark uses delta', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ scopeOverride: 'delta' }),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      watermarkDigestPage,
    );
    expect(final.reviewType).toBe('delta');
    expect(final.lastReviewedSha).toBe('deadbee');
  });

  it('delta override with NO watermark falls back to full', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ scopeOverride: 'delta' }),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      emptyDigestPage,
    );
    expect(final.reviewType).toBe('full');
    expect(final.lastReviewedSha).toBeNull();
  });

  it('empty override preserves watermark-based behavior (watermark → delta)', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ scopeOverride: '' }),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      watermarkDigestPage,
    );
    expect(final.reviewType).toBe('delta');
    expect(final.lastReviewedSha).toBe('deadbee');
  });

  it('empty override + no watermark → full (default)', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ scopeOverride: '' }),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      emptyDigestPage,
    );
    expect(final.reviewType).toBe('full');
    expect(final.lastReviewedSha).toBeNull();
  });
});
