import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  AgentBudgetExceededError,
  AgentTimeoutError,
} from '../../src/agent/errors.js';
import { RigRunner } from '../../src/agent/rig.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  };
  child.stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  child.stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  return child;
}

function emitStdout(child: ReturnType<typeof fakeChild>, text: string) {
  child.stdout.emit('data', text);
}

function finishChild(child: ReturnType<typeof fakeChild>, code: number) {
  child.emit('exit', code);
}

async function runWithMockStdout(
  setup: (child: ReturnType<typeof fakeChild>) => void,
  opts?: Parameters<RigRunner['run']>[0],
) {
  const child = fakeChild();
  spawnMock.mockReturnValue(child);

  const runner = new RigRunner();
  const promise = runner.run(opts ?? baseOpts);
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  setup(child);
  return promise;
}

const baseOpts = {
  prompt: 'review this PR',
  model: 'claude-sonnet-4',
  workingDir: process.cwd(),
  env: {},
};

describe('RigRunner', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('parses NDJSON events and returns AgentResult on happy path', async () => {
    const result = await runWithMockStdout((child) => {
      emitStdout(child, [
        JSON.stringify({ event: 'start', ts: 1, model: 'claude-sonnet-4', provider: 'anthropic', mode: 'single', workdir: process.cwd() }),
        JSON.stringify({ event: 'assistant_text', ts: 2, role: 'assistant', text: 'line one' }),
        JSON.stringify({ event: 'assistant_text', ts: 3, role: 'assistant', text: 'line two' }),
        JSON.stringify({
          event: 'result',
          ts: 4,
          exit: 'ok',
          total_input: 100,
          total_output: 50,
          total_cache_read: 10,
          total_cache_write: 5,
          duration_ms: 1500,
        }),
        '',
      ].join('\n'));
      finishChild(child, 0);
    });

    expect(result.stdout).toBe('line one\nline two');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(1500);
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  it('throws AgentBudgetExceededError when terminal exit is budget', async () => {
    const promise = runWithMockStdout((child) => {
      emitStdout(child, [
        JSON.stringify({ event: 'budget_exceeded', ts: 1, limit: 1000, total: 1001 }),
        JSON.stringify({
          event: 'result',
          ts: 2,
          exit: 'budget',
          total_input: 800,
          total_output: 201,
          total_cache_read: 0,
          total_cache_write: 0,
          duration_ms: 900,
        }),
        '',
      ].join('\n'));
      finishChild(child, 1);
    });

    await expect(promise).rejects.toBeInstanceOf(AgentBudgetExceededError);
  });

  it('throws AgentTimeoutError when terminal exit is timeout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const runner = new RigRunner({ maxTokens: 123 });
    const promise = runner.run({ ...baseOpts, timeoutMs: 42_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    emitStdout(child, JSON.stringify({
      event: 'result',
      ts: 1,
      exit: 'timeout',
      total_input: 0,
      total_output: 0,
      total_cache_read: 0,
      total_cache_write: 0,
      duration_ms: 42_000,
    }));
    finishChild(child, 1);

    await expect(promise).rejects.toBeInstanceOf(AgentTimeoutError);
    await expect(promise).rejects.toMatchObject({ timeoutMs: 42_000 });
  });

  it('skips malformed NDJSON lines', async () => {
    const result = await runWithMockStdout((child) => {
      emitStdout(child, [
        '{not valid json',
        JSON.stringify({ event: 'assistant_text', ts: 1, role: 'assistant', text: 'ok' }),
        JSON.stringify({
          event: 'result',
          ts: 2,
          exit: 'ok',
          total_input: 1,
          total_output: 2,
          total_cache_read: 0,
          total_cache_write: 0,
          duration_ms: 10,
        }),
        '',
      ].join('\n'));
      finishChild(child, 0);
    });

    expect(result.stdout).toBe('ok');
  });

  it('handles a partial final line without trailing newline', async () => {
    const result = await runWithMockStdout((child) => {
      const partialLine = JSON.stringify({
        event: 'result',
        ts: 1,
        exit: 'ok',
        total_input: 3,
        total_output: 4,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms: 20,
      });
      emitStdout(
        child,
        `${JSON.stringify({ event: 'assistant_text', ts: 0, role: 'assistant', text: 'done' })}\n${partialLine}`,
      );
      finishChild(child, 0);
    });

    expect(result.stdout).toBe('done');
    expect(result.tokenUsage?.inputTokens).toBe(3);
  });

  it('throws a generic Error when exit code is non-zero without a terminal result', async () => {
    const promise = runWithMockStdout((child) => {
      child.stderr.emit('data', 'config error: bad workdir');
      emitStdout(child, JSON.stringify({ event: 'error', ts: 1, kind: 'config', message: 'bad workdir' }));
      finishChild(child, 2);
    });

    await expect(promise).rejects.toThrow('wrily-rig exited with code 2: config error: bad workdir');
  });
});
