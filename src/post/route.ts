import type { Finding, NewCommentFinding } from './extract.js';
import type { PriorFeedbackDigest } from './digest.js';

export type RoutedAction =
  | { action: 'new_comment'; finding: NewCommentFinding }
  | { action: 'reply'; finding: Finding; threadId: string };

export type SuppressedAction = {
  action: 'suppress' | 'resolve_thread';
  threadId: string;
  reason: string;
};

export type RouteResult = {
  actions: RoutedAction[];
  suppressedActions: SuppressedAction[];
};

function reraiseAsNewComment(f: Finding): NewCommentFinding {
  return {
    action: 'new_comment',
    severity: f.severity,
    path: f.path,
    line: f.line,
    side: f.side,
    message: f.message,
  };
}

export function routeFindings(
  findings: Finding[],
  digest: PriorFeedbackDigest,
): RouteResult {
  const actions: RoutedAction[] = [];
  const suppressedActions: SuppressedAction[] = [];
  const knownThreadIds = new Set(digest.threads.map((t) => t.thread_id));

  for (const f of findings) {
    if (f.action === 'new_comment') {
      actions.push({ action: 'new_comment', finding: f });
      continue;
    }

    if (f.action === 'reply_in_thread') {
      if (knownThreadIds.has(f.thread_id)) {
        actions.push({ action: 'reply', finding: f, threadId: f.thread_id });
      } else {
        console.warn(
          `[route] reply_in_thread thread_id=${f.thread_id} not in digest; re-raising as inline new_comment at ${f.path}:${f.line}`,
        );
        actions.push({ action: 'new_comment', finding: reraiseAsNewComment(f) });
      }
      continue;
    }

    if (f.action === 'suppress' || f.action === 'resolve_thread') {
      if (knownThreadIds.has(f.thread_id)) {
        suppressedActions.push({ action: f.action, threadId: f.thread_id, reason: f.message });
      } else {
        console.warn(
          `[route] ${f.action} thread_id=${f.thread_id} not in digest; re-raising as inline new_comment at ${f.path}:${f.line}`,
        );
        actions.push({ action: 'new_comment', finding: reraiseAsNewComment(f) });
      }
      continue;
    }
  }

  return { actions, suppressedActions };
}
