import { describe, it, expect } from 'vitest';
import { parseStreamJsonUsage } from '../../src/agent/claudeCode.js';

describe('parseStreamJsonUsage', () => {
  it('extracts usage and cost from a well-formed stream-json stdout', () => {
    const stdout = [
      '{"type":"system","subtype":"init","model":"claude-opus-4-7"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.1234,"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}}',
      '',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      costUsd: 0.1234,
    });
  });

  it('returns null when no result event is present', () => {
    const stdout = '{"type":"system","subtype":"init"}\n';
    expect(parseStreamJsonUsage(stdout)).toBeNull();
  });

  it('returns null when result event is malformed JSON', () => {
    const stdout = '{"type":"result","subtype":"success",NOT_JSON\n';
    expect(parseStreamJsonUsage(stdout)).toBeNull();
  });

  it('ignores non-JSON noise lines and keeps parsing', () => {
    const stdout = [
      'some non-json line',
      '{"type":"result","subtype":"success","total_cost_usd":0.05,"usage":{"input_tokens":1,"output_tokens":2}}',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.05,
    });
  });

  it('uses the last result event when multiple present', () => {
    const stdout = [
      '{"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.99,"usage":{"input_tokens":99,"output_tokens":99}}',
    ].join('\n');
    expect(parseStreamJsonUsage(stdout)?.costUsd).toBe(0.99);
  });
});
