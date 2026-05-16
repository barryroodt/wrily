import { describe, it, expect, vi } from 'vitest';
import { routeFindings } from '../../src/post/route.js';
import type { Finding } from '../../src/post/extract.js';
import type { PriorFeedbackDigest, Thread } from '../../src/post/digest.js';

const newCommentFinding = (over: Partial<Finding> = {}): Finding => ({
  action: 'new_comment',
  severity: 'important',
  path: 'src/x.ts',
  line: 10,
  side: 'RIGHT',
  message: 'something off',
  ...(over as any),
}) as Finding;

const replyFinding = (threadId: string): Finding => ({
  action: 'reply_in_thread',
  severity: 'important',
  path: 'src/x.ts',
  line: 10,
  side: 'RIGHT',
  message: 'still off',
  thread_id: threadId,
});

const suppressFinding = (threadId: string): Finding => ({
  action: 'suppress',
  severity: 'minor',
  path: 'src/x.ts',
  line: 10,
  side: 'RIGHT',
  message: 'author addressed',
  thread_id: threadId,
});

const resolveThreadFinding = (threadId: string): Finding => ({
  action: 'resolve_thread',
  severity: 'important',
  path: 'src/x.ts',
  line: 10,
  side: 'RIGHT',
  message: 'unsafe path removed',
  thread_id: threadId,
});

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  thread_id: id,
  first_comment_rest_id: null,
  path: 'src/x.ts',
  line: 10,
  diff_side: 'RIGHT',
  resolved: false,
  comments: [],
  ...over,
});

const emptyDigest: PriorFeedbackDigest = { watermarkSha: null, threads: [], prComments: [], priorReviewsCount: 0 };

describe('routeFindings', () => {
  it('emits new_comment action for new_comment finding', () => {
    const result = routeFindings([newCommentFinding()], emptyDigest);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('new_comment');
    expect(result.suppressedActions).toEqual([]);
  });

  it('emits reply action when reply_in_thread thread_id matches a digest thread', () => {
    const digest: PriorFeedbackDigest = {
      watermarkSha: 'abc',
      threads: [thread('PRT_known')],
      prComments: [],
      priorReviewsCount: 0,
    };
    const result = routeFindings([replyFinding('PRT_known')], digest);
    expect(result.actions[0]?.action).toBe('reply');
    if (result.actions[0]?.action === 'reply') {
      expect(result.actions[0].threadId).toBe('PRT_known');
    }
  });

  it('re-raises reply_in_thread with unknown thread_id as inline new_comment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = routeFindings([replyFinding('PRT_unknown')], emptyDigest);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('new_comment');
    if (result.actions[0]?.action === 'new_comment') {
      expect(result.actions[0].finding.path).toBe('src/x.ts');
      expect(result.actions[0].finding.line).toBe(10);
      expect(result.actions[0].finding.side).toBe('RIGHT');
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-raises suppress with unknown thread_id as inline new_comment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = routeFindings([suppressFinding('PRT_unknown')], emptyDigest);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('new_comment');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records suppress with known thread_id in suppressedActions; emits no GH action', () => {
    const digest: PriorFeedbackDigest = {
      watermarkSha: null,
      threads: [thread('PRT_known')],
      prComments: [],
      priorReviewsCount: 0,
    };
    const result = routeFindings([suppressFinding('PRT_known')], digest);
    expect(result.actions).toEqual([]);
    expect(result.suppressedActions).toHaveLength(1);
    expect(result.suppressedActions[0]?.action).toBe('suppress');
    expect(result.suppressedActions[0]?.threadId).toBe('PRT_known');
  });

  it('routes resolve_thread (known thread) as a suppressed action — no GH comment', () => {
    const digest: PriorFeedbackDigest = {
      watermarkSha: null,
      threads: [thread('PRT_resolved')],
      prComments: [],
      priorReviewsCount: 0,
    };
    const result = routeFindings([resolveThreadFinding('PRT_resolved')], digest);
    expect(result.actions).toEqual([]);
    expect(result.suppressedActions).toHaveLength(1);
    expect(result.suppressedActions[0]?.action).toBe('resolve_thread');
    expect(result.suppressedActions[0]?.threadId).toBe('PRT_resolved');
    expect(result.suppressedActions[0]?.reason).toBe('unsafe path removed');
  });

  it('re-raises resolve_thread with unknown thread_id as inline new_comment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = routeFindings([resolveThreadFinding('PRT_unknown')], emptyDigest);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('new_comment');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
