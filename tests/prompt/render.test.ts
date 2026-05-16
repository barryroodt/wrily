import { describe, it, expect } from 'vitest';
import { renderReviewPrompt } from '../../src/prompt/render.js';
import type { PromptContext } from '../../src/prompt/render.js';

const baseCtx: PromptContext = {
  prNumber: 42,
  githubRepository: 'org/repo',
  diffRange: 'main..HEAD',
  diffCommandInstruction: 'Run `git diff main..HEAD`.',
  ignorePatterns: '(none configured)',
  sharedContextInstruction: '',
  styleInstruction: '## Style: Terse',
  sensitivityInstruction: '## Sensitivity: important',
  deltaCleanInstruction: '',
  resolveThreadsInstruction: '',
  confidenceInstruction: '',
  priorFeedbackInstruction: '',
  triggerContextInstruction: '',
  reviewTypeNote: 'Full review.',
  reviewMode: 'single',
};

describe('renderReviewPrompt', () => {
  it('substitutes all placeholders for single mode', () => {
    const out = renderReviewPrompt(baseCtx);
    expect(out).toContain('PR #42');
    expect(out).toContain('org/repo');
    expect(out).toContain('main..HEAD');
    expect(out).toContain('## Style: Terse');
    expect(out).toContain('Full review.');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('uses team template for team mode', () => {
    const out = renderReviewPrompt({ ...baseCtx, reviewMode: 'team' });
    expect(out).toMatch(/team lead|review team|coordinating a team/i);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('throws on unsubstituted placeholder (defensive)', () => {
    const broken = { ...baseCtx, prNumber: undefined as any };
    expect(() => renderReviewPrompt(broken)).toThrow();
  });
});
