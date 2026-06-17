import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildUsageRecords, type UsageRunBase } from '../../src/persist/usage.js';
import type {
  AgentEvent,
  AgentTurnEvent,
  SubagentDoneEvent,
  ResultEvent,
} from '../../src/agent/runner.js';
import type { ModelRates } from '../../src/agent/models.js';
import type { ReviewRunRecord, SubagentRecord } from '../../src/persist/types.js';

// Integration counterpart to usage.test.ts (RX's synthetic unit test). That file
// proves the closure algebra against hand-built event arrays; this one proves the
// SAME buildUsageRecords reconciles against F1's REAL captured gantry v0.1.0
// NDJSON (tests/fixtures/gantry/*.ndjson). Expected values are derived from each
// fixture's own `subagent_done`/`result` events, so the test asserts a reconciliation
// against actual output — not against numbers re-copied from the fixture by hand.

const RATES: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const RUN_SLUG = 'anthropic/claude-opus-4-8';

const fixturePath = (name: string) => `tests/fixtures/gantry/${name}`;

/** Parse a committed NDJSON fixture into the gantry event stream. */
function loadEvents(name: string): AgentEvent[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AgentEvent);
}

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

/** Σ over rows of the four token fields + cost — the closure-invariant LHS. */
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

/** Σ(all subagent rows incl coordinator) per token field == run record totals. */
function expectClosure(run: ReviewRunRecord, subagents: SubagentRecord[]) {
  const s = sumRows(subagents);
  expect(s.input).toBe(run.input_tokens);
  expect(s.output).toBe(run.output_tokens);
  expect(s.cacheRead).toBe(run.cache_read_tokens);
  expect(s.cacheWrite).toBe(run.cache_write_tokens);
  // cost is float-linear in the (integer) token counts; rounding order differs.
  expect(s.cost).toBeCloseTo(run.cost_usd, 9);
}

const isDone = (e: AgentEvent): e is SubagentDoneEvent => e.event === 'subagent_done';
const isResult = (e: AgentEvent): e is ResultEvent => e.event === 'result';
const isCoordTurn = (e: AgentEvent): e is AgentTurnEvent =>
  e.event === 'agent_turn' && e.role === 'coordinator';

