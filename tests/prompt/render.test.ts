import { describe, it, expect } from 'vitest';
import { renderReviewPrompt, renderUnifyPrompt } from '../../src/prompt/render.js';
import type { PromptContext, UnifyPromptContext } from '../../src/prompt/render.js';

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
};

describe('renderReviewPrompt', () => {
  it('substitutes all placeholders and leaves none unfilled', () => {
    const out = renderReviewPrompt(baseCtx);
    expect(out).toContain('PR #42');
    expect(out).toContain('org/repo');
    expect(out).toContain('main..HEAD');
    expect(out).toContain('## Style: Terse');
    expect(out).toContain('Full review.');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('renderUnifyPrompt', () => {
  const unifyCtx: UnifyPromptContext = {
    prNumber: 7,
    githubRepository: 'org/repo',
    reviewerCount: 3,
    reviewerReports: '### Reviewer 1: correctness\n\n```json\n{"findings":[]}\n```',
    styleInstruction: '## Style: Terse',
    sensitivityInstruction: '',
    deltaCleanInstruction: '',
    resolveThreadsInstruction: '',
    confidenceInstruction: '',
    reviewTypeNote: 'Full review.',
  };

  it('embeds reviewer reports and the merge instruction, leaving no placeholders', () => {
    const out = renderUnifyPrompt(unifyCtx);
    expect(out).toContain('PR #7');
    expect(out).toContain('### Reviewer 1: correctness');
    expect(out).toContain('3 independent reviewer reports');
    expect(out).toMatch(/consolidat|unif|merge/i);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
