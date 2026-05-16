import { describe, it, expect } from 'vitest';
import { renderReviewBody } from '../../src/post/body.js';
import type { WorkflowState } from '../../src/workflow/state.js';
import type { Review } from '../../src/post/extract.js';

const baseEnv: WorkflowState['env'] = {
  authMethod: 'oauth',
  anthropicApiKey: null,
  claudeCodeOauthToken: 'sk-ant-oat01-x',
  githubToken: 'gho_x',
  prNumber: 42,
  githubRepository: 'org/repo',
  baseBranch: 'main',
  commitSha: 'cafebabe1234567890',
  sharedRepo: 'your-org/shared-wrily-skills',
  sharedToken: '',
  wrilyBotLogin: 'wrily',
  reviewRoundIndex: 0,
  scopeOverride: '',
  modeOverride: '', replyFeedbackOverride: '',
  modelOverride: '',
  maxBudgetOverride: null,
  dryRun: false,
  prAuthorLogin: 'human-dev',
  triggerSource: 'push',
  actor: 'human-dev',
};

const baseCfg: WorkflowState['cfg'] = {
  model: 'opus',
  mode: 'single',
  team_threshold: 5,
  team_threshold_unit: 'files',
  max_budget_usd: null,
  ignore: [],
  shared_skills: [],
  request_changes: false,
  style: 'terse',
  sensitivity: 'minor',
  reply_feedback: 'off',
};

function makeState(review: Review, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    env: baseEnv,
    cfg: baseCfg,
    reviewMode: 'single',
    reviewType: 'full',
    reviews: [review],
    findings: review.findings,
    ...overrides,
  };
}

