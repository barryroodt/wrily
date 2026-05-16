// NOTE: `${PR_NUMBER}`, `${REVIEW_TYPE}`, `${DIFF_RANGE}`, `${LAST_REVIEWED_SHA}`,
// `${REVIEW_ROUND_INDEX}`, `${ACTOR}` etc. are intentionally left as literal
// placeholder tokens in the returned strings. They are substituted later by the
// prompt renderer (Task 10), not by JS interpolation. The escape sequence
// `\${PR_NUMBER}` is required to keep them literal inside template literals.

import type { Style, Sensitivity, ReviewType } from '../config/types.js';

const PRIOR_FEEDBACK_SEVERITY_SCOPE =
  'Apply this severity filter only to `new_comment` findings. Do not drop `suppress`, `resolve_thread`, or `reply_in_thread` prior-feedback actions because of the sensitivity floor.';

// style_instruction <terse|verbose>
// Echoes the comment-style instruction injected as ${STYLE_INSTRUCTION}.
// Scope: applies to each finding's `message` field AND the top-level `summary` field.
export function styleInstruction(style: Style | string): string {
  if (style === 'verbose') {
    return `**Comment style:** For each finding's \`message\` field and for the top-level \`summary\` field, write full prose. Explain context for non-trivial findings. Reference exact file:line in the message and include the *why* behind each suggestion.
`;
  }
  // terse (default and fallback)
  return `**Comment style:** Apply the \`caveman-review\` skill (auto-loaded from \`~/.claude/skills/caveman-review/\`) to every finding's \`message\` field AND to the top-level \`summary\` field.

- Per-finding messages: one line, format \`<problem>. <fix>.\` Drop throat-clearing, hedging, and restating the diff.
- Summary: fragments OK, no pleasantries. One-line headers (e.g. \`2 critical, 1 important.\` or \`Delta clean.\`).

Full prose reserved for security/architecture findings where the *why* genuinely needs prose.
`;
}

// sensitivity_instruction <minor|important|critical>
// Echoes the severity-floor instruction injected as ${SENSITIVITY_INSTRUCTION}.
// Filtering is performed by the model; no post-hoc severity parsing in shell.
export function sensitivityInstruction(sensitivity: Sensitivity | string): string {
  if (sensitivity === 'minor') {
    return `**Severity filter:** Include all findings regardless of severity (Critical, Important, Minor).
`;
  }
  if (sensitivity === 'critical') {
    return `**Severity filter:** Include only Critical findings in the JSON output. Count Important and Minor findings; if either count is greater than zero, append "N important + M minor findings hidden — lower sensitivity in .wrily.yml to see." to the summary. Omit the line entirely if both counts are zero. ${PRIOR_FEEDBACK_SEVERITY_SCOPE}
`;
  }
  // important (default and fallback)
  if (sensitivity !== 'important') {
    // Mirror bash: warn to stderr on unrecognized sensitivity, default to important.
    // eslint-disable-next-line no-console
    console.warn(
      `WARNING: unrecognized sensitivity='${sensitivity}' (expected minor|important|critical). Defaulting to important.`,
    );
  }
  return `**Severity filter:** Include only Critical and Important findings in the JSON output. Count Minor findings; if the count N is greater than zero, append "N minor findings hidden — set sensitivity: minor in .wrily.yml to see." to the summary. Omit the line entirely if N=0. ${PRIOR_FEEDBACK_SEVERITY_SCOPE}
`;
}

// delta_clean_instruction — no-op.
// Workflow renders the delta-clean body from empty findings + confidence; the
// model emits `{findings: [], strengths: [], confidence: {...}}` like any review.
export function deltaCleanInstruction(_reviewType: ReviewType | string, _sha: string = ''): string {
  return '';
}

