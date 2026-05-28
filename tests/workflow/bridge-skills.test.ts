import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn(() => Buffer.from('')),
}));

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

describe('workflow / bridgeSkillsStep', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'bridge-skills-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('skips with empty loadedSkills when sharedPath is null', async () => {
    const workflow = makeWorkflow();
    const initial: WorkflowState = {
      env: baseEnv,
      cfg: { ...baseCfg, shared_skills: ['caveman-review'] },
      diffFiles: ['src/x.ts'],
      repoPath: '/pre/seeded/repo',
      sharedPath: null,
    };
    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }
    const final = result.result as unknown as WorkflowState;
    expect(final.loadedSkills).toEqual([]);
  });

  it('skips with empty loadedSkills when cfg.shared_skills is empty', async () => {
    const sharedPath = mkdtempSync(join(tmpdir(), 'shared-'));
    try {
      const workflow = makeWorkflow();
      const initial: WorkflowState = {
        env: baseEnv,
        cfg: { ...baseCfg, shared_skills: [] },
        diffFiles: ['src/x.ts'],
        repoPath: '/pre/seeded/repo',
        sharedPath,
      };
      const run = await workflow.createRun();
      const result = await run.start({ inputData: initial });
      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }
      const final = result.result as unknown as WorkflowState;
      expect(final.loadedSkills).toEqual([]);
    } finally {
      rmSync(sharedPath, { recursive: true, force: true });
    }
  });

  it('bridges one skill from shared to ~/.claude/skills', async () => {
    const sharedPath = mkdtempSync(join(tmpdir(), 'shared-'));
    try {
      mkdirSync(join(sharedPath, 'skills', 'caveman-review'), { recursive: true });
      writeFileSync(join(sharedPath, 'skills', 'caveman-review', 'SKILL.md'), '# caveman');

      const workflow = makeWorkflow();
      const initial: WorkflowState = {
        env: baseEnv,
        cfg: { ...baseCfg, shared_skills: ['caveman-review'] },
        diffFiles: ['src/x.ts'],
        repoPath: '/pre/seeded/repo',
        sharedPath,
      };
      const run = await workflow.createRun();
      const result = await run.start({ inputData: initial });
      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }
      const final = result.result as unknown as WorkflowState;
      expect(final.loadedSkills).toEqual(['caveman-review']);
      const dest = join(fakeHome, '.claude', 'skills', 'caveman-review', 'SKILL.md');
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('# caveman');
    } finally {
      rmSync(sharedPath, { recursive: true, force: true });
    }
  });

  it('skips missing skills, bridges available ones', async () => {
    const sharedPath = mkdtempSync(join(tmpdir(), 'shared-'));
    try {
      mkdirSync(join(sharedPath, 'skills', 'caveman-review'), { recursive: true });
      writeFileSync(join(sharedPath, 'skills', 'caveman-review', 'SKILL.md'), '# caveman');

      const workflow = makeWorkflow();
      const initial: WorkflowState = {
        env: baseEnv,
        cfg: { ...baseCfg, shared_skills: ['missing-skill', 'caveman-review'] },
        diffFiles: ['src/x.ts'],
        repoPath: '/pre/seeded/repo',
        sharedPath,
      };
      const run = await workflow.createRun();
      const result = await run.start({ inputData: initial });
      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }
      const final = result.result as unknown as WorkflowState;
      expect(final.loadedSkills).toEqual(['caveman-review']);
    } finally {
      rmSync(sharedPath, { recursive: true, force: true });
    }
  });

  it('rejects invalid shared skill names before joining paths', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sharedPath = mkdtempSync(join(tmpdir(), 'shared-'));
    try {
      mkdirSync(join(sharedPath, 'skills', 'caveman-review'), { recursive: true });
      writeFileSync(join(sharedPath, 'skills', 'caveman-review', 'SKILL.md'), '# caveman');

      const workflow = makeWorkflow();
      const initial: WorkflowState = {
        env: baseEnv,
        cfg: { ...baseCfg, shared_skills: ['..', 'nested/path', 'caveman-review'] },
        diffFiles: ['src/x.ts'],
        repoPath: '/pre/seeded/repo',
        sharedPath,
      };
      const run = await workflow.createRun();
      const result = await run.start({ inputData: initial });
      if (result.status !== 'success') {
        throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
      }
      const final = result.result as unknown as WorkflowState;
      expect(final.loadedSkills).toEqual(['caveman-review']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid shared skill name/));
    } finally {
      warn.mockRestore();
      rmSync(sharedPath, { recursive: true, force: true });
    }
  });
});