describe('renderReviewBody', () => {
  it('renders a full review with all severities + strengths + handoff + watermark', () => {
    const review: Review = {
      summary: 'Two real concerns; one nit.',
      findings: [
        { action: 'new_comment', severity: 'critical', path: 'a.ts', line: 10, side: 'RIGHT', message: 'X — fix Y.' },
        { action: 'new_comment', severity: 'important', path: 'b.ts', line: 20, side: 'RIGHT', message: 'P — try Q.' },
        { action: 'new_comment', severity: 'minor', path: 'c.ts', line: 30, side: 'RIGHT', message: 'tiny.' },
      ],
      strengths: ['clean naming', 'good tests'],
    };
    const body = renderReviewBody(makeState(review));
    expect(body).toContain('## Wrily Review: PR #42');
    expect(body).toContain('### Overall Verdict: Not ready');
    expect(body).toContain('### Summary');
    expect(body).toContain('Two real concerns; one nit.');
    expect(body).toContain('### Critical');
    expect(body).toContain('- L10: a.ts — X — fix Y.');
    expect(body).toContain('### Important');
    expect(body).toContain('- L20: b.ts — P — try Q.');
    expect(body).toContain('### Minor');
    expect(body).toContain('- L30: c.ts — tiny.');
    expect(body).toContain('### Strengths');
    expect(body).toContain('- clean naming');
    expect(body).toContain('<!-- wrily-review-handoff');
    expect(body).toContain('review_type: full');
    expect(body).toContain('unresolved_critical: 1');
    expect(body).toContain('unresolved_important: 1');
    expect(body).toContain('unresolved_minor: 1');
    expect(body).toContain('simplification_applied: false');
    expect(body).toContain('<!-- auto-reviewer: commit=cafebabe1234567890, mode=single, type=full, base=main -->');
  });

  it('keeps full-review severity and strengths sections stable with None placeholders', () => {
    const review: Review = { summary: 'Clean.', findings: [], strengths: [] };
    const body = renderReviewBody(makeState(review));

    expect(body).toContain('### Critical\nNone.');
    expect(body).toContain('### Important\nNone.');
    expect(body).toContain('### Minor\nNone.');
    expect(body).toContain('### Strengths\nNone.');
    expect(body).toContain('### Suppressions\nNone.');
  });

  it('renders Suppressions section with thread_id + reason when actions are present', () => {
    const review: Review = { summary: 'Clean after suppressions.', findings: [], strengths: [] };
    const body = renderReviewBody(makeState(review, {
      suppressedActions: [
        { action: 'suppress', threadId: 'PRT_a', reason: 'Author fixed; verified.' },
        { action: 'resolve_thread', threadId: 'PRT_b', reason: 'Not applicable — file removed.' },
      ],
    }));
    expect(body).toContain('### Suppressions');
    expect(body).toContain('- `PRT_a` — Author fixed; verified.');
    expect(body).toContain('- `PRT_b` — Not applicable — file removed.');
  });

  it('omits Suppressions section on delta when empty; renders when present', () => {
    const review: Review = { summary: 'D.', findings: [], strengths: [] };
    const emptyDelta = renderReviewBody(makeState(review, { reviewType: 'delta', lastReviewedSha: '1234567abcdefabcdef' }));
    expect(emptyDelta).not.toContain('### Suppressions');

    const withSupp = renderReviewBody(makeState(
      { summary: 'D with supp.', findings: [{ action: 'new_comment', severity: 'important', path: 'a.ts', line: 1, side: 'RIGHT', message: 'x.' }], strengths: [] },
      {
        reviewType: 'delta',
        lastReviewedSha: '1234567abcdefabcdef',
        suppressedActions: [{ action: 'resolve_thread', threadId: 'PRT_x', reason: 'addressed.' }],
      },
    ));
    expect(withSupp).toContain('### Suppressions');
    expect(withSupp).toContain('- `PRT_x` — addressed.');
  });

  it('does not render suppress or resolve_thread actions as active findings once routed', () => {
    const review: Review = {
      summary: 'Prior threads resolved.',
      findings: [
        {
          action: 'suppress',
          severity: 'critical',
          path: 'a.ts',
          line: 10,
          side: 'RIGHT',
          thread_id: 'PRT_s',
          message: 'Author response proves this is intentional.',
        },
        {
          action: 'resolve_thread',
          severity: 'important',
          path: 'b.ts',
          line: 20,
          side: 'RIGHT',
          thread_id: 'PRT_r',
          message: 'Unsafe path was removed.',
        },
      ],
      strengths: [],
      confidence: {
        tier: 2,
        score: 'A',
        rationale: 'Only prior-thread housekeeping remains.',
        rounds: 1,
        unresolved_critical: 1,
        unresolved_important: 1,
        unresolved_minor: 0,
        simplification_applied: false,
        skipped_reason: null,
      },
    };
    const body = renderReviewBody(makeState(review, {
      actions: [],
      suppressedActions: [
        { action: 'suppress', threadId: 'PRT_s', reason: 'Author response proves this is intentional.' },
        { action: 'resolve_thread', threadId: 'PRT_r', reason: 'Unsafe path was removed.' },
      ],
      reviewRoundIndex: 1,
    }));

    expect(body).toContain('### Overall Verdict: Ready to merge');
    expect(body).toContain('### Critical\nNone.');
    expect(body).toContain('### Important\nNone.');
    expect(body).not.toContain('- L10: a.ts');
    expect(body).not.toContain('- L20: b.ts');
    expect(body).toContain('unresolved_critical: 0');
    expect(body).toContain('unresolved_important: 0');
    expect(body).toContain('### Suppressions');
    expect(body).toContain('- `PRT_s` — Author response proves this is intentional.');
    expect(body).toContain('- `PRT_r` — Unsafe path was removed.');
  });

  it('keeps delta suppressions visible even when there are no visible findings', () => {
    const review: Review = {
      summary: 'Delta clean — 1 prior item suppressed.',
      findings: [
        {
          action: 'suppress',
          severity: 'important',
          path: 'a.ts',
          line: 10,
          side: 'RIGHT',
          thread_id: 'PRT_s',
          message: 'Author response proves this is intentional.',
        },
      ],
      strengths: [],
    };
    const body = renderReviewBody(makeState(review, {
      reviewType: 'delta',
      lastReviewedSha: '1234567abcdefabcdef',
      actions: [],
      suppressedActions: [
        { action: 'suppress', threadId: 'PRT_s', reason: 'Author response proves this is intentional.' },
      ],
    }));

    expect(body.startsWith('Delta clean — no new findings')).toBe(false);
    expect(body).toContain('## Wrily Review: PR #42 (delta since L1234567)');
    expect(body).toContain('### Suppressions');
    expect(body).toContain('- `PRT_s` — Author response proves this is intentional.');
    expect(body).toContain('unresolved_important: 0');
  });

  it('emits the delta title with short sha when reviewType=delta', () => {
    const review: Review = {
      summary: '1 important since L1234567.',
      findings: [
        { action: 'new_comment', severity: 'important', path: 'a.ts', line: 5, side: 'RIGHT', message: 'fix me.' },
      ],
      strengths: ['ignored on delta'],
    };
    const body = renderReviewBody(
      makeState(review, { reviewType: 'delta', lastReviewedSha: '1234567abcdefabcdef' }),
    );
    expect(body).toContain('## Wrily Review: PR #42 (delta since L1234567)');
    expect(body).not.toContain('### Strengths');
    expect(body).toContain('type=delta');
    expect(body).toContain('base=1234567abcdefabcdef');
  });

  it('collapses to a single line on delta-clean (delta + zero findings)', () => {
    const review: Review = { summary: '', findings: [], strengths: [] };
    const body = renderReviewBody(
      makeState(review, { reviewType: 'delta', lastReviewedSha: '1234567abcdefabcdef' }),
    );
    expect(body.startsWith('Delta clean — no new findings since L1234567.')).toBe(true);
    expect(body).not.toContain('### Critical');
    expect(body).toContain('<!-- wrily-review-handoff');
    expect(body).toContain('unresolved_critical: 0');
    expect(body).toContain('<!-- auto-reviewer:');
  });

  it('renders the confidence summary anchors when score is non-null', () => {
    const review: Review = {
      summary: 'ok.',
      findings: [],
      strengths: [],
      confidence: {
        tier: 2,
        score: 'A-',
        rationale: 'Small, well-scoped change.',
        rounds: 1,
        unresolved_critical: 0,
        unresolved_important: 0,
        unresolved_minor: 0,
        simplification_applied: false,
        skipped_reason: null,
      },
    };
    const body = renderReviewBody(makeState(review, { reviewRoundIndex: 1 }));
    expect(body).toContain('## Automated Review Summary');
    expect(body).toContain('**Confidence: A-**');
    expect(body).toContain('Small, well-scoped change.');
    expect(body).toContain('### Score breakdown');
    expect(body).toContain('rounds: 1');
  });

  it('omits the confidence line when score is null and uses derived counts', () => {
    const review: Review = {
      summary: 'ok.',
      findings: [
        { action: 'new_comment', severity: 'critical', path: 'a.ts', line: 1, side: 'RIGHT', message: 'x.' },
      ],
      strengths: [],
      confidence: {
        tier: null,
        score: null,
        rounds: 0,
        unresolved_critical: 1,
        unresolved_important: 0,
        unresolved_minor: 0,
        simplification_applied: false,
        skipped_reason: 'no criticality tier declared',
      },
    };
    const body = renderReviewBody(makeState(review));
    expect(body).not.toContain('**Merge confidence');
    expect(body).toContain('_Confidence rating skipped — declare an application criticality tier in CLAUDE.md or AGENTS.md to enable._');
    expect(body).toContain('unresolved_critical: 1');
  });

  it('renders confidence skip notice when confidence is absent', () => {
    const review: Review = { summary: 'ok.', findings: [], strengths: [] };
    const body = renderReviewBody(makeState(review));
    expect(body).toContain('_Confidence rating skipped — declare an application criticality tier in CLAUDE.md or AGENTS.md to enable._');
    expect(body).toContain('### Overall Verdict: Ready to merge');
    expect(body).toContain('### Summary');
  });

  it('uses explicit review.verdict when provided', () => {
    const review: Review = { summary: 'ok.', findings: [], strengths: [], verdict: 'with-fixes' };
    const body = renderReviewBody(makeState(review));
    expect(body).toContain('### Overall Verdict: With fixes');
  });

  it('derives verdict from severity counts when not provided', () => {
    const critical: Review = {
      summary: 's', findings: [{ action: 'new_comment', severity: 'critical', path: 'a.ts', line: 1, side: 'RIGHT', message: 'x.' }], strengths: [],
    };
    const important: Review = {
      summary: 's', findings: [{ action: 'new_comment', severity: 'important', path: 'a.ts', line: 1, side: 'RIGHT', message: 'x.' }], strengths: [],
    };
    expect(renderReviewBody(makeState(critical))).toContain('### Overall Verdict: Not ready');
    expect(renderReviewBody(makeState(important))).toContain('### Overall Verdict: With fixes');
  });

  it('falls back to derived handoff counts when no confidence is present', () => {
    const review: Review = {
      summary: 'ok.',
      findings: [
        { action: 'new_comment', severity: 'important', path: 'a.ts', line: 1, side: 'RIGHT', message: 'x.' },
      ],
      strengths: [],
    };
    const body = renderReviewBody(makeState(review, { env: { ...baseEnv, reviewRoundIndex: 3 } }));
    expect(body).toContain('rounds: 3');
    expect(body).toContain('unresolved_important: 1');
  });
});
