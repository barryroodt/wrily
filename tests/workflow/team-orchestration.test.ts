import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { SequenceFakeAgentRunner } from '../../src/agent/fake.js';
import { composeTeam } from '../../src/workflow/teamRoles.js';
import type { WorkflowState } from '../../src/workflow/state.js';
import type { AgentResult, AgentRunner, AgentRunOptions } from '../../src/agent/runner.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';

const emptyDigestPage = {
  repository: {
    pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    },
  },
};

function fence(tag: string): string {
  return [
    '```json',
    JSON.stringify({
      summary: tag,
      findings: [
        { action: 'new_comment', severity: 'minor', path: 'src/a.ts', line: 1, side: 'RIGHT', message: tag },
      ],
      strengths: [],
    }),
    '```',
  ].join('\n');
}

function res(stdout: string): AgentResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    model: 'anthropic/claude-opus-4-8',
  };
}

function baseEnv(over: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    anthropicApiKey: 'sk-ant-x',
    githubToken: 'gho_x',
    prNumber: 1,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'abc1234',
    sharedRepo: '',
    sharedToken: '',
    wrilyBotLogin: 'wrily',
    reviewRoundIndex: 0,
    scopeOverride: '',
    modeOverride: '',
    replyFeedbackOverride: '',
    modelOverride: '',
    maxBudgetOverride: null,
    dryRun: true,
    prAuthorLogin: 'human',
    triggerSource: 'push',
    actor: 'human',
    ...over,
  };
}

