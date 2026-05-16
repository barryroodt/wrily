import { describe, it, expect } from 'vitest';
import { selectRunner } from '../../src/agent/factory.js';
import { ClaudeCodeRunner } from '../../src/agent/claudeCode.js';
import { CodexRunner } from '../../src/agent/codex.js';

describe('selectRunner', () => {
  it('returns ClaudeCodeRunner for Anthropic models', () => {
    expect(selectRunner('opus')).toBeInstanceOf(ClaudeCodeRunner);
    expect(selectRunner('sonnet')).toBeInstanceOf(ClaudeCodeRunner);
    expect(selectRunner('haiku')).toBeInstanceOf(ClaudeCodeRunner);
    expect(selectRunner('claude-opus-4-7')).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('returns CodexRunner for OpenAI/GPT models', () => {
    expect(selectRunner('gpt-5')).toBeInstanceOf(CodexRunner);
    expect(selectRunner('gpt-4o')).toBeInstanceOf(CodexRunner);
  });

  it('throws on unknown model', () => {
    expect(() => selectRunner('mystery-model-9000')).toThrow(/unknown/i);
  });
});
