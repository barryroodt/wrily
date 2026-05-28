import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFindings, ExtractError } from '../../src/post/extract.js';

const read = (name: string) => readFileSync(`tests/fixtures/model-replies/${name}.md`, 'utf8');

describe('extractFindings', () => {
  it('extracts a discriminated-union finding array (all three action variants)', () => {
    const result = extractFindings(read('full'));
    expect(result.findings).toHaveLength(3);

    const [crit, reply, supp] = result.findings;
    expect(crit?.action).toBe('new_comment');
    expect(crit?.severity).toBe('critical');
    expect(crit?.path).toBe('proxy/canary.go');
    expect(crit?.line).toBe(84);
    expect(crit?.side).toBe('RIGHT');

    expect(reply?.action).toBe('reply_in_thread');
    if (reply?.action === 'reply_in_thread') {
      expect(reply.thread_id).toBe('PRT_abc');
    }

    expect(supp?.action).toBe('suppress');
    if (supp?.action === 'suppress') {
      expect(supp.thread_id).toBe('PRT_xyz');
    }

    expect(result.summary).toContain('Canary timing sampler');
    expect(result.strengths).toHaveLength(2);
  });

  it('handles delta-clean with empty findings', () => {
    const result = extractFindings(read('delta-clean'));
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('Delta clean');
  });

  it('parses a review with a complete confidence block', () => {
    const result = extractFindings(read('full'));
    expect(result.confidence).toBeDefined();
    expect(result.confidence?.tier).toBe(2);
    expect(result.confidence?.score).toBe('B+');
    expect(result.confidence?.rationale).toContain('wrap-on-cast');
    expect(result.confidence?.rounds).toBe(1);
    expect(result.confidence?.unresolved_critical).toBe(1);
    expect(result.confidence?.unresolved_important).toBe(1);
    expect(result.confidence?.unresolved_minor).toBe(0);
    expect(result.confidence?.simplification_applied).toBe(false);
    expect(result.confidence?.skipped_reason).toBeNull();
  });

  it('accepts a review with no confidence object (optional)', () => {
    const result = extractFindings(read('delta-clean'));
    expect(result.confidence).toBeUndefined();
  });

  it('accepts confidence.rationale/tier/score as null (claude routinely emits null over undefined)', () => {
    const reply = '\n```json\n' + JSON.stringify({
      summary: 'x',
      findings: [],
      strengths: [],
      confidence: {
        tier: null,
        score: null,
        rationale: null,
        rounds: 0,
        unresolved_critical: 0,
        unresolved_important: 0,
        unresolved_minor: 0,
        simplification_applied: false,
        skipped_reason: null,
      },
    }) + '\n```';
    const result = extractFindings(reply);
    expect(result.confidence?.tier).toBeNull();
    expect(result.confidence?.score).toBeNull();
    expect(result.confidence?.rationale).toBeNull();
  });

  it('throws ExtractError on malformed JSON in fence', () => {
    expect(() => extractFindings(read('malformed'))).toThrow(ExtractError);
  });

  it('throws ExtractError when no JSON fence is present', () => {
    expect(() => extractFindings(read('no-fence'))).toThrow(ExtractError);
  });

  it('synthesizes empty review when no fence but prose says "Delta clean"', () => {
    const reply = 'Review complete. Delta clean — all 7 prior threads verified resolved; no critical or important new findings raised.';
    const result = extractFindings(reply, { reviewType: 'delta' });
    expect(result.findings).toEqual([]);
    expect(result.strengths).toEqual([]);
    expect(result.summary).toContain('Delta clean');
  });

  it('synthesizes empty review for "no findings" prose only in delta context', () => {
    const reply = 'Reviewed. No critical findings, no important findings.';
    const result = extractFindings(reply, { reviewType: 'delta' });
    expect(result.findings).toEqual([]);
    expect(result.summary).toBeTruthy();
  });

  it('rejects no-fence "no findings" prose in full-review context', () => {
    const reply = 'Reviewed. No critical findings, no important findings.';
    expect(() => extractFindings(reply, { reviewType: 'full' })).toThrow(ExtractError);
  });

  it('rejects new_comment missing path/line/side', () => {
    const reply = '\n```json\n{ "summary": "x", "findings": [{ "action": "new_comment", "severity": "critical", "message": "x" }], "strengths": [] }\n```';
    expect(() => extractFindings(reply)).toThrow(ExtractError);
  });

  it('rejects reply_in_thread missing thread_id', () => {
    expect(() => extractFindings(read('missing-thread-id'))).toThrow(ExtractError);
  });

  it('rejects suppress missing thread_id', () => {
    const reply = '\n```json\n{ "summary": "x", "findings": [{ "action": "suppress", "severity": "minor", "path": "a.go", "line": 1, "side": "RIGHT", "message": "x" }], "strengths": [] }\n```';
    expect(() => extractFindings(reply)).toThrow(ExtractError);
  });

  it('accepts resolve_thread action with thread_id', () => {
    const reply = '\n```json\n{ "summary": "x", "findings": [{ "action": "resolve_thread", "severity": "important", "path": "a.go", "line": 1, "side": "RIGHT", "thread_id": "PRT_z", "message": "fixed by removing the call site" }], "strengths": [] }\n```';
    const result = extractFindings(reply);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.action).toBe('resolve_thread');
    if (result.findings[0]?.action === 'resolve_thread') {
      expect(result.findings[0].thread_id).toBe('PRT_z');
    }
  });

  it('rejects resolve_thread missing thread_id', () => {
    const reply = '\n```json\n{ "summary": "x", "findings": [{ "action": "resolve_thread", "severity": "important", "path": "a.go", "line": 1, "side": "RIGHT", "message": "x" }], "strengths": [] }\n```';
    expect(() => extractFindings(reply)).toThrow(ExtractError);
  });

  it('rejects unknown action value', () => {
    const reply = '\n```json\n{ "summary": "x", "findings": [{ "action": "wat", "severity": "minor", "path": "a.go", "line": 1, "side": "RIGHT", "message": "x" }], "strengths": [] }\n```';
    expect(() => extractFindings(reply)).toThrow(ExtractError);
  });

  it('truncates ExtractError.raw when no-fence input exceeds RAW_MAX', () => {
    const oversize = 'x'.repeat(5_000);
    try {
      extractFindings(oversize);
      throw new Error('expected ExtractError');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError);
      const raw = (err as ExtractError).raw;
      expect(raw.length).toBeLessThan(oversize.length);
      expect(raw.length).toBeLessThanOrEqual(2_000 + 64);
    }
  });

  it('leaves ExtractError.raw unchanged when no-fence input is below RAW_MAX', () => {
    const small = 'no fence here, just prose';
    try {
      extractFindings(small);
      throw new Error('expected ExtractError');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError);
      expect((err as ExtractError).raw).toBe(small);
    }
  });

  it('appends a truncation suffix indicating the dropped byte count', () => {
    const oversize = 'x'.repeat(5_000);
    try {
      extractFindings(oversize);
      throw new Error('expected ExtractError');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError);
      expect((err as ExtractError).raw).toMatch(/…\[truncated 3000B\]$/);
    }
  });

  it('uses the last valid JSON fence when earlier fences are prompt examples', () => {
    const example = '\n```json\n{ "summary": "example only", "findings": [{ "action": "wat" }], "strengths": [] }\n```\n';
    const actual = '\n```json\n{ "summary": "final", "findings": [], "strengths": [] }\n```\n';
    const result = extractFindings(`${example}${actual}`);
    expect(result.summary).toBe('final');
    expect(result.findings).toEqual([]);
  });

  it('accepts a fence without a newline before the closing backticks', () => {
    const reply = '```json\n{"summary":"x","findings":[],"strengths":[]}\n```';
    const result = extractFindings(reply);
    expect(result.summary).toBe('x');
  });
});
