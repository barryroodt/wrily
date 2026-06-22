import { describe, it, expect } from 'vitest';
import { renderReviewPrompt, renderUnifyFile } from '../../src/prompt/render.js';
import type { PromptContext, UnifyFileContext } from '../../src/prompt/render.js';

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

describe('renderUnifyFile', () => {
  const unifyCtx: UnifyFileContext = {
    prNumber: 7,
    githubRepository: 'org/repo',
    styleInstruction: '## Style: Terse',
    sensitivityInstruction: '',
    deltaCleanInstruction: '',
    resolveThreadsInstruction: '',
    confidenceInstruction: '',
    priorFeedbackInstruction: '',
    reviewTypeNote: 'Full review.',
  };

  it('emits the full four-action JSON contract and leaves no placeholders', () => {
    const out = renderUnifyFile(unifyCtx);
    expect(out).toContain('PR #7');
    expect(out).toContain('"action": "new_comment"');
    expect(out).toContain('"action": "reply_in_thread"');
    expect(out).toContain('"action": "suppress"');
    expect(out).toContain('"action": "resolve_thread"');
    expect(out).toMatch(/consolidat|unif|merge/i);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