function baseCfg(): WrilyConfig {
  return {
    model: 'anthropic/claude-opus-4-8',
    mode: 'team',
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
}

// dry-run team runs never touch octokit.rest; a bare stub suffices.
const octokit: Pick<Octokit, 'rest'> = { rest: {} as unknown as Octokit['rest'] };

async function runTeam(runner: AgentRunner, env: RuntimeEnv, diffFiles: string[]): Promise<WorkflowState> {
  const workflow = buildReviewWorkflow({
    agentRunner: runner,
    octokit,
    graphqlClient: { graphql: async () => emptyDigestPage },
  });
  const initial: WorkflowState = { env, cfg: baseCfg(), diffFiles, repoPath: process.cwd() };
  const result = await (await workflow.createRun()).start({ inputData: initial });
  if (result.status !== 'success') {
    const message = (result as { error?: { message?: string } }).error?.message ?? 'unknown';
    throw new Error(`workflow failed: ${message}`);
  }
  return result.result as unknown as WorkflowState;
}

// Multi-dir, multi-language change → full deterministic roster.
const DIFF = ['src/a.ts', 'pkg/b.go'];
const ROSTER = composeTeam(DIFF);
const sequenceResponses = (): AgentResult[] => [
  ...ROSTER.map((_, i) => res(fence(`REVIEWER-${i}`))),
  res(fence('UNIFIED')),
];

describe('workflow / team orchestration', () => {
  it('runs N reviewers + 1 unify; reviewers carry role system prompts, unify does not', async () => {
    const runner = new SequenceFakeAgentRunner(sequenceResponses());
    const final = await runTeam(runner, baseEnv(), DIFF);

    expect(ROSTER.length).toBeGreaterThanOrEqual(4);
    expect(runner.calls.length).toBe(ROSTER.length + 1);

    for (let i = 0; i < ROSTER.length; i++) {
      const sys = runner.calls[i]?.systemPrompt;
      expect(typeof sys).toBe('string');
      expect((sys ?? '').length).toBeGreaterThan(0);
    }
    // The trailing unify call has no role persona.
    expect(runner.calls[ROSTER.length]?.systemPrompt).toBeUndefined();
    expect(final.agentResults).toHaveLength(ROSTER.length + 1);
  });

  it('extracts findings ONLY from the unify result, not the reviewers', async () => {
    const runner = new SequenceFakeAgentRunner(sequenceResponses());
    const final = await runTeam(runner, baseEnv(), DIFF);

    expect(final.findings).toHaveLength(1);
    expect(final.findings?.[0]?.message).toBe('UNIFIED');
    expect(final.findings?.some((f) => f.message.startsWith('REVIEWER'))).toBe(false);
  });

  it('feeds the reviewer reports into the unify prompt', async () => {
    const runner = new SequenceFakeAgentRunner(sequenceResponses());
    await runTeam(runner, baseEnv(), DIFF);

    const unifyPrompt = runner.calls[ROSTER.length]?.prompt ?? '';
    expect(unifyPrompt).toContain('REVIEWER-0');
    expect(unifyPrompt).toContain(`### Reviewer ${ROSTER.length}: ${ROSTER[ROSTER.length - 1]}`);
  });

  it('fans the reviewers out in parallel (all in-flight before any resolves)', async () => {
    class ConcurrencyRunner implements AgentRunner {
      public readonly calls: AgentRunOptions[] = [];
      public maxInFlight = 0;
      private inFlight = 0;
      private index = 0;
      constructor(private readonly responses: AgentResult[]) {}
      async run(opts: AgentRunOptions): Promise<AgentResult> {
        this.calls.push(opts);
        // Reviewers (role persona present) yield so overlapping in-flight count
        // is observable; the unify call (no persona) runs after the barrier.
        if (opts.systemPrompt) {
          this.inFlight += 1;
          this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
          await Promise.resolve();
          this.inFlight -= 1;
        }
        const response = this.responses[this.index];
        this.index += 1;
        if (!response) throw new Error('ConcurrencyRunner: out of responses');
        return response;
      }
    }

    const runner = new ConcurrencyRunner(sequenceResponses());
    await runTeam(runner, baseEnv(), DIFF);
    expect(runner.maxInFlight).toBe(ROSTER.length);
  });

  it('persists each reviewer + unify as team-${idx} subagents', async () => {
    const subagentBodies: Array<Array<{ role: string }>> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/review_runs')) {
        return new Response(JSON.stringify([{ id: 'run-1' }]), { status: 201 });
      }
      if (u.includes('/review_subagent_runs')) {
        const body = init?.body ? JSON.parse(String(init.body)) : [];
        subagentBodies.push(body);
        return new Response(JSON.stringify(body), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const env = baseEnv({ supabase: { url: 'https://x.supabase.co', serviceRoleKey: 'srk' } });
      const runner = new SequenceFakeAgentRunner(sequenceResponses());
      await runTeam(runner, env, DIFF);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(subagentBodies).toHaveLength(1);
    const roles = (subagentBodies[0] ?? []).map((r) => r.role);
    const expected = Array.from({ length: ROSTER.length + 1 }, (_, i) => `team-${i}`);
    expect(roles).toEqual(expected);
  });

  it('drops a failed reviewer and still unifies the survivors (allSettled)', async () => {
    // One reviewer (index 2) throws; the rest + unify succeed.
    const responses: Array<AgentResult | Error> = ROSTER.map((_, i) =>
      i === 2 ? new Error('provider 5xx') : res(fence(`REVIEWER-${i}`)),
    );
    responses.push(res(fence('UNIFIED')));
    const runner = new SequenceFakeAgentRunner(responses);
    const final = await runTeam(runner, baseEnv(), DIFF);

    // All reviewers attempted (allSettled) + unify still runs.
    expect(runner.calls.length).toBe(ROSTER.length + 1);
    expect(final.findings?.[0]?.message).toBe('UNIFIED');
    // The unify prompt includes survivors but not the dropped reviewer's output.
    const unifyPrompt = runner.calls[ROSTER.length]?.prompt ?? '';
    expect(unifyPrompt).toContain('REVIEWER-0');
    expect(unifyPrompt).not.toContain('REVIEWER-2');
  });

  it('fails the review only when every reviewer fails', async () => {
    const responses: Array<AgentResult | Error> = ROSTER.map(() => new Error('all providers down'));
    const runner = new SequenceFakeAgentRunner(responses);
    await expect(runTeam(runner, baseEnv(), DIFF)).rejects.toThrow(/all providers down|reviewers failed/);
    // Unify is never attempted when no reviewer survives.
    expect(runner.calls.length).toBe(ROSTER.length);
  });
});
