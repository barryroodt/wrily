import { describe, it, expect } from 'vitest';
import { parseStreamJsonUsage, reassembleAssistantText } from '../../src/agent/claudeCode.js';

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

describe('reassembleAssistantText', () => {
  it('concatenates text blocks from assistant events in order', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}',
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe('Hello world');
  });

  it('preserves a ```json fence so extractFindings can match it', () => {
    const fenced = '```json\n{"findings":[]}\n```';
    const stdout = [
      '{"type":"system","subtype":"init"}',
      `{"type":"assistant","message":{"content":[{"type":"text","text":${JSON.stringify(fenced)}}]}}`,
      '{"type":"result","subtype":"success","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe(fenced);
  });

  it('handles assistant events with multiple text blocks in one content array', () => {
    const stdout = '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}\n';
    expect(reassembleAssistantText(stdout)).toBe('ab');
  });

  it('ignores non-text content blocks (e.g. tool_use)', () => {
    const stdout = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x"},{"type":"text","text":"only-text"}]}}\n';
    expect(reassembleAssistantText(stdout)).toBe('only-text');
  });

  it('returns empty string when no assistant events present', () => {
    const stdout = '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","usage":{}}\n';
    expect(reassembleAssistantText(stdout)).toBe('');
  });

  it('skips malformed lines silently', () => {
    const stdout = 'not json\n{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n';
    expect(reassembleAssistantText(stdout)).toBe('ok');
  });

  it('uses the terminal result event result field when it contains the JSON fence', () => {
    const fenced = '```json\n{"summary":"from-result","findings":[],"strengths":[]}\n```';
    const stdout = [
      '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"working..."}]}}',
      `{"type":"result","subtype":"success","result":${JSON.stringify(fenced)},"usage":{"input_tokens":1,"output_tokens":2}}`,
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe(fenced);
  });

  it('prefers lead-agent text over nested teammate assistant chatter', () => {
    const leadFence = '```json\n{"summary":"lead","findings":[],"strengths":[]}\n```';
    const stdout = [
      `{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{"content":[{"type":"text","text":"teammate prose with no fence"}]}}`,
      `{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":${JSON.stringify(leadFence)}}]}}`,
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe(leadFence);
  });

  it('extracts a JSON fence from extended-thinking blocks when text blocks omit it', () => {
    const fenced = '```json\n{"summary":"from-thinking","findings":[],"strengths":[]}\n```';
    const stdout = [
      `{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"thinking","thinking":${JSON.stringify(fenced)}}]}}`,
      '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Done."}]}}',
      '{"type":"result","subtype":"success","result":"","usage":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe(`${fenced}Done.`);
  });

  it('reassembles stream_event text_delta chunks when assistant events are absent', () => {
    const stdout = [
      '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"```json\\n"}}}',
      '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"{\\"summary\\":\\"stream\\",\\"findings\\":[],\\"strengths\\":[]}\\n```"}}}',
      '{"type":"result","subtype":"success","result":"","usage":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    expect(reassembleAssistantText(stdout)).toBe(
      '```json\n{"summary":"stream","findings":[],"strengths":[]}\n```',
    );
  });
});
