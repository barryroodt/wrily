import { describe, it, expect, vi } from 'vitest';
import {
  styleInstruction,
  sensitivityInstruction,
  deltaCleanInstruction,
  resolveThreadsInstruction,
  confidenceInstruction,
  priorFeedbackInstruction,
  triggerContextInstruction,
} from '../../src/prompt/instructions.js';

describe('styleInstruction', () => {
  // Terse references caveman-review skill, names per-finding message field + summary field.
  it('returns terse rules referencing caveman-review skill and per-finding message field', () => {
    const out = styleInstruction('terse');
    expect(out).toContain('caveman-review');
    expect(out).toContain('`message` field');
    expect(out).toContain('`summary` field');
  });

  // Verbose drops caveman, uses "full prose", still references the message + summary fields.
  it('returns verbose rules with full prose phrasing, no caveman ref', () => {
    const out = styleInstruction('verbose');
    expect(out).toContain('full prose');
    expect(out).toContain('`message` field');
    expect(out).toContain('`summary` field');
    expect(out).not.toContain('caveman-review');
  });

  // Unknown values fall back to terse.
  it('falls back to terse for unknown values', () => {
    const out = styleInstruction('wenyan' as unknown as 'terse');
    expect(out).toContain('caveman-review');
    expect(out).toEqual(styleInstruction('terse'));
  });
});

