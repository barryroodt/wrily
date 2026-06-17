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
  anthropicApiKey: null,
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
  allowUnknownModel: false,
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
  max_tokens: null,
  ignore: [],
  shared_skills: [],
  request_changes: false,
  style: 'terse' as const,
  sensitivity: 'minor' as const,
  reply_feedback: 'off' as const,
};

const fakeOctokit = { rest: {} as any };
const fakeGraphql = { graphql: async () => emptyDigestPage };

function makeWorkflow() {
  const agentRunner = new FakeAgentRunner({
    stdout: FAKE_REPLY,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    tokenUsage: null,
  });
  return buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
}

describe('workflow / cloneSharedStep', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockImplementation(() => Buffer.from(''));
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(''));
  });
  afterEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
  });

  it('skips cleanly when sharedToken is empty (no git clone, sharedPath null)', async () => {
    const workflow = makeWorkflow();
    const initial: WorkflowState = {
      env: { ...baseEnv, sharedToken: '' },
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
    expect(final.sharedPath).toBeNull();
    const cloneCalls = vi.mocked(execFileSync).mock.calls.filter(([, args]) =>
      Array.isArray(args) && args[0] === 'clone' && args.join(' ').includes('shared'),
    );
    expect(cloneCalls).toHaveLength(0);
  });

  it('clones shared when sharedToken is set', async () => {
    const workflow = makeWorkflow();
    const initial: WorkflowState = {
      env: { ...baseEnv, sharedToken: 'gho_shared_xxx' },
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
    expect(final.sharedPath).toMatch(/wrily-shared-/);
    expect(execSync).not.toHaveBeenCalled();
    const cloneCalls = vi.mocked(execFileSync).mock.calls;
    expect(cloneCalls.some(([bin, args, opts]) =>
      bin === 'git' &&
      Array.isArray(args) &&
      args[0] === 'clone' &&
      args.includes('--depth=1') &&
      args.join(' ').includes('your-org/shared-wrily-skills') &&
      (opts as any)?.timeout === 120_000,
    )).toBe(true);
  });

  it('best-effort: failure → sharedPath null, no throw', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('your-org/shared-wrily-skills')) {
        throw new Error('fatal: Authentication failed');
      }
      return Buffer.from('');
    });
    vi.mocked(execFileSync).mockImplementation((_bin: any, args: any) => {
      if (Array.isArray(args) && args.join(' ').includes('your-org/shared-wrily-skills')) {
        throw new Error('fatal: Authentication failed');
      }
      return Buffer.from('');
    });
    const workflow = makeWorkflow();
    const initial: WorkflowState = {
      env: { ...baseEnv, sharedToken: 'gho_shared_xxx' },
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
    expect(final.sharedPath).toBeNull();
  });

  it('redacts shared token material from best-effort clone warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const secretToken = 'gho_shared_secret';
      const tokenUrl = `https://x-access-token:${secretToken}@github.com/your-org/shared-wrily-skills.git`;
      const failure = new Error(`Command failed: git clone --depth=1 ${tokenUrl} /tmp/shared`);
      vi.mocked(execSync).mockImplementation((cmd: any) => {
        if (String(cmd).includes('your-org/shared-wrily-skills')) throw failure;
        return Buffer.from('');
      });
      vi.mocked(execFileSync).mockImplementation((_bin: any, args: any) => {
        if (Array.isArray(args) && args.join(' ').includes('your-org/shared-wrily-skills')) throw failure;
        return Buffer.from('');
      });
      const workflow = makeWorkflow();
      const initial: WorkflowState = {
        env: { ...baseEnv, sharedToken: secretToken },
        cfg: baseCfg,
        diffFiles: ['src/x.ts'],
        repoPath: '/pre/seeded/repo',
      };
      const run = await workflow.createRun();
      const result = await run.start({ inputData: initial });
      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }

      const warningText = warn.mock.calls.flat().join('\n');
      expect(warningText).not.toContain(secretToken);
      expect(warningText).toContain('[REDACTED]');
    } finally {
      warn.mockRestore();
    }
  });
});
