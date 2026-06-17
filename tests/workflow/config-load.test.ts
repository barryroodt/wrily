import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';
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

function baseEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    anthropicApiKey: null,
    githubToken: 'gho_x',
    prNumber: 1,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'abc',
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

const defaultCfg: WrilyConfig = {
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
};

describe('workflow / config load', () => {
  let repoPath = '';

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    repoPath = '';
  });

  it('loads .wrily.yml from the cloned repo path before resolving review behavior', async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'wrily-config-load-'));
    writeFileSync(
      join(repoPath, '.wrily.yml'),
      [
        'model: sonnet',
        'mode: team',
        'team_threshold: 99',
        'max_tokens: 1200000',
        'style: verbose',
        'sensitivity: critical',
        'reply_feedback: off',
        'request_changes: true',
        'ignore:',
        '  - ignored.ts',
        'shared_skills:',
        '  - rust-pro',
        '',
      ].join('\n'),
      'utf8',
    );

    const agentRunner = new FakeAgentRunner({
      stdout: FAKE_REPLY,
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      tokenUsage: null,
    });
    const workflow = buildReviewWorkflow({
      agentRunner,
      octokit: { rest: {} as any },
      graphqlClient: { graphql: async () => emptyDigestPage },
    });

    const run = await workflow.createRun();
    const result = await run.start({
      inputData: {
        env: baseEnv(),
        cfg: defaultCfg,
        repoPath,
        diffFiles: ['ignored.ts', 'src/kept.ts'],
      },
    });
    if (result.status !== 'success') {
      throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    }

    const final = result.result as unknown as WorkflowState;
    expect(final.cfg.model).toBe('sonnet');
    expect(final.cfg.mode).toBe('team');
    expect(final.cfg.max_tokens).toBe(1200000);
    expect(final.cfg.style).toBe('verbose');
    expect(final.cfg.sensitivity).toBe('critical');
    expect(final.cfg.request_changes).toBe(true);
    expect(final.cfg.shared_skills).toEqual(['rust-pro']);
    expect(final.reviewMode).toBe('team');
    expect(final.diffFiles).toEqual(['src/kept.ts']);
    expect(agentRunner.calls[0]?.model).toBe('sonnet');
  });
});
