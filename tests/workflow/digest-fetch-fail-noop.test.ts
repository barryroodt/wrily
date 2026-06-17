import { describe, it, expect } from 'vitest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';

const FAKE_REPLY = `\`\`\`json
{ "summary": "ok", "findings": [], "strengths": [] }
\`\`\``;

describe('workflow / digest fetch noop when reply_feedback: off', () => {
  it('continues when GraphQL would have errored, because feature is off', async () => {
    const agentRunner = new FakeAgentRunner({ stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
    const fakeOctokit = { rest: {} as any };
    let graphqlCalled = false;
    const fakeGraphql = { graphql: async () => { graphqlCalled = true; throw new Error('would have failed'); } };

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
        style: 'terse', sensitivity: 'minor', reply_feedback: 'off',
      },
      diffFiles: ['src/x.ts'],
      repoPath: process.cwd(),
    };

    const run = await workflow.createRun();
    const result = await run.start({ inputData: initial });
    if (result.status !== 'success') throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
    const final = result.result as unknown as WorkflowState;
    expect(final.priorFeedback).toBeNull();
    expect(graphqlCalled).toBe(false);
  });
});
