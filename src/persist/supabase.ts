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
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
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

export async function queryCosts(env: RuntimeEnv, query: CostsQuery): Promise<CostsResult> {
  if (!env.supabase) throw new Error('Supabase persistence is not configured.');
  const { url, serviceRoleKey } = env.supabase;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const view =
    query.by === 'repo' ? 'spend_by_repo_30d' :
    query.by === 'model' ? 'spend_by_model_30d' :
    null;
  const target = view ? `${url}/rest/v1/${view}?select=*` : buildDayRollupUrl(url, query);
  const filtered = query.repo && view === 'spend_by_repo_30d'
    ? `${target}&github_repo=eq.${encodeURIComponent(query.repo)}`
    : target;
  const res = await fetch(filtered, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase query failed: ${res.status} ${body}`);
  }
  const rows = (await res.json()) as CostsResult['rows'];
  return { rows };
}

function buildDayRollupUrl(url: string, query: CostsQuery): string {
  const since = new Date(Date.now() - query.sinceDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: 'inserted_at,github_repo,model,cost_usd,input_tokens,output_tokens',
    'inserted_at': `gte.${since}`,
    status: 'eq.success',
    order: 'inserted_at.desc',
  });
  if (query.repo) params.append('github_repo', `eq.${query.repo}`);
  return `${url}/rest/v1/review_runs?${params.toString()}`;
}
