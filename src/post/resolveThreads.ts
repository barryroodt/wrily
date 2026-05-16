import type { PriorFeedbackDigest, Thread } from './digest.js';
import type { Finding } from './extract.js';
import type { SuppressedAction } from './route.js';

const MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const FIVE_XX = (err: any) => err?.status >= 500 && err?.status < 600;

async function withRetries<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!FIVE_XX(err) || i === max) throw err;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function isExplicitlyResolved(t: Thread, resolvedThreadIds: Set<string>): boolean {
  if (t.resolved) return false;
  if (!resolvedThreadIds.has(t.thread_id)) return false;
  return t.comments.some((c) => c.is_wrily);
}

export type ResolveThreadsArgs = {
  digest: PriorFeedbackDigest;
  findings: Finding[];
  suppressedActions?: SuppressedAction[];
  graphqlClient: { graphql: (query: string, vars?: Record<string, unknown>) => Promise<any> };
};

export async function resolveAddressedThreads(
  args: ResolveThreadsArgs,
): Promise<{ resolvedThreadIds: string[] }> {
  const resolved: string[] = [];
  const requestedResolveThreadIds = new Set(
    (args.suppressedActions ?? [])
      .filter((a) => a.action === 'resolve_thread')
      .map((a) => a.threadId),
  );

  for (const t of args.digest.threads) {
    if (!isExplicitlyResolved(t, requestedResolveThreadIds)) continue;
    try {
      await withRetries(() => args.graphqlClient.graphql(MUTATION, { threadId: t.thread_id }));
      resolved.push(t.thread_id);
    } catch (err: any) {
      console.warn(
        `[resolveAddressedThreads] thread_id=${t.thread_id} status=${err?.status ?? '?'} — logging + skipping: ${err?.message ?? err}`,
      );
    }
  }

  return { resolvedThreadIds: resolved };
}
