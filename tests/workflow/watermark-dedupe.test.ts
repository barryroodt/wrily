import { describe, it, expect, vi } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{
  "summary": "one finding",
  "findings": [
    { "action": "new_comment", "severity": "important", "path": "src/x.ts", "line": 5, "side": "RIGHT", "message": "x — try y" }
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

const COMMIT_SHA = 'abc1234567890deadbeefcafe0000000000000000';

const baseEnv = {
  anthropicApiKey: null,
  githubToken: 'gho_x',
  prNumber: 1,
  githubRepository: 'org/repo',
  baseBranch: 'main',
  commitSha: COMMIT_SHA,
  sharedRepo: 'your-org/shared-wrily-skills',
  sharedToken: '',
  wrilyBotLogin: 'wrily',
  reviewRoundIndex: 0,
  scopeOverride: '' as const,
  modeOverride: '' as const,
  modelOverride: '',
  allowUnknownModel: false,
  dryRun: false,
  prAuthorLogin: 'human-dev',
  triggerSource: 'push' as const,
  actor: 'human-dev',
  replyFeedbackOverride: '' as const,
};

const baseCfg = {
  model: 'opus',
  mode: 'single' as const,
  team_threshold: 5,
  team_threshold_unit: 'files' as const,
  max_tokens: null,
  ignore: [],
  shared_skills: [],
  request_changes: false,
  style: 'terse' as const,
  sensitivity: 'minor' as const,
  reply_feedback: 'off' as const,
};

function buildInitialState(envOverrides: Record<string, unknown> = {}): WorkflowState {
  return {
    env: { ...baseEnv, ...envOverrides } as WorkflowState['env'],
    cfg: baseCfg,
    diffFiles: ['src/x.ts'],
    repoPath: process.cwd(),
  };
}

describe('workflow / watermark dedupe', () => {
  it('skips POST when a review with matching commit watermark already exists', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const existingReviewId = 555;
    const listReviews = vi.fn().mockResolvedValue({
      data: [
        { id: 111, body: 'some other review without marker' },
        { id: existingReviewId, body: `Looks good\n<!-- auto-reviewer: commit=${COMMIT_SHA}, mode=single, type=full, base=xyz -->` },
      ],
    });
    const createReview = vi.fn().mockResolvedValue({ data: { id: 999 } });
    const createReviewComment = vi.fn();

    const fakeOctokit = {
      rest: {
        pulls: { createReview, createReviewComment, createReplyForReviewComment: vi.fn(), listReviews },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const run = await workflow.createRun();
    const result = await run.start({ inputData: buildInitialState() });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(listReviews).toHaveBeenCalledTimes(1);
    expect(createReview).not.toHaveBeenCalled();
    expect(createReviewComment).not.toHaveBeenCalled();
    expect(final.alreadyPosted).toBe(true);
    expect(final.postedReviewId).toBe(existingReviewId);
    expect(final.fallbackUsed).toBe(false);
    expect(final.failedComments).toEqual([]);
  });

  it('proceeds with POST when existing reviews have different or missing watermarks', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const listReviews = vi.fn().mockResolvedValue({
      data: [
        { id: 1, body: 'plain text review, no watermark' },
        { id: 2, body: '<!-- auto-reviewer: commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef, mode=single, type=full -->' },
        { id: 3, body: null },
      ],
    });
    const createReview = vi.fn().mockResolvedValue({ data: { id: 999 } });
    const createReviewComment = vi.fn();

    const fakeOctokit = {
      rest: {
        pulls: { createReview, createReviewComment, createReplyForReviewComment: vi.fn(), listReviews },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const run = await workflow.createRun();
    const result = await run.start({ inputData: buildInitialState() });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(listReviews).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(final.alreadyPosted).toBeFalsy();
    expect(final.postedReviewId).toBe(999);
    expect(final.fallbackUsed).toBe(false);
  });

  it('proceeds with POST when listReviews throws (non-blocking)', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const err500 = Object.assign(new Error('GitHub down'), { status: 500 });
    const listReviews = vi.fn().mockRejectedValue(err500);
    const createReview = vi.fn().mockResolvedValue({ data: { id: 777 } });
    const createReviewComment = vi.fn();

    const fakeOctokit = {
      rest: {
        pulls: { createReview, createReviewComment, createReplyForReviewComment: vi.fn(), listReviews },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const run = await workflow.createRun();
    const result = await run.start({ inputData: buildInitialState() });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(listReviews).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(final.alreadyPosted).toBeFalsy();
    expect(final.postedReviewId).toBe(777);
  });

  it('SCOPE_OVERRIDE bypasses dedupe — posts even when matching watermark exists', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const listReviews = vi.fn().mockResolvedValue({
      data: [{ id: 4242, body: `<!-- auto-reviewer: commit=${COMMIT_SHA}, mode=single, type=delta -->` }],
    });
    const createReview = vi.fn().mockResolvedValue({ data: { id: 555 } });

    const fakeOctokit = {
      rest: {
        pulls: { createReview, createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const run = await workflow.createRun();
    const result = await run.start({ inputData: buildInitialState({ scopeOverride: 'full' }) });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(listReviews).not.toHaveBeenCalled();
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(final.alreadyPosted).toBeFalsy();
    expect(final.postedReviewId).toBe(555);
  });

  it('DRY_RUN=true short-circuits before dedupe — listReviews never called', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const listReviews = vi.fn();
    const createReview = vi.fn();
    const fakeOctokit = {
      rest: {
        pulls: { createReview, createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: async () => emptyDigestPage };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const run = await workflow.createRun();
    const result = await run.start({ inputData: buildInitialState({ dryRun: true }) });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(listReviews).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(final.alreadyPosted).toBeFalsy();
  });
});
