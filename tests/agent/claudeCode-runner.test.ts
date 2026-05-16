import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { AgentTimeoutError, ClaudeCodeRunner } from '../../src/agent/claudeCode.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('ClaudeCodeRunner', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('clears the SIGKILL fallback timer when a timed-out process closes after SIGTERM', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const runner = new ClaudeCodeRunner();
    const promise = runner.run({
      prompt: 'review',
      model: 'opus',
      maxBudgetUsd: null,
      workingDir: process.cwd(),
      env: {},
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null);
    await expect(promise).rejects.toBeInstanceOf(AgentTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
