import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../src/persist/failure.js';
import { AgentBudgetExceededError, AgentTimeoutError } from '../../src/agent/errors.js';

describe('classifyFailure', () => {
  it('maps AgentBudgetExceededError → budget_exceeded', () => {
    expect(classifyFailure(new AgentBudgetExceededError('s', 'e'))).toBe('budget_exceeded');
  });

  it('maps AgentTimeoutError → timeout', () => {
    expect(classifyFailure(new AgentTimeoutError(1000, 's', 'e'))).toBe('timeout');
  });

  it('maps generic Error → failed', () => {
    expect(classifyFailure(new Error('boom'))).toBe('failed');
  });

  it('maps non-Error → failed', () => {
    expect(classifyFailure('boom')).toBe('failed');
    expect(classifyFailure(null)).toBe('failed');
    expect(classifyFailure(undefined)).toBe('failed');
  });

  it('unwraps one level of err.cause to detect known errors', () => {
    const wrapped = new Error('workflow failed');
    (wrapped as { cause?: unknown }).cause = new AgentBudgetExceededError('s', 'e');
    expect(classifyFailure(wrapped)).toBe('budget_exceeded');
  });

  it('falls back to failed when wrapped cause is not a known error', () => {
    const wrapped = new Error('workflow failed');
    (wrapped as { cause?: unknown }).cause = new Error('other');
    expect(classifyFailure(wrapped)).toBe('failed');
  });
});