export function confidenceInstruction(roundIndex: number | undefined): string {
  const rounds = roundIndex ?? 0;
  return [
    '## Confidence Rating',
    '',
    'Compute a merge-confidence score. The final GitHub body is rendered by Wrily, so do not emit prose outside the JSON fence. Render the confidence-rating Markdown block semantically by populating the top-level `confidence` JSON field:',
    '',
    '```json',
    '{',
    '  "summary": "...",',
    '  "findings": [...],',
    '  "strengths": [...],',
    '  "confidence": {',
    '    "tier": 1,                  // 1-4; null if criticality tier could not be determined',
    '    "score": "A-",              // letter grade A+/A/A-/B+/B/B-/C+/C/C-/D/F, or null if skipped',
    '    "rationale": "<one line>",  // why this score; required when score is non-null',
    `    "rounds": ${rounds},       // host-loop iteration index (do not re-derive)`,
    '    "unresolved_critical": 0,',
    '    "unresolved_important": 0,',
    '    "unresolved_minor": 0,',
    '    "simplification_applied": false,',
    '    "skipped_reason": null      // populate only when score=null; e.g. "no criticality tier declared in CLAUDE.md/AGENTS.md"',
    '  }',
    '}',
    '```',
    '',
    'Read application criticality tier from `CLAUDE.md` or `AGENTS.md` if declared. If neither declares a tier, set `score: null` and populate `skipped_reason`. Do not invent a tier.',
    '',
    'Wrily will render these fields into the confidence-rating block and the `wrily-review-handoff` comment:',
    '',
    '```markdown',
    '## Automated Review Summary',
    '**Confidence: <score>**',
    '<!-- wrily-review-handoff',
    'review_type: <full|delta>',
    `rounds: ${rounds}`,
    'unresolved_critical: <count>',
    'unresolved_important: <count>',
    'unresolved_minor: <count>',
    'simplification_applied: <bool>',
    '-->',
    '```',
    '',
    'Counts (`unresolved_critical`/`important`/`minor`) MUST equal unresolved active findings (`new_comment` and `reply_in_thread`) at each severity in this same JSON output. Exclude `suppress` and `resolve_thread` prior-feedback actions.',
  ].join('\n');
}

// resolve_threads_instruction — no-op.
// `resolveAddressedThreadsStep` (src/post/resolveThreads.ts) handles explicit
// `resolve_thread` findings post-review.
export function resolveThreadsInstruction(
  _replyFeedback: 'on' | 'off' | string,
  _digestPath: string,
): string {
  return '';
}

// prior_feedback_instruction <on|off> <digest_path>
// Echoes the prompt section that tells Claude how to consult prior feedback.
// Empty when reply_feedback is off — prompt skips suppression handling.
export function priorFeedbackInstruction(
  mode: 'on' | 'off' | string,
  digestPath: string,
): string {
  if (mode !== 'on' || !digestPath) return '';
  return `## Prior Feedback (suppression / reply-in-thread)

Before composing each finding, consult \`${digestPath}\` for prior PR review-thread
state. The digest is JSON with shape:

\`\`\`json
{
  "threads": [
    {"thread_id": "PRT_…", "path": "…", "line": 42, "diff_side": "RIGHT", "resolved": <bool>,
     "comments": [
       {"author": "…", "is_wrily": <bool>, "is_authorized": <bool>, "body": "…"}, …
     ]}
  ],
  "pr_comments": [...]
}
\`\`\`

For each issue you would otherwise raise, find a matching thread by \`(path, line, semantic match)\`.
If the matching thread is \`resolved: true\` OR contains a non-Wrily comment with \`is_authorized: true\`,
enter dispute judgment. Set the finding's \`action\` field accordingly:

- \`"action": "suppress"\` + \`"thread_id": "PRT_…"\` — author's reply convinces you the issue is invalid or already addressed. Wrily will record the suppression without posting or resolving the thread.
- \`"action": "resolve_thread"\` + \`"thread_id": "PRT_…"\` — current PR state has fully addressed a prior unresolved Wrily thread (e.g. the unsafe path was removed). Only use for unresolved Wrily-authored threads. Wrily will mark the thread resolved.
- \`"action": "reply_in_thread"\` + \`"thread_id": "PRT_…"\` — re-surface the issue in the existing thread (default for re-raises).
- \`"action": "new_comment"\` — ignore prior feedback only when you have substantive new evidence; explain in the message ("Author replied: '<excerpt>'. Re-raising because…").

Do NOT impose a severity floor — judge each issue on its merits.

The \`summary\` field MUST include a "Suppressions" line counting every \`suppress\` and \`resolve_thread\` action, even when there are no other findings (e.g. "Delta clean — 2 prior items suppressed, 1 thread resolved.").
`;
}

// trigger_context_instruction <trigger_source> <actor>
// Echoes a one-paragraph context block when this review was re-requested via
// PR comment (TRIGGER_SOURCE != "push"). Empty for push-triggered reviews.
export function triggerContextInstruction(triggerSource: string, actor: string): string {
  const source = triggerSource || 'push';
  if (source === 'push') return '';
  const actorLabel = actor || 'unknown';
  return `## Trigger Context

This review was re-requested via PR comment by **${actorLabel}** (trigger_source: \`${source}\`). Same head SHA as the most recent push, but the author asked for a fresh look — likely because they want a specific concern reconsidered or believe a prior finding can now be retired. If the latest PR comment alongside the trigger contains substantive text, take it as additional context for what to focus on.
`;
}
