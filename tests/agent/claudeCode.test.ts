import { describe, it, expect } from 'vitest';
import { AgentTimeoutError, AgentBudgetExceededError } from '../../src/agent/claudeCode.js';

// NOTE: ClaudeCodeRunner's behaviour (spawn + timeout + budget detection) is
// hard to exercise without an integration shell. Upper layers cover that path
// via FakeAgentRunner. These tests only pin the shape of the error classes
// since main.ts/failureFallback.ts dispatch on `instanceof` checks.
describe('claudeCode error classes', () => {
  it('AgentTimeoutError carries the timeoutMs and captured streams', () => {
    const err = new AgentTimeoutError(30_000, 'partial stdout', 'partial stderr');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentTimeoutError');
    expect(err.timeoutMs).toBe(30_000);
    expect(err.stdout).toBe('partial stdout');
    expect(err.stderr).toBe('partial stderr');
    expect(err.message).toMatch(/30000ms/);
  });

  it('AgentBudgetExceededError carries captured streams', () => {
    const err = new AgentBudgetExceededError('out', 'err');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentBudgetExceededError');
    expect(err.stdout).toBe('out');
    expect(err.stderr).toBe('err');
    expect(err.message).toMatch(/budget/i);
  });
});
