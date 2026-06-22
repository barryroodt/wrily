import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildUsageRecords, type UsageRunBase } from '../../src/persist/usage.js';
import type { AgentEvent, AgentResult } from '../../src/agent/runner.js';
import type { ModelRates } from '../../src/agent/models.js';
import type { SubagentRecord, ReviewRunRecord } from '../../src/persist/types.js';

const RATES: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function makeBase(reviewMode: 'single' | 'team'): UsageRunBase {
  return {
    github_repo: 'octo/repo',
    pr_number: 7,
    commit_sha: 'deadbeef',
    trigger_source: 'github_app',
    review_round: 0,
    review_mode: reviewMode,
    scope: 'full',
    max_tokens: null,
    status: 'success',
    findings_posted: 0,
  };
}

/** Σ over rows of the four token fields — the closure-invariant LHS. */
function sumRows(rows: SubagentRecord[]) {
  return rows.reduce(
    (acc, r) => ({
      input: acc.input + r.input_tokens,
      output: acc.output + r.output_tokens,
      cacheRead: acc.cacheRead + r.cache_read_tokens,
      cacheWrite: acc.cacheWrite + r.cache_write_tokens,
      cost: acc.cost + r.cost_usd,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
}

function expectClosure(run: ReviewRunRecord, subagents: SubagentRecord[]) {
  const s = sumRows(subagents);
  expect(s.input).toBe(run.input_tokens);
  expect(s.output).toBe(run.output_tokens);
  expect(s.cacheRead).toBe(run.cache_read_tokens);
  expect(s.cacheWrite).toBe(run.cache_write_tokens);
  // cost is float-linear in the (integer) token counts; rounding order differs.
  expect(s.cost).toBeCloseTo(run.cost_usd, 9);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildUsageRecords — closure invariant (Σ subagent + coordinator == run totals)', () => {
  it('team mode: per-subagent rows + coordinator-by-subtraction reconcile to run totals', () => {
    const events: AgentEvent[] = [
      { event: 'start', ts: 0, schema_version: '1.1', model: 'm', provider: 'p', mode: 'team', workdir: '/w' },
      { event: 'subagent_done', ts: 1, name: 'reviewer-a', turns: 3, input_tokens: 100, output_tokens: 40, cache_read: 10, cache_write: 5, duration_ms: 1000 },
      { event: 'subagent_done', ts: 2, name: 'reviewer-b', turns: 2, input_tokens: 200, output_tokens: 60, cache_read: 20, cache_write: 7, duration_ms: 1500 },
      { event: 'agent_turn', ts: 3, role: 'coordinator', turn: 1, input_tokens: 50, output_tokens: 30, cache_read: 5, cache_write: 2, duration_ms: 800 },
      { event: 'result', ts: 4, exit: 'ok', total_input: 400, total_output: 130, total_cache_read: 40, total_cache_write: 15, duration_ms: 5000 },
    ];

    const { run, subagents } = buildUsageRecords(events, {
      runSlug: 'anthropic/claude-opus-4-8',
      rates: RATES,
      base: makeBase('team'),
      reviewMode: 'team',
      resultDurationMs: 0,
      results: [],
      defaultModel: 'cfg/model',
    });

    expect(subagents).toHaveLength(3); // 2 subagents + 1 coordinator
    const coord = subagents.find((r) => r.role === 'coordinator');
    expect(coord).toBeDefined();
    // coordinator = run total − Σ subagent (component-wise)
    expect(coord!.input_tokens).toBe(100);
    expect(coord!.output_tokens).toBe(30);
    expect(coord!.cache_read_tokens).toBe(10);
    expect(coord!.cache_write_tokens).toBe(3);
    // coordinator duration is sourced from the coordinator agent_turn(s)
    expect(coord!.duration_ms).toBe(800);

    expect(run.input_tokens).toBe(400);
    expect(run.output_tokens).toBe(130);
    expect(run.duration_ms).toBe(5000);
    expect(run.model).toBe('anthropic/claude-opus-4-8');
    expectClosure(run, subagents);
  });

  it("single mode: one 'single' row == run totals; no coordinator, duration from run (m2)", () => {
    const events: AgentEvent[] = [
      { event: 'start', ts: 0, schema_version: '1.1', model: 'm', provider: 'p', mode: 'single', workdir: '/w' },
      { event: 'agent_turn', ts: 1, role: 'single', turn: 1, input_tokens: 500, output_tokens: 100, cache_read: 50, cache_write: 20, duration_ms: 1200 },
      { event: 'result', ts: 2, exit: 'ok', total_input: 500, total_output: 100, total_cache_read: 50, total_cache_write: 20, duration_ms: 4000 },
    ];

    const { run, subagents } = buildUsageRecords(events, {
      runSlug: 'anthropic/claude-opus-4-8',
      rates: RATES,
      base: makeBase('single'),
      reviewMode: 'single',
      resultDurationMs: 0,
      results: [],
      defaultModel: 'cfg/model',
    });

    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.role).toBe('single'); // NOT 'coordinator' (m2 fix)
    expect(subagents[0]!.input_tokens).toBe(500);
    // duration from the run total (4000), not 0 (the old coordinator-duration bug)
    expect(subagents[0]!.duration_ms).toBe(4000);
    expect(run.duration_ms).toBe(4000);
    expectClosure(run, subagents);
  });

  it('no-events fallback (fake runners): Σ aggregate rows == run totals', () => {
    const results: AgentResult[] = [
      { stdout: '', stderr: '', exitCode: 0, durationMs: 1000, model: 'mdl', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.5 } },
      { stdout: '', stderr: '', exitCode: 0, durationMs: 2000, model: 'mdl', tokenUsage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 1, costUsd: 0.3 } },
    ];

    const { run, subagents } = buildUsageRecords(undefined, {
      runSlug: 'mdl',
      rates: undefined,
      base: makeBase('single'),
      reviewMode: 'single',
      resultDurationMs: 0,
      results,
      defaultModel: 'cfg/model',
    });

    expect(subagents).toHaveLength(2);
    expect(subagents.every((r) => r.role === 'single')).toBe(true);
    expect(run.input_tokens).toBe(300);
    expect(run.output_tokens).toBe(70);
    expect(run.duration_ms).toBe(3000);
    expect(run.cost_usd).toBeCloseTo(0.8, 9);
    expectClosure(run, subagents);
  });

  it('no-events fallback with no tokenUsage at all → zeroed run, still reconciles', () => {
    const results: AgentResult[] = [
      { stdout: '', stderr: '', exitCode: 0, durationMs: 500, model: 'mdl', tokenUsage: null },
    ];
    const { run, subagents } = buildUsageRecords([], {
      runSlug: 'mdl',
      rates: RATES,
      base: makeBase('team'),
      reviewMode: 'team',
      resultDurationMs: 0,
      results,
      defaultModel: 'cfg/model',
    });
    expect(run.input_tokens).toBe(0);
    expect(run.cost_usd).toBe(0);
    expectClosure(run, subagents);
  });

  it('m7: subagent sums exceeding run totals warn and clamp the coordinator to 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: AgentEvent[] = [
      { event: 'subagent_done', ts: 1, name: 'over-reporter', turns: 1, input_tokens: 1000, output_tokens: 0, cache_read: 0, cache_write: 0, duration_ms: 100 },
      { event: 'result', ts: 2, exit: 'ok', total_input: 100, total_output: 0, total_cache_read: 0, total_cache_write: 0, duration_ms: 200 },
    ];

    const { subagents } = buildUsageRecords(events, {
      runSlug: 'mdl',
      rates: RATES,
      base: makeBase('team'),
      reviewMode: 'team',
      resultDurationMs: 0,
      results: [],
      defaultModel: 'cfg/model',
    });

    expect(warn).toHaveBeenCalledOnce();
    const coord = subagents.find((r) => r.role === 'coordinator');
    expect(coord!.input_tokens).toBe(0); // clamped, not negative
  });
});
