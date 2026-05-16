import { describe, it, expect, vi } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{ "summary": "no current findings", "findings": [], "strengths": [] }
\`\`\``;

const SUPPRESS_REPLY = `\`\`\`json
{ "summary": "Suppressions: 1 prior item suppressed.", "findings": [
  { "action": "suppress", "severity": "important", "path": "a.go", "line": 10, "side": "RIGHT", "message": "author response is valid", "thread_id": "PRT_addr" }
], "strengths": [] }
\`\`\``;

const RESOLVE_REPLY = `\`\`\`json
{ "summary": "Suppressions: 1 thread resolved.", "findings": [
  { "action": "resolve_thread", "severity": "important", "path": "a.go", "line": 10, "side": "RIGHT", "message": "current PR removed the unsafe path", "thread_id": "PRT_addr" }
], "strengths": [] }
\`\`\``;

const digestPageWithAddressedThread = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: [{
          id: 'PRT_addr',
          path: 'a.go',
          line: 10,
          diffSide: 'RIGHT',
          isResolved: false,
          comments: { nodes: [
            { databaseId: 1001, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'issue here' },
            { databaseId: 1002, author: { login: 'human-dev' },          authorAssociation: 'MEMBER',     body: 'fixed it' },
          ]},
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
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
  model: 'opus', mode: 'single' as const, team_threshold: 5, team_threshold_unit: 'files' as const,
  max_budget_usd: null, ignore: [], shared_skills: [], request_changes: false,
  style: 'terse' as const, sensitivity: 'minor' as const, reply_feedback: 'on' as const,
};

describe('workflow / resolveAddressedThreads', () => {
  it('does not call resolveReviewThread mutation for addressed-looking threads without explicit suppression', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const graphqlMock = vi.fn().mockImplementation(async (q: string) => {
      if (q.includes('resolveReviewThread')) {
        return { resolveReviewThread: { thread: { id: 'PRT_addr', isResolved: true } } };
      }
      return digestPageWithAddressedThread;
    });

    const fakeOctokit = {
      rest: {
        pulls: { createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }), createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews: vi.fn().mockResolvedValue({ data: [] }) },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: graphqlMock };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: { ...baseEnv, dryRun: false },
      cfg: baseCfg,
      diffFiles: ['a.go'],
      repoPath: process.cwd(),
    };

    const run = workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(final.resolvedThreadIds).toEqual([]);
    expect(final.resolveThreadsFailed).toBe(false);

    const mutationCalls = graphqlMock.mock.calls.filter((c) => String(c[0]).includes('resolveReviewThread'));
    expect(mutationCalls).toHaveLength(0);
  });

  it('does not call resolveReviewThread mutation when the model suppresses a prior thread', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: SUPPRESS_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const graphqlMock = vi.fn().mockImplementation(async (q: string) => {
      if (q.includes('resolveReviewThread')) {
        return { resolveReviewThread: { thread: { id: 'PRT_addr', isResolved: true } } };
      }
      return digestPageWithAddressedThread;
    });

    const fakeOctokit = {
      rest: {
        pulls: { createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }), createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews: vi.fn().mockResolvedValue({ data: [] }) },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: graphqlMock };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: { ...baseEnv, dryRun: false },
      cfg: baseCfg,
      diffFiles: ['a.go'],
      repoPath: process.cwd(),
    };

    const run = workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(final.resolvedThreadIds).toEqual([]);
    expect(final.resolveThreadsFailed).toBe(false);

    const mutationCalls = graphqlMock.mock.calls.filter((c) => String(c[0]).includes('resolveReviewThread'));
    expect(mutationCalls).toHaveLength(0);
  });

  it('calls resolveReviewThread mutation when the model explicitly emits resolve_thread', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: RESOLVE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

    const graphqlMock = vi.fn().mockImplementation(async (q: string) => {
      if (q.includes('resolveReviewThread')) {
        return { resolveReviewThread: { thread: { id: 'PRT_addr', isResolved: true } } };
      }
      return digestPageWithAddressedThread;
    });

    const fakeOctokit = {
      rest: {
        pulls: { createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }), createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews: vi.fn().mockResolvedValue({ data: [] }) },
        checks: { create: vi.fn(), update: vi.fn() },
      } as any,
    };
    const fakeGraphql = { graphql: graphqlMock };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: { ...baseEnv, dryRun: false },
      cfg: baseCfg,
      diffFiles: ['a.go'],
      repoPath: process.cwd(),
    };

    const run = workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(final.resolvedThreadIds).toEqual(['PRT_addr']);
    expect(final.resolveThreadsFailed).toBe(false);

    const mutationCalls = graphqlMock.mock.calls.filter((c) => String(c[0]).includes('resolveReviewThread'));
    expect(mutationCalls).toHaveLength(1);
  });

  it('fail-open: GraphQL mutation 5xx → resolvedThreadIds=[], workflow does not fail', async () => {
    vi.useFakeTimers();
    try {
      const agentRunner = new FakeAgentRunner({ stdout: RESOLVE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });

      const err500 = Object.assign(new Error('Server'), { status: 500 });
      const graphqlMock = vi.fn().mockImplementation(async (q: string) => {
        if (q.includes('resolveReviewThread')) throw err500;
        return digestPageWithAddressedThread;
      });

      const fakeOctokit = {
        rest: {
          pulls: { createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }), createReviewComment: vi.fn(), createReplyForReviewComment: vi.fn(), listReviews: vi.fn().mockResolvedValue({ data: [] }) },
          checks: { create: vi.fn(), update: vi.fn() },
        } as any,
      };
      const fakeGraphql = { graphql: graphqlMock };

      const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

      const initial: WorkflowState = {
        env: { ...baseEnv, dryRun: false },
        cfg: baseCfg,
        diffFiles: ['a.go'],
        repoPath: process.cwd(),
      };

      const run = workflow.createRun();
      const promise = run.start({ inputData: initial });
      await vi.runAllTimersAsync();
      const result = await promise;

      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }
      const final = result.result as unknown as WorkflowState;

      expect(final.resolvedThreadIds).toEqual([]);
      // Per-thread 5xx exhaustion is swallowed by resolveAddressedThreads (logs + skips).
      // Only programmer errors reaching the Step's catch trip resolveThreadsFailed.
      expect(final.resolveThreadsFailed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
