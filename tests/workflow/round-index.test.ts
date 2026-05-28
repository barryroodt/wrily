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

function digestPageWithReviews(bodies: string[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [] },
        reviews: { nodes: bodies.map((body) => ({ body })) },
      },
    },
  };
}

const emptyDigestPage = digestPageWithReviews([]);

function baseEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    authMethod: 'oauth',
    anthropicApiKey: null,
    claudeOauthToken: 'sk-ant-oat01-x',
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

describe('workflow / reviewRoundIndex', () => {
  it('0 prior reviews → reviewRoundIndex=1', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv(),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      emptyDigestPage,
    );
    expect(final.reviewRoundIndex).toBe(1);
  });

  it('3 prior reviews → reviewRoundIndex=4', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv(),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      digestPageWithReviews([
        'r1 wrily-review-handoff',
        'r2 wrily-review-handoff',
        'r3 wrily-review-handoff',
      ]),
    );
    expect(final.reviewRoundIndex).toBe(4);
  });

  it('7 prior reviews → reviewRoundIndex capped at 5', async () => {
    const bodies = Array.from({ length: 7 }, (_, i) => `r${i} wrily-review-handoff`);
    const final = await runWorkflow(
      {
        env: baseEnv(),
        cfg: baseCfg(),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      digestPageWithReviews(bodies),
    );
    expect(final.reviewRoundIndex).toBe(5);
  });

  it('reply_feedback off (null digest) → reviewRoundIndex undefined, falls back to env value', async () => {
    const final = await runWorkflow(
      {
        env: baseEnv({ reviewRoundIndex: 2 }),
        cfg: baseCfg({ reply_feedback: 'off' }),
        diffFiles: ['a.ts'],
        repoPath: process.cwd(),
      },
      emptyDigestPage,
    );
    // reply_feedback: off → fetchDigestStep sets priorFeedback to null
    expect(final.priorFeedback).toBeNull();
    // resolveReviewStep leaves reviewRoundIndex undefined when no digest;
    // renderPromptStep then falls back to env.reviewRoundIndex (2).
    expect(final.reviewRoundIndex).toBeUndefined();
    expect(final.env.reviewRoundIndex).toBe(2);
  });
});
