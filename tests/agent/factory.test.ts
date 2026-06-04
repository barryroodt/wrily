import { describe, it, expect } from 'vitest';
import { selectRunner } from '../../src/agent/factory.js';
import { PiRunner } from '../../src/agent/pi.js';

describe('selectRunner', () => {
  it('returns a PiRunner for any model reference (provider-agnostic)', () => {
    for (const model of [
      'opus',
      'anthropic/claude-opus-4-8',
      'openai/gpt-4o',
      'gpt-5',
      'mystery-model-9000',
    ]) {
      expect(selectRunner(model)).toBeInstanceOf(PiRunner);
    }
  });
});
