import type { WorkflowState } from '../workflow/state.js';
import type { Review, Finding, Confidence, Verdict } from './extract.js';

const CONFIDENCE_SKIP_NOTICE =
  '_Confidence rating skipped — declare an application criticality tier in CLAUDE.md or AGENTS.md to enable._';

const VERDICT_LABELS: Record<Verdict, string> = {
  ready: 'Ready to merge',
  'with-fixes': 'With fixes',
  'not-ready': 'Not ready',
};

/**
 * Render the full GitHub PR review body from workflow state. The model emits
 * JSON only; this renderer is responsible for producing the human-readable
 * markdown body that gets posted on its behalf.
 *
 * Body shape:
 *
 *   ## Wrily Review: PR #<n>[ (delta since L<short_sha>)]
 *
 *   <one-line summary>
 *
 *   ## Automated Review Summary
 *
 *   **Confidence: <score>** — <rationale>
 *
 *   ### Score breakdown
 *
 *   ### Critical / Important / Minor — bulleted findings at each severity
 *
 *   ### Strengths — bulleted (full reviews only)
 *
 *   <!-- wrily-review-handoff ... -->
 *   <!-- auto-reviewer: ... -->
 *
 * Delta-clean (delta + zero findings) collapses to a single line plus the
 * two trailing HTML comments.
 */
export function renderReviewBody(state: WorkflowState): string {
  const review: Review | undefined = state.reviews?.[0];
  const reviewType = state.reviewType ?? 'full';
  const reviewMode = state.reviewMode ?? 'single';
  const prNumber = state.env.prNumber;
  const commitSha = state.env.commitSha;
  const baseSha = state.lastReviewedSha ?? state.env.baseBranch;
  const shortReviewedSha = (state.lastReviewedSha ?? '').slice(0, 7);

  const rawFindings: Finding[] = review?.findings ?? [];
  const findings = visibleFindings(state, rawFindings);
  const summary = review?.summary?.trim() ?? '';
  const strengths = review?.strengths ?? [];
  const confidence = review?.confidence;
  const suppressed = state.suppressedActions ?? [];

  const handoffRounds = state.reviewRoundIndex ?? state.env.reviewRoundIndex ?? confidence?.rounds ?? 0;
  const severityCounts = {
    critical: countSeverity(findings, 'critical'),
    important: countSeverity(findings, 'important'),
    minor: countSeverity(findings, 'minor'),
  };
  const handoff = renderHandoff({
    reviewType,
    rounds: handoffRounds,
    unresolvedCritical: severityCounts.critical,
    unresolvedImportant: severityCounts.important,
    unresolvedMinor: severityCounts.minor,
    simplificationApplied: confidence?.simplification_applied ?? false,
  });
  const watermark = `<!-- auto-reviewer: commit=${commitSha}, mode=${reviewMode}, type=${reviewType}, base=${baseSha} -->`;

  // Delta-clean: zero findings on a delta review — single line + trailers.
  if (reviewType === 'delta' && findings.length === 0 && suppressed.length === 0) {
    const shaLabel = shortReviewedSha || 'unknown';
    return [`Delta clean — no new findings since L${shaLabel}.`, '', handoff, watermark].join('\n');
  }

  const lines: string[] = [];
  const title = reviewType === 'delta' && shortReviewedSha
    ? `## Wrily Review: PR #${prNumber} (delta since L${shortReviewedSha})`
    : `## Wrily Review: PR #${prNumber}`;
  lines.push(title);
  lines.push('');

  if (reviewType !== 'delta') {
    const verdict = review?.verdict ?? deriveVerdict(findings);
    lines.push(`### Overall Verdict: ${VERDICT_LABELS[verdict]}`);
    lines.push('');
  }

  if (reviewType !== 'delta') {
    lines.push('### Summary');
    lines.push(summary || '(no summary provided)');
    lines.push('');
  } else if (summary) {
    lines.push(summary);
    lines.push('');
  }

  const confidenceBlock = renderConfidenceBlock(confidence, handoffRounds, severityCounts);
  lines.push(confidenceBlock);
  lines.push('');

  for (const severity of ['critical', 'important', 'minor'] as const) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0 && reviewType === 'delta') continue;
    lines.push(`### ${capitalise(severity)}`);
    if (group.length === 0) {
      lines.push('None.');
    } else {
      for (const f of group) {
        lines.push(`- L${f.line}: ${f.path} — ${f.message}`);
      }
    }
    lines.push('');
  }

  if (reviewType !== 'delta') {
    lines.push('### Strengths');
    if (strengths.length === 0) {
      lines.push('None.');
    } else {
      for (const s of strengths) {
        lines.push(`- ${s}`);
      }
    }
    lines.push('');
  }

  // Suppressions section. Full reviews always render the header (None. when
  // empty) so the audit trail is visible. Delta reviews only render when
  // there's content — keeps delta-clean and delta-with-findings terse.
  if (reviewType !== 'delta' || suppressed.length > 0) {
    lines.push('### Suppressions');
    if (suppressed.length === 0) {
      lines.push('None.');
    } else {
      for (const s of suppressed) {
        lines.push(`- \`${s.threadId}\` — ${s.reason}`);
      }
    }
    lines.push('');
  }

  lines.push(handoff);
  lines.push(watermark);
  return lines.join('\n');
}

function deriveVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'critical')) return 'not-ready';
  if (findings.some((f) => f.severity === 'important')) return 'with-fixes';
  return 'ready';
}

function visibleFindings(state: WorkflowState, rawFindings: Finding[]): Finding[] {
  if (state.actions) {
    return state.actions.map((a) => a.finding);
  }
  return rawFindings.filter((f) => f.action === 'new_comment' || f.action === 'reply_in_thread');
}

function renderConfidenceBlock(
  confidence: Confidence | undefined,
  rounds: number,
  severityCounts: Record<'critical' | 'important' | 'minor', number>,
): string {
  if (!confidence || confidence.score === null || confidence.score === undefined) {
    return CONFIDENCE_SKIP_NOTICE;
  }
  const rationale = confidence.rationale?.trim();
  const tier = confidence.tier === null || confidence.tier === undefined
    ? 'not declared'
    : `Tier ${confidence.tier}`;
  return [
    '## Automated Review Summary',
    '',
    rationale ? `**Confidence: ${confidence.score}** — ${rationale}` : `**Confidence: ${confidence.score}**`,
    '',
    '### Score breakdown',
    `- criticality_tier: ${tier}`,
    `- rounds: ${rounds}`,
    `- unresolved_critical: ${severityCounts.critical}`,
    `- unresolved_important: ${severityCounts.important}`,
    `- unresolved_minor: ${severityCounts.minor}`,
    `- simplification_applied: ${confidence.simplification_applied}`,
  ].join('\n');
}

function renderHandoff(args: {
  reviewType: string;
  rounds: number;
  unresolvedCritical: number;
  unresolvedImportant: number;
  unresolvedMinor: number;
  simplificationApplied: boolean;
}): string {
  return [
    '<!-- wrily-review-handoff',
    `review_type: ${args.reviewType}`,
    `rounds: ${args.rounds}`,
    `unresolved_critical: ${args.unresolvedCritical}`,
    `unresolved_important: ${args.unresolvedImportant}`,
    `unresolved_minor: ${args.unresolvedMinor}`,
    `simplification_applied: ${args.simplificationApplied}`,
    '-->',
  ].join('\n');
}

function countSeverity(findings: Finding[], severity: 'critical' | 'important' | 'minor'): number {
  return findings.filter((f) => f.severity === severity).length;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
