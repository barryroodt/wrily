import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFindings, type Finding } from '../../src/post/extract.js';

// Unify-contract pin. The gantry cutover routes the agent's review JSON out of
// the NDJSON event stream: GantryRunner concatenates coordinator-role
// `assistant_text` (team) / single-role (single) into AgentResult.stdout, and
// extractFindingsStep feeds that stdout straight into extractFindings(). This
// suite pins that seam — the unify-phase contract wrily's profile
// (profiles/review/unify.md + the rendered --unify-file) instructs gantry to
// emit MUST satisfy extract.ts's reviewSchema. Drift between the profile fork
// and the schema is caught here, BEFORE a real review silently drops findings.

const FIXDIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/gantry');

/**
 * Mirror of GantryRunner.finalAssistantText() (src/agent/gantry.ts): the string
 * that becomes AgentResult.stdout from an NDJSON stream — concatenated
 * coordinator-role assistant_text (team), else single-role, else every
 * assistant_text in emission order. This is exactly what extractFindingsStep
 * hands to extractFindings(), so driving fixtures through it pins the real seam
 * (NDJSON event → stdout → schema), not just the schema in isolation.
 */
function unifyStdout(ndjson: string): string {
  const segments: { role: string; text: string }[] = [];
  for (const line of ndjson.split('\n')) {
    if (line.trim().length === 0) continue;
    let ev: { event?: string; role?: string; text?: string };
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // malformed lines are skipped by the runner too
    }
    if (ev.event === 'assistant_text' && typeof ev.text === 'string') {
      segments.push({ role: ev.role ?? '', text: ev.text });
    }
  }
  const roleText = (role: string): string =>
    segments
      .filter((s) => s.role === role)
      .map((s) => s.text)
      .join('');
  return roleText('coordinator') || roleText('single') || segments.map((s) => s.text).join('');
}

const threadId = (f: Finding): string | undefined =>
  f.action === 'new_comment' ? undefined : f.thread_id;

describe('unify-contract pin — gantry unify output parses against extract.ts', () => {
  it('real captured team run (happy-team.ndjson) unify output parses', () => {
    // happy-team.ndjson is generated verbatim from the real gantry v0.1.0 binary
    // (see tests/fixtures/gantry/README.md). Its coordinator unify assistant_text
    // is genuine binary output — the canonical "does the profile contract still
    // round-trip through extract.ts" check.
    const stdout = unifyStdout(readFileSync(join(FIXDIR, 'happy-team.ndjson'), 'utf8'));
    expect(stdout).toContain('```json'); // the seam actually surfaced fenced JSON

    const review = extractFindings(stdout);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.action).toBe('new_comment');
    expect(review.verdict).toBe('with-fixes');
  });

  // No committed fixture exercises the digest-driven actions, and F1 left no
  // reusable capture mock (the content-routed HTTP server used to generate the
  // committed fixtures was ephemeral; rig-harness/ is empty). This stream is
  // therefore derived from happy-team.ndjson's exact event envelope — a team run
  // seeded with prior wrily threads — with the coordinator unify payload swapped
  // for the full four-action contract. It is the same "derive a state the local
  // dummy provider can't produce on demand from a captured stream" approach the
  // F1 fixtures README documents for malformed-line / eof-no-result.
  const digestUnify = {
    summary: 'Unified review reconciling prior wrily threads across the correctness and security lanes.',
    verdict: 'with-fixes' as const,
    findings: [
      {
        action: 'new_comment',
        severity: 'important',
        path: 'src/auth/token.ts',
        line: 42,
        side: 'RIGHT',
        message: 'exp is never checked — reject expired tokens before trusting claims.',
      },
      {
        action: 'reply_in_thread',
        severity: 'important',
        path: 'src/auth/token.ts',
        line: 17,
        side: 'RIGHT',
        thread_id: 'PRRT_kwDOabc123',
        message: 'Still unaddressed: the null branch returns 200 with an empty body.',
      },
      {
        action: 'suppress',
        severity: 'minor',
        path: 'src/util/log.ts',
        line: 8,
        side: 'RIGHT',
        thread_id: 'PRRT_kwDOdef456',
        message: 'Pre-existing nit outside this diff; not actionable in this review.',
      },
      {
        action: 'resolve_thread',
        severity: 'important',
        path: 'src/db/pool.ts',
        line: 90,
        side: 'RIGHT',
        thread_id: 'PRRT_kwDOghi789',
        message: 'Connection leak fixed in this revision; prior thread fully addressed.',
      },
    ],
    strengths: ['New code path is well covered by tests.'],
    confidence: {
      rounds: 2,
      unresolved_critical: 0,
      unresolved_important: 1,
      unresolved_minor: 0,
      simplification_applied: false,
    },
  };
  const digestUnifyText = '```json\n' + JSON.stringify(digestUnify, null, 2) + '\n```';
  const digestSeededNdjson = [
    JSON.stringify({ event: 'start', ts: 1, schema_version: '1.1', model: 'dummy', provider: 'local', mode: 'team', workdir: '/wd' }),
    JSON.stringify({ event: 'subagent_spawn', ts: 2, name: 'correctness', scope: 'full' }),
    JSON.stringify({ event: 'subagent_spawn', ts: 3, name: 'security', scope: 'full' }),
    JSON.stringify({ event: 'subagent_done', ts: 4, name: 'correctness', turns: 2, input_tokens: 400, output_tokens: 120, cache_read: 0, cache_write: 0, duration_ms: 1 }),
    JSON.stringify({ event: 'subagent_done', ts: 5, name: 'security', turns: 2, input_tokens: 400, output_tokens: 120, cache_read: 0, cache_write: 0, duration_ms: 1 }),
    JSON.stringify({ event: 'assistant_text', ts: 6, role: 'coordinator', text: digestUnifyText }),
    JSON.stringify({ event: 'changes', ts: 7, files: [] }),
    JSON.stringify({ event: 'result', ts: 8, exit: 'ok', total_input: 1000, total_output: 320, total_cache_read: 0, total_cache_write: 0, duration_ms: 20 }),
  ].join('\n');

  it('digest-seeded unify output (reply_in_thread / suppress / resolve_thread) parses', () => {
    const stdout = unifyStdout(digestSeededNdjson);
    const review = extractFindings(stdout);

    expect(review.findings.map((f) => f.action)).toEqual([
      'new_comment',
      'reply_in_thread',
      'suppress',
      'resolve_thread',
    ]);

    // Every thread-scoped action carries the thread_id extract.ts requires; the
    // bare new_comment carries none.
    for (const f of review.findings) {
      if (f.action === 'new_comment') {
        expect(threadId(f)).toBeUndefined();
      } else {
        expect(threadId(f)).toMatch(/^PRRT_/);
      }
    }

    expect(review.verdict).toBe('with-fixes');
    expect(review.confidence?.unresolved_important).toBe(1);
  });
});
