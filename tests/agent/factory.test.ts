import { describe, it, expect } from 'vitest';
import { selectRunner } from '../../src/agent/factory.js';
import { RigRunner } from '../../src/agent/rig.js';

describe('selectRunner', () => {
  it('returns RigRunner for Anthropic models', () => {
    expect(selectRunner('opus')).toBeInstanceOf(RigRunner);
    expect(selectRunner('sonnet')).toBeInstanceOf(RigRunner);
    expect(selectRunner('haiku')).toBeInstanceOf(RigRunner);
    expect(selectRunner('claude-opus-4-7')).toBeInstanceOf(RigRunner);
  });

  it('returns RigRunner for OpenAI/GPT models', () => {
    expect(selectRunner('gpt-5')).toBeInstanceOf(RigRunner);
    expect(selectRunner('gpt-4o')).toBeInstanceOf(RigRunner);
  });

  it('returns RigRunner for any model string', () => {
    expect(selectRunner('mystery-model-9000')).toBeInstanceOf(RigRunner);
  });
});
