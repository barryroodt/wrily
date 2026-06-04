import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiRunner, type PiSession, type PiSessionFactory } from '../../src/agent/pi.js';
import { AgentTimeoutError, AgentBudgetExceededError } from '../../src/agent/errors.js';
import type { AgentRunOptions } from '../../src/agent/runner.js';

type FakeUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

type FakeTurn = { text?: string; usage?: FakeUsage; role?: 'assistant' | 'user' };

function turnEnd(turn: FakeTurn): AgentSessionEvent {
  const message = {
    role: turn.role ?? 'assistant',
    content: turn.text !== undefined ? [{ type: 'text', text: turn.text }] : [],
    usage:
      turn.usage ??
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  };
  return { type: 'turn_end', message, toolResults: [] } as unknown as AgentSessionEvent;
}

interface FakeBehavior {
  turns?: FakeTurn[];
  finalText?: string;
  /** prompt() resolves only once abort() is called (timeout scenario). */
  hangUntilAbort?: boolean;
  /** prompt() throws this synchronously (genuine failure scenario). */
  promptRejects?: Error;
}

class FakeSession implements PiSession {
  listener?: (event: AgentSessionEvent) => void;
  aborted = false;
  abortCalls = 0;
  disposed = false;
  private abortResolve?: () => void;

  constructor(private readonly behavior: FakeBehavior) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    if (this.behavior.promptRejects) throw this.behavior.promptRejects;
    for (const turn of this.behavior.turns ?? []) {
      this.listener?.(turnEnd(turn));
      if (this.aborted) break;
    }
    if (this.behavior.hangUntilAbort && !this.aborted) {
      // Project targets the ES2022 lib, which lacks Promise.withResolvers; the
      // executor form matches the rest of the codebase.
      await new Promise<void>((resolve) => {
        this.abortResolve = resolve;
      });
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.abortCalls += 1;
    this.abortResolve?.();
  }

  getLastAssistantText(): string | undefined {
    return this.behavior.finalText;
  }

  dispose(): void {
    this.disposed = true;
  }
}

const baseOpts: AgentRunOptions = {
  prompt: 'review the PR',
  model: 'opus',
  workingDir: '/tmp/repo',
  env: {},
};

function runnerFor(session: FakeSession, model = 'anthropic/claude-opus-4-8'): PiRunner {
  const factory: PiSessionFactory = async () => ({ session, model });
  return new PiRunner(factory);
}

const FENCE = '```json\n{"summary":"ok","findings":[],"strengths":[]}\n```';

afterEach(() => {
  vi.useRealTimers();
});

describe('PiRunner', () => {
  it('returns the final assistant text (with its json fence) as stdout', async () => {
    const session = new FakeSession({ turns: [{ text: FENCE }], finalText: FENCE });
    const result = await runnerFor(session).run(baseOpts);
    expect(result.stdout).toBe(FENCE);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(session.disposed).toBe(true);
  });

  it('threads the resolved canonical slug back as result.model', async () => {
    const session = new FakeSession({ turns: [{ text: FENCE }], finalText: FENCE });
    const result = await runnerFor(session, 'openai/gpt-4o').run({ ...baseOpts, model: 'openai/gpt-4o' });
    expect(result.model).toBe('openai/gpt-4o');
  });

  it('accumulates token usage and cost across assistant turns', async () => {
    const session = new FakeSession({
      finalText: FENCE,
      turns: [
        { text: 'a', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.01 } } },
        { text: FENCE, usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 2, cost: { total: 0.02 } } },
      ],
    });
    const result = await runnerFor(session).run(baseOpts);
    expect(result.tokenUsage).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 15,
      cacheWriteTokens: 3,
      costUsd: expect.closeTo(0.03, 10),
    });
  });

  it('ignores non-assistant turns and non-text content blocks for usage/text', async () => {
    const session = new FakeSession({
      finalText: undefined,
      turns: [
        { role: 'user', text: 'noise', usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } } },
        { text: 'real', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
      ],
    });
    const result = await runnerFor(session).run(baseOpts);
    // user turn excluded → only the assistant turn counts
    expect(result.tokenUsage?.inputTokens).toBe(10);
    expect(result.tokenUsage?.costUsd).toBeCloseTo(0.001, 10);
    // getLastAssistantText() empty → falls back to the last assistant turn's text
    expect(result.stdout).toBe('real');
  });

  it('reports null token usage when no assistant turn emitted usage', async () => {
    const session = new FakeSession({ turns: [], finalText: 'done' });
    const result = await runnerFor(session).run(baseOpts);
    expect(result.tokenUsage).toBeNull();
    expect(result.stdout).toBe('done');
  });

  it('aborts and throws AgentBudgetExceededError when accumulated cost exceeds the budget', async () => {
    const session = new FakeSession({
      finalText: 'partial',
      turns: [
        { text: 'one', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } } },
        { text: 'two', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } } },
        { text: 'three', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } } },
      ],
    });
    await expect(runnerFor(session).run({ ...baseOpts, maxBudgetUsd: 5 })).rejects.toBeInstanceOf(
      AgentBudgetExceededError,
    );
    expect(session.aborted).toBe(true);
  });

  it('does not abort on budget when cost stays under the ceiling', async () => {
    const session = new FakeSession({
      finalText: FENCE,
      turns: [{ text: FENCE, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } }],
    });
    const result = await runnerFor(session).run({ ...baseOpts, maxBudgetUsd: 5 });
    expect(session.aborted).toBe(false);
    expect(result.stdout).toBe(FENCE);
  });

  it('aborts and throws AgentTimeoutError when the run exceeds the timeout', async () => {
    vi.useFakeTimers();
    const session = new FakeSession({ hangUntilAbort: true, finalText: 'partial' });
    const promise = runnerFor(session).run({ ...baseOpts, timeoutMs: 1000 });
    // Attach the rejection assertion before advancing timers so the rejection
    // is never momentarily unhandled while the fake timer fires.
    const settled = expect(promise).rejects.toBeInstanceOf(AgentTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(session.aborted).toBe(true);
  });

  it('clears the timeout timer on a normal completion', async () => {
    vi.useFakeTimers();
    const session = new FakeSession({ turns: [{ text: FENCE }], finalText: FENCE });
    await runnerFor(session).run({ ...baseOpts, timeoutMs: 1000 });
    expect(vi.getTimerCount()).toBe(0);
    expect(session.aborted).toBe(false);
  });

  it('surfaces a genuine prompt() rejection (e.g. missing API key)', async () => {
    const boom = new Error('no API key for provider');
    const session = new FakeSession({ promptRejects: boom });
    await expect(runnerFor(session).run(baseOpts)).rejects.toBe(boom);
  });
});
