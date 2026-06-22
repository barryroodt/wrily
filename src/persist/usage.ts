/**
 * Pure usage reconciliation: turn a gantry run's NDJSON event stream (or, for
 * fake runners in workflow tests, the per-result `tokenUsage`) into a
 * persistable {@link ReviewRunRecord} plus its {@link SubagentRecord}
 * breakdown.
 *
 * Closure invariant the records must satisfy:
 *   - team:   Σ subagent rows + coordinator row == run totals
 *   - single: the sole `single` row == run totals
 *   - no events (fake): Σ aggregate rows == run totals
 *
 * Extracted out of `persistUsageStep` so the intricate coordinator-by-
 * subtraction reconciliation is unit-testable in isolation (the step body is
 * now a thin adapter).
 */
import type { AgentEvent, AgentResult } from '../agent/runner.js';
import { costForTokens, type ModelRates } from '../agent/models.js';
import type { ReviewRunRecord, SubagentRecord } from './types.js';

/**
 * Run-record fields fixed upstream of reconciliation — everything except the
 * model slug and the token/duration/cost totals this module computes.
 */
export type UsageRunBase = Omit<
  ReviewRunRecord,
  | 'model'
  | 'duration_ms'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens'
  | 'cost_usd'
>;

export interface BuildUsageOptions {
  /** Canonical slug the gantry run used; stamped on the run + event-path rows. */
  runSlug: string;
  /** Per-MTok rates for {@link runSlug}; `undefined` ⇒ all costs are 0. */
  rates: ModelRates | undefined;
  /** Run-record fields fixed upstream (repo, pr, status, mode, scope, …). */
  base: UsageRunBase;
  /** Review mode — selects team (coordinator-by-subtraction) vs single (one row). */
  reviewMode: 'single' | 'team';
  /**
   * Run-duration seed for the events path (`result?.durationMs ?? 0`); the
   * terminal `result` event's `duration_ms` overrides it when present.
   */
  resultDurationMs: number;
  /** Agent results — used only on the no-events (fake runner) fallback path. */
  results: readonly AgentResult[];
  /** Model stamped on fallback rows when a fake result omits its own (`cfg.model`). */
  defaultModel: string;
}

export interface UsageRecords {
  run: ReviewRunRecord;
  subagents: SubagentRecord[];
}

/**
 * Reconcile `events` (or the no-events fallback) into `{ run, subagents }`.
 * See the module docstring for the closure invariant this preserves.
 */
export function buildUsageRecords(
  events: AgentEvent[] | undefined,
  opts: BuildUsageOptions,
): UsageRecords {
  const { runSlug, rates, base, reviewMode, resultDurationMs, results, defaultModel } = opts;

  if (events && events.length > 0) {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let runDuration = resultDurationMs;
    let sumInput = 0;
    let sumOutput = 0;
    let sumCacheRead = 0;
    let sumCacheWrite = 0;
    let coordinatorDuration = 0;
    const subRows: SubagentRecord[] = [];

    for (const e of events) {
      switch (e.event) {
        case 'result':
          totalInput = e.total_input;
          totalOutput = e.total_output;
          totalCacheRead = e.total_cache_read;
          totalCacheWrite = e.total_cache_write;
          runDuration = e.duration_ms;
          break;
        case 'subagent_done':
          sumInput += e.input_tokens;
          sumOutput += e.output_tokens;
          sumCacheRead += e.cache_read;
          sumCacheWrite += e.cache_write;
          subRows.push({
            role: e.name,
            model: runSlug,
            duration_ms: e.duration_ms,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            cache_read_tokens: e.cache_read,
            cache_write_tokens: e.cache_write,
            cost_usd: costForTokens(rates, {
              input: e.input_tokens,
              output: e.output_tokens,
              cacheRead: e.cache_read,
              cacheWrite: e.cache_write,
            }),
          });
          break;
        case 'agent_turn':
          if (e.role === 'coordinator') coordinatorDuration += e.duration_ms;
          break;
        default:
          break;
      }
    }

    const runVec = {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    };

    let subagents: SubagentRecord[];
    if (reviewMode === 'team') {
      // m7: a clamp at 0 would otherwise hide a breached invariant (subagent
      // rows over-reporting beyond the run total). Surface it loudly first.
      if (
        totalInput - sumInput < 0 ||
        totalOutput - sumOutput < 0 ||
        totalCacheRead - sumCacheRead < 0 ||
        totalCacheWrite - sumCacheWrite < 0
      ) {
        console.warn(
          '[buildUsageRecords] subagent token sums exceed run totals; coordinator ' +
            'row clamped to 0 — closure invariant breached (Σ rows > run total)',
        );
      }
      const coordVec = {
        input: Math.max(0, totalInput - sumInput),
        output: Math.max(0, totalOutput - sumOutput),
        cacheRead: Math.max(0, totalCacheRead - sumCacheRead),
        cacheWrite: Math.max(0, totalCacheWrite - sumCacheWrite),
      };
      subRows.push({
        role: 'coordinator',
        model: runSlug,
        duration_ms: coordinatorDuration,
        input_tokens: coordVec.input,
        output_tokens: coordVec.output,
        cache_read_tokens: coordVec.cacheRead,
        cache_write_tokens: coordVec.cacheWrite,
        cost_usd: costForTokens(rates, coordVec),
      });
      subagents = subRows;
    } else {
      // m2: single mode emits exactly one `single` row == run totals. gantry
      // emits no `subagent_done` and no `coordinator` agent_turn in single mode,
      // so there is nothing to subtract — and the old code mislabeled this row
      // `coordinator` with a 0 duration. The row's duration is the run duration.
      subagents = [
        {
          role: 'single',
          model: runSlug,
          duration_ms: runDuration,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_tokens: totalCacheRead,
          cache_write_tokens: totalCacheWrite,
          cost_usd: costForTokens(rates, runVec),
        },
      ];
    }

    const run: ReviewRunRecord = {
      ...base,
      model: runSlug,
      duration_ms: runDuration,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_tokens: totalCacheRead,
      cache_write_tokens: totalCacheWrite,
      cost_usd: costForTokens(rates, runVec),
    };
    return { run, subagents };
  }

  // No events (fake runners): one aggregate row per result, role by mode, costs
  // taken straight off each result's `tokenUsage`. Keeps workflow tests real.
  const totals = results.reduce(
    (acc, r) => {
      const u = r.tokenUsage;
      if (!u) return acc;
      acc.input += u.inputTokens;
      acc.output += u.outputTokens;
      acc.cacheRead += u.cacheReadTokens ?? 0;
      acc.cacheWrite += u.cacheWriteTokens ?? 0;
      acc.cost += u.costUsd ?? 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const subagents: SubagentRecord[] = results.map((r) => ({
    role: reviewMode === 'team' ? 'coordinator' : 'single',
    model: r.model ?? defaultModel,
    duration_ms: r.durationMs,
    input_tokens: r.tokenUsage?.inputTokens ?? 0,
    output_tokens: r.tokenUsage?.outputTokens ?? 0,
    cache_read_tokens: r.tokenUsage?.cacheReadTokens ?? 0,
    cache_write_tokens: r.tokenUsage?.cacheWriteTokens ?? 0,
    cost_usd: r.tokenUsage?.costUsd ?? 0,
  }));
  const run: ReviewRunRecord = {
    ...base,
    model: results[0]?.model ?? defaultModel,
    duration_ms: totalDuration,
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_tokens: totals.cacheRead,
    cache_write_tokens: totals.cacheWrite,
    cost_usd: totals.cost,
  };
  return { run, subagents };
}
