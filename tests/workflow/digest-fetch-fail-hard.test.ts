import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

describe('workflow / digest fetch fail-hard when reply_feedback: on', () => {
  it('fails when GraphQL repeatedly errors and reply_feedback is on', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: '', stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
    const fakeOctokit = { rest: {} as any };
    const fakeGraphql = { graphql: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } };

    const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });

    const initial: WorkflowState = {
      env: {
        anthropicApiKey: null,
        githubToken: 'gho_x', prNumber: 1, githubRepository: 'org/repo',
        baseBranch: 'main', commitSha: 'abc', sharedRepo: 'your-org/shared-wrily-skills', sharedToken: '',
        wrilyBotLogin: 'wrily', reviewRoundIndex: 0, scopeOverride: '',
        modeOverride: '', replyFeedbackOverride: '', modelOverride: '', allowUnknownModel: false, dryRun: true,
        prAuthorLogin: 'human-dev', triggerSource: 'push', actor: 'human-dev',
      },
      cfg: {
        model: 'opus', mode: 'single', team_threshold: 5, team_threshold_unit: 'files',
        max_tokens: null, ignore: [], shared_skills: [], request_changes: false,
        style: 'terse', sensitivity: 'minor', reply_feedback: 'on',
      },
      repoPath: process.cwd(),
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error?.message ?? '').toMatch(/digest fetch failed/i);
    }
  });
});
