import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFileSync, execSync } from 'node:child_process';
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
  authMethod: 'oauth' as const,
  anthropicApiKey: null,
  claudeCodeOauthToken: 'sk-ant-oat01-x',
  githubToken: 'gho_test',
  prNumber: 42,
  githubRepository: 'org/repo',
  baseBranch: 'main',
  commitSha: 'abc1234',
  sharedRepo: 'your-org/shared-wrily-skills',
  sharedToken: '',
  wrilyBotLogin: 'wrily',
  reviewRoundIndex: 0,
  scopeOverride: '' as const,
  modeOverride: '' as const,
  modelOverride: '',
  maxBudgetOverride: null,
  dryRun: true,
  prAuthorLogin: 'human-dev',
  triggerSource: 'push',
  actor: 'human-dev',
  replyFeedbackOverride: '' as const,
};

const baseCfg = {
  model: 'opus',
  mode: 'single' as const,
  team_threshold: 5,
  team_threshold_unit: 'files' as const,
  max_budget_usd: null,
  ignore: [],
  shared_skills: [],
  request_changes: false,
  style: 'terse' as const,
  sensitivity: 'minor' as const,
  reply_feedback: 'off' as const,
};

const fakeOctokit = { rest: {} as any };
const fakeGraphql = { graphql: async () => emptyDigestPage };

describe('workflow / cloneRepoStep', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
  });
  afterEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
  });

  it('clones consumer PR repo when repoPath is not pre-seeded', async () => {
    vi.mocked(execSync).mockImplementation(() => Buffer.from(''));
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(''));

    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      tokenUsage: null,
    });
    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: baseEnv,
      cfg: baseCfg,
      diffFiles: ['src/x.ts'],
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;

    expect(final.repoPath).toMatch(/wrily-pr-42-/);
    expect(execSync).not.toHaveBeenCalled();
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls.some(([bin, args]) =>
      bin === 'git' && Array.isArray(args) && args[0] === 'clone' && args.includes('--depth=200'),
    )).toBe(true);
    expect(calls.some(([bin, args]) =>
      bin === 'git' && Array.isArray(args) && args.join(' ').includes(`pull/42/head:pr-42`),
    )).toBe(true);
    expect(calls.every(([, , opts]) => (opts as any)?.timeout === 120_000)).toBe(true);
  });

  it('throws when git clone fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).startsWith('git clone')) {
        throw new Error('fatal: Authentication failed');
      }
      return Buffer.from('');
    });
    vi.mocked(execFileSync).mockImplementation((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === 'clone') {
        throw new Error('fatal: Authentication failed');
      }
      return Buffer.from('');
    });

    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      tokenUsage: null,
    });
    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = { env: baseEnv, cfg: baseCfg };
    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error?.message ?? '').toMatch(/cloneRepo failed/i);
    }
  });

  it('redacts GitHub token material from clone errors', async () => {
    const secretToken = 'gho_secret_token';
    const tokenUrl = `https://x-access-token:${secretToken}@github.com/org/repo.git`;
    const failure = new Error(`Command failed: git clone --depth=200 ${tokenUrl} /tmp/repo`);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).startsWith('git clone')) throw failure;
      return Buffer.from('');
    });
    vi.mocked(execFileSync).mockImplementation((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === 'clone') throw failure;
      return Buffer.from('');
    });

    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      tokenUsage: null,
    });
    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
    const initial: WorkflowState = {
      env: { ...baseEnv, githubToken: secretToken },
      cfg: baseCfg,
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      const message = result.error?.message ?? '';
      expect(message).toContain('cloneRepo failed');
      expect(message).not.toContain(secretToken);
      expect(message).toContain('[REDACTED]');
    }
  });

  it('skips clone when repoPath is pre-seeded', async () => {
    vi.mocked(execSync).mockImplementation(() => Buffer.from(''));
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(''));

    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      tokenUsage: null,
    });
    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: baseEnv,
      cfg: baseCfg,
      diffFiles: ['src/x.ts'],
      repoPath: '/pre/seeded/repo',
    };
    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;
    expect(final.repoPath).toBe('/pre/seeded/repo');
    const cloneCalls = vi.mocked(execFileSync).mock.calls.filter(([, args]) =>
      Array.isArray(args) && args[0] === 'clone',
    );
    expect(cloneCalls).toHaveLength(0);
  });
});
