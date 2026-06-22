import { describe, it, expect, vi } from 'vitest';
import type { RuntimeEnv } from '../../src/config/types.js';
import { maybePostFailure } from '../../src/post/failureFallback.js';
import { AgentTimeoutError, AgentBudgetExceededError } from '../../src/agent/errors.js';

function mkClient() {
  return {
    rest: {
      pulls: {
        createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 2 } }),
      },
    },
  };
}

function baseEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    anthropicApiKey: null,
    githubToken: 'gho_x',
    prNumber: 42,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'abc1234deadbeef',
    sharedRepo: 'your-org/shared-wrily-skills',
    sharedToken: '',
    wrilyBotLogin: 'wrily',
    reviewRoundIndex: 0,
    scopeOverride: '',
    modeOverride: '',
    replyFeedbackOverride: '',
    modelOverride: '',
    allowUnknownModel: false,
    dryRun: false,
    prAuthorLogin: 'human-dev',
    triggerSource: 'push',
    actor: 'human-dev',
    ...overrides,
  };
}

describe('maybePostFailure', () => {
  it('does not post anything; logs the kind and error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();

    await maybePostFailure(baseEnv(), client as any, new Error('boom'));

    expect(client.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(client.rest.issues.createComment).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    const payload = JSON.parse((warn.mock.calls[0]?.[0] ?? '{}') as string);
    expect(payload).toMatchObject({
      level: 'warn',
      kind: 'failure',
      dryRun: false,
      err: { name: 'Error', message: 'boom' },
    });
    warn.mockRestore();
  });

  it('AgentTimeoutError sets kind=timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    await maybePostFailure(baseEnv(), client as any, new AgentTimeoutError(30_000, '', ''));
    expect(client.rest.pulls.createReview).not.toHaveBeenCalled();
    const payload = JSON.parse((warn.mock.calls[0]?.[0] ?? '{}') as string);
    expect(payload.kind).toBe('timeout');
    warn.mockRestore();
  });

  it('AgentBudgetExceededError sets kind=budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    await maybePostFailure(baseEnv(), client as any, new AgentBudgetExceededError('', ''));
    expect(client.rest.pulls.createReview).not.toHaveBeenCalled();
    const payload = JSON.parse((warn.mock.calls[0]?.[0] ?? '{}') as string);
    expect(payload.kind).toBe('budget');
    warn.mockRestore();
  });

  it('DRY_RUN: still logs, still does not post', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    await maybePostFailure(baseEnv({ dryRun: true }), client as any, new Error('boom'));
    expect(client.rest.pulls.createReview).not.toHaveBeenCalled();
    const payload = JSON.parse((warn.mock.calls[0]?.[0] ?? '{}') as string);
    expect(payload.dryRun).toBe(true);
    warn.mockRestore();
  });
});
