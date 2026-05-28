import type { RuntimeEnv } from '../config/types.js';
import type { ReviewRunRecord, SubagentRecord, CostsQuery, CostsResult } from './types.js';

export function isPersistenceEnabled(env: RuntimeEnv): boolean {
  return !!env.supabase;
}

const RETRY_DELAYS_MS = [250, 1000];

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 250);
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function postWithRetry(
  url: string,
  serviceRoleKey: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let lastStatus = 0;
  let lastBody: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastStatus = 0;
      lastBody = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, jitter(delay)));
      continue;
    }
    if (res.ok) {
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: true, status: res.status, data };
    }
    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');
    if (!shouldRetry(res.status)) break;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await new Promise((r) => setTimeout(r, jitter(delay)));
  }
  return { ok: false, status: lastStatus, data: lastBody };
}

function logPersistError(label: string, detail: unknown): void {
  console.warn(JSON.stringify({
    level: 'warn',
    ts: new Date().toISOString(),
    component: 'persist',
    label,
    detail,
  }));
}

export async function recordReviewRun(
  env: RuntimeEnv,
  run: ReviewRunRecord,
  subagents: SubagentRecord[],
): Promise<void> {
  if (!env.supabase) return;
  const { url, serviceRoleKey } = env.supabase;

  const parentRes = await postWithRetry(
    `${url}/rest/v1/review_runs`,
    serviceRoleKey,
    run,
  );
  if (!parentRes.ok) {
    logPersistError('parent-insert-failed', { status: parentRes.status, body: parentRes.data });
    return;
  }

  const inserted = parentRes.data as Array<{ id?: string }> | null;
  const parentId = inserted?.[0]?.id;
  if (!parentId) {
    logPersistError('parent-insert-no-id', { data: parentRes.data });
    return;
  }

  if (subagents.length === 0) return;

  const childBody = subagents.map((s) => ({ ...s, run_id: parentId }));
  const childRes = await postWithRetry(
    `${url}/rest/v1/review_subagent_runs`,
    serviceRoleKey,
    childBody,
  );
  if (!childRes.ok) {
    logPersistError('child-insert-failed', { status: childRes.status, body: childRes.data });
  }
}

type RawRunRow = {
  inserted_at: string;
  github_repo: string;
  model: string;
  review_mode: 'single' | 'team';
  cost_usd: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
};

function roundTo6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Aggregate raw run rows by the requested axis on the client side. The
 * pre-built views in 0002_views.sql are still handy in Supabase Studio
 * but the CLI ignores them so that `--since`, `--repo`, and `--by day`
 * all interact correctly with a single code path.
 */
export function aggregateRuns(rows: RawRunRow[], by: 'repo' | 'model' | 'day'): CostsResult['rows'] {
  type Acc = { runs: number; cost: number; tokens: number };
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const key =
      by === 'repo' ? r.github_repo :
      by === 'model' ? `${r.model}|${r.review_mode}` :
      r.inserted_at.slice(0, 10); // YYYY-MM-DD
    const acc = groups.get(key) ?? { runs: 0, cost: 0, tokens: 0 };
    acc.runs += 1;
    acc.cost += Number(r.cost_usd);
    acc.tokens += Number(r.input_tokens) + Number(r.output_tokens);
    groups.set(key, acc);
  }
  const out: CostsResult['rows'] = [];
  for (const [key, acc] of groups) {
    if (by === 'repo') {
      out.push({ github_repo: key, runs: acc.runs, cost_usd: roundTo6(acc.cost), total_tokens: acc.tokens });
    } else if (by === 'model') {
      const [model, review_mode] = key.split('|');
      out.push({
        model: model!,
        review_mode: review_mode!,
        runs: acc.runs,
        cost_usd: roundTo6(acc.cost),
        avg_cost_usd: roundTo6(acc.cost / acc.runs),
      });
    } else {
      out.push({ day: key, runs: acc.runs, cost_usd: roundTo6(acc.cost), total_tokens: acc.tokens });
    }
  }
  if (by === 'day') {
    out.sort((a, b) => String(b.day).localeCompare(String(a.day)));
  } else {
    out.sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd));
  }
  return out;
}

export async function queryCosts(env: RuntimeEnv, query: CostsQuery): Promise<CostsResult> {
  if (!env.supabase) throw new Error('Supabase persistence is not configured.');

  // `--repo` filters by github_repo, which the model rollup deliberately
  // spans across (a model's cost dynamic is the same regardless of repo).
  // Rather than silently drop the filter, fail loudly so the operator can
  // pick a combination that returns the data they asked for.
  if (query.repo && query.by === 'model') {
    throw new Error('--repo cannot be combined with --by model (model rollup spans repos)');
  }

  const { url, serviceRoleKey } = env.supabase;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  const since = new Date(Date.now() - query.sinceDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: 'inserted_at,github_repo,model,review_mode,cost_usd,input_tokens,output_tokens',
    'inserted_at': `gte.${since}`,
    status: 'eq.success',
    order: 'inserted_at.desc',
    limit: '10000',
  });
  if (query.repo) params.append('github_repo', `eq.${query.repo}`);

  const res = await fetch(`${url}/rest/v1/review_runs?${params.toString()}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase query failed: ${res.status} ${body}`);
  }
  const rows = (await res.json()) as RawRunRow[];
  return { rows: aggregateRuns(rows, query.by) };
}