describe('sensitivityInstruction', () => {
  // Minor includes all findings.
  it('includes all findings for minor', () => {
    const out = sensitivityInstruction('minor');
    expect(out).toContain('Include all findings');
  });

  // Important threshold + JSON output wording + N=0 omission.
  it('drops minor for important; counts + N=0 omission', () => {
    const out = sensitivityInstruction('important');
    expect(out).toContain('Include only Critical and Important');
    expect(out).toContain('in the JSON output');
    expect(out).toContain('minor findings hidden');
    expect(out).toContain('Omit the line entirely if N=0');
    expect(out).toContain('set sensitivity: minor in .wrily.yml to see.');
    expect(out).toContain('Apply this severity filter only to `new_comment` findings');
    expect(out).toContain('Do not drop `suppress`, `resolve_thread`, or `reply_in_thread`');
    expect(out).not.toContain('post');
  });

  // Critical threshold + both-counts hidden line; JSON wording.
  it('only critical for critical; both counts hidden line', () => {
    const out = sensitivityInstruction('critical');
    expect(out).toContain('Include only Critical findings');
    expect(out).toContain('in the JSON output');
    expect(out).toContain('important + M minor');
    expect(out).toContain('Omit the line entirely if both counts are zero');
    expect(out).toContain('lower sensitivity in .wrily.yml to see.');
    expect(out).toContain('Apply this severity filter only to `new_comment` findings');
    expect(out).toContain('Do not drop `suppress`, `resolve_thread`, or `reply_in_thread`');
    expect(out).not.toContain('post');
  });

  // Unknown falls back to important + warns to stderr.
  it('warns and falls back to important for unknown sensitivity', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = sensitivityInstruction('wenyan' as unknown as 'important');
      expect(out).toContain('Include only Critical and Important');
      expect(out).toEqual(sensitivityInstruction('important'));
      // Confirm the warning fired at least once for the unknown value (not for the recursive
      // 'important' call we use to verify equality).
      const calls = warnSpy.mock.calls.flat().join(' ');
      expect(calls).toContain("unrecognized sensitivity='wenyan'");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('deltaCleanInstruction', () => {
  // Stripped: workflow renders the delta-clean body from empty findings + confidence.
  it('returns empty string for delta', () => {
    expect(deltaCleanInstruction('delta', 'abc1234deadbeef')).toBe('');
  });

  it('returns empty string for full', () => {
    expect(deltaCleanInstruction('full', 'any-sha')).toBe('');
  });
});

describe('confidenceInstruction', () => {
  it('preserves confidence-rating prompt anchors and host-loop fields', () => {
    const out = confidenceInstruction(2);
    expect(out).toContain('## Confidence Rating');
    expect(out).toContain('confidence-rating');
    expect(out).toContain('Render the confidence-rating Markdown block');
    expect(out).toContain('wrily-review-handoff');
    expect(out).toContain('rounds: 2');
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('unresolved_critical');
  });

  it('falls back to rounds: 0 when index is undefined', () => {
    const out = confidenceInstruction(undefined);
    expect(out).toContain('rounds: 0');
  });
});

describe('resolveThreadsInstruction', () => {
  // Stripped: resolveAddressedThreadsStep handles this heuristically.
  it('returns empty string regardless of inputs', () => {
    expect(resolveThreadsInstruction('on', '/tmp/digest.json')).toBe('');
    expect(resolveThreadsInstruction('off', '/tmp/digest.json')).toBe('');
    expect(resolveThreadsInstruction('on', '')).toBe('');
  });
});

describe('priorFeedbackInstruction', () => {
  it('returns empty when mode is off', () => {
    expect(priorFeedbackInstruction('off', '/tmp/prior-feedback.json')).toBe('');
  });

  it('returns empty when digest path is missing even with mode on', () => {
    expect(priorFeedbackInstruction('on', '')).toBe('');
  });

  it('emits the suppression / reply-in-thread block with digest path interpolated', () => {
    const out = priorFeedbackInstruction('on', '/tmp/prior-feedback.json');
    expect(out).toContain('## Prior Feedback (suppression / reply-in-thread)');
    expect(out).toContain('`/tmp/prior-feedback.json`');
    expect(out).toContain('"threads"');
    expect(out).toContain('"pr_comments"');
  });

  it('lists the action field decision modes (suppress / resolve_thread / reply_in_thread / new_comment)', () => {
    const out = priorFeedbackInstruction('on', '/tmp/digest.json');
    expect(out).toContain('"action": "suppress"');
    expect(out).toContain('"action": "resolve_thread"');
    expect(out).toContain('"action": "reply_in_thread"');
    expect(out).toContain('"action": "new_comment"');
  });

  it('distinguishes suppress audit actions from resolve_thread mutations', () => {
    const out = priorFeedbackInstruction('on', '/tmp/digest.json');
    expect(out).toContain('Wrily will record the suppression without posting or resolving the thread');
    expect(out).toContain('Wrily will mark the thread resolved');
  });

  it('mandates a Suppressions line in the summary field', () => {
    const out = priorFeedbackInstruction('on', '/tmp/digest.json');
    expect(out).toContain('"Suppressions" line');
    expect(out).toContain('`summary` field');
  });

  it('does not impose a severity floor on prior-feedback judgments', () => {
    const out = priorFeedbackInstruction('on', '/tmp/digest.json');
    expect(out).toContain('Do NOT impose a severity floor');
  });

  it('flags non-Wrily authorized comments as dispute-judgment triggers', () => {
    const out = priorFeedbackInstruction('on', '/tmp/digest.json');
    expect(out).toContain('is_authorized');
    expect(out).toContain('dispute judgment');
  });
});

describe('triggerContextInstruction', () => {
  it('returns empty when triggerSource is push', () => {
    expect(triggerContextInstruction('push', 'someone')).toBe('');
  });

  it('returns empty when triggerSource is empty (defaults to push)', () => {
    expect(triggerContextInstruction('', 'someone')).toBe('');
  });

  it('emits the context block with actor and trigger_source for non-push triggers', () => {
    const out = triggerContextInstruction('comment', 'octocat');
    expect(out).toContain('## Trigger Context');
    expect(out).toContain('**octocat**');
    expect(out).toContain('trigger_source: `comment`');
    expect(out).toContain('re-requested via PR comment');
  });

  it('falls back to "unknown" actor when actor is empty', () => {
    const out = triggerContextInstruction('comment', '');
    expect(out).toContain('**unknown**');
  });
});