describe('buildUsageRecords — reconciliation against real gantry fixtures', () => {
  it('team (happy-team.ndjson): one row per subagent_done + coordinator-by-subtraction reconciles to run totals', () => {
    const events = loadEvents('happy-team.ndjson');
    const doneEvents = events.filter(isDone);
    const result = events.find(isResult);
    // Sanity: the fixture is the team-vocabulary capture we think it is.
    expect(doneEvents.length).toBeGreaterThan(0);
    expect(result).toBeDefined();

    const { run, subagents } = buildUsageRecords(events, {
      runSlug: RUN_SLUG,
      rates: RATES,
      base: makeBase('team'),
      reviewMode: 'team',
      resultDurationMs: 0,
      results: [],
      defaultModel: 'cfg/model',
    });

    // N SubagentRecord rows (one per subagent_done) + exactly one coordinator row.
    const coordRows = subagents.filter((r) => r.role === 'coordinator');
    const laneRows = subagents.filter((r) => r.role !== 'coordinator');
    expect(subagents).toHaveLength(doneEvents.length + 1);
    expect(coordRows).toHaveLength(1);
    expect(laneRows).toHaveLength(doneEvents.length);

    // Roles are the real semantic names from the fixture, in stream order.
    expect(laneRows.map((r) => r.role)).toEqual(doneEvents.map((e) => e.name));
    // Concretely, this fixture's two lanes:
    expect(laneRows.map((r) => r.role)).toEqual(['correctness', 'spec-compliance']);

    // Each lane row carries that subagent_done's raw aggregate totals.
    for (const done of doneEvents) {
      const row = subagents.find((r) => r.role === done.name);
      expect(row, `lane row for ${done.name}`).toBeDefined();
      expect(row!.input_tokens).toBe(done.input_tokens);
      expect(row!.output_tokens).toBe(done.output_tokens);
      expect(row!.cache_read_tokens).toBe(done.cache_read);
      expect(row!.cache_write_tokens).toBe(done.cache_write);
      expect(row!.duration_ms).toBe(done.duration_ms);
      expect(row!.model).toBe(RUN_SLUG);
    }

    // Run totals come straight off the terminal `result` event (1600/480/0/0, dur 22).
    expect(run.input_tokens).toBe(result!.total_input);
    expect(run.output_tokens).toBe(result!.total_output);
    expect(run.cache_read_tokens).toBe(result!.total_cache_read);
    expect(run.cache_write_tokens).toBe(result!.total_cache_write);
    expect(run.duration_ms).toBe(result!.duration_ms);
    expect(run.model).toBe(RUN_SLUG);
    expect(run.input_tokens).toBe(1600);
    expect(run.output_tokens).toBe(480);
    expect(run.duration_ms).toBe(22);

    // Coordinator row is computed by subtraction: run total − Σ lane (per field).
    const lane = sumRows(laneRows);
    const coord = coordRows[0]!;
    expect(coord.input_tokens).toBe(result!.total_input - lane.input); // 1600 − 800 = 800
    expect(coord.output_tokens).toBe(result!.total_output - lane.output); // 480 − 240 = 240
    expect(coord.cache_read_tokens).toBe(result!.total_cache_read - lane.cacheRead);
    expect(coord.cache_write_tokens).toBe(result!.total_cache_write - lane.cacheWrite);
    expect(coord.input_tokens).toBe(800);
    expect(coord.output_tokens).toBe(240);
    // Coordinator duration is Σ coordinator agent_turn durations (not the run duration).
    const coordTurnDur = events.filter(isCoordTurn).reduce((s, e) => s + e.duration_ms, 0);
    expect(coord.duration_ms).toBe(coordTurnDur);
    expect(coord.duration_ms).toBe(2);

    // THE closure invariant: Σ(all rows incl coordinator) == run totals, every field.
    expectClosure(run, subagents);
  });

  const SINGLE_FIXTURE = 'happy-single.ndjson';
  const hasSingle = existsSync(fixturePath(SINGLE_FIXTURE));

  it.skipIf(!hasSingle)(
    "single (happy-single.ndjson): one 'single' row == run totals, duration from run (m2)",
    () => {
      const events = loadEvents(SINGLE_FIXTURE);
      const result = events.find(isResult);
      expect(result).toBeDefined();
      // single mode emits no subagent_done.
      expect(events.filter(isDone)).toHaveLength(0);

      const { run, subagents } = buildUsageRecords(events, {
        runSlug: RUN_SLUG,
        rates: RATES,
        base: makeBase('single'),
        reviewMode: 'single',
        resultDurationMs: 0,
        results: [],
        defaultModel: 'cfg/model',
      });

      expect(subagents).toHaveLength(1);
      const row = subagents[0]!;
      expect(row.role).toBe('single'); // NOT 'coordinator' (m2 fix)
      // The lone row equals the run totals straight off the `result` event.
      expect(row.input_tokens).toBe(result!.total_input);
      expect(row.output_tokens).toBe(result!.total_output);
      expect(row.cache_read_tokens).toBe(result!.total_cache_read);
      expect(row.cache_write_tokens).toBe(result!.total_cache_write);
      // m2: the row's duration is the run duration (12), not the agent_turn's 0/2.
      expect(row.duration_ms).toBe(result!.duration_ms);
      expect(run.duration_ms).toBe(result!.duration_ms);
      // Concretely, this fixture: 120/24/0/0, dur 12.
      expect(run.input_tokens).toBe(120);
      expect(run.output_tokens).toBe(24);
      expect(run.duration_ms).toBe(12);

      expectClosure(run, subagents);
    },
  );
});
