import { describe, it, expect, vi } from 'vitest';
import { resolveAddressedThreads } from '../../src/post/resolveThreads.js';
import type { Thread, PriorFeedbackDigest } from '../../src/post/digest.js';
import type { Finding } from '../../src/post/extract.js';

const thread = (over: Partial<Thread>): Thread => ({
  thread_id: 'PRT_x',
  first_comment_rest_id: null,
  path: 'a.go',
  line: 10,
  diff_side: 'RIGHT',
  resolved: false,
  comments: [],
  ...over,
});

const digest = (threads: Thread[]): PriorFeedbackDigest => ({
  watermarkSha: null, threads, prComments: [], priorReviewsCount: 0,
});

describe('resolveAddressedThreads', () => {
  it('does not resolve thread just because wrily → authorized reply → no current finding', async () => {
    const t = thread({
      thread_id: 'PRT_addr',
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'issue here' },
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'fixed it' },
      ],
    });
    const graphqlClient = { graphql: vi.fn().mockResolvedValue({ resolveReviewThread: { thread: { id: 'PRT_addr' } } }) };
    const result = await resolveAddressedThreads({ digest: digest([t]), findings: [], graphqlClient });
    expect(result.resolvedThreadIds).toEqual([]);
    expect(graphqlClient.graphql).not.toHaveBeenCalled();
  });

  it('does not resolve thread when the model suppresses rather than resolves it', async () => {
    const t = thread({
      thread_id: 'PRT_addr',
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'issue here' },
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'fixed it' },
      ],
    });
    const graphqlClient = { graphql: vi.fn().mockResolvedValue({ resolveReviewThread: { thread: { id: 'PRT_addr' } } }) };
    const result = await resolveAddressedThreads({
      digest: digest([t]),
      findings: [],
      suppressedActions: [{ action: 'suppress', threadId: 'PRT_addr', reason: 'author response is valid' }],
      graphqlClient,
    });
    expect(result.resolvedThreadIds).toEqual([]);
    expect(graphqlClient.graphql).not.toHaveBeenCalled();
  });

  it('resolves thread when the model explicitly emits resolve_thread', async () => {
    const t = thread({
      thread_id: 'PRT_addr',
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'issue here' },
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'fixed it' },
      ],
    });
    const graphqlClient = { graphql: vi.fn().mockResolvedValue({ resolveReviewThread: { thread: { id: 'PRT_addr' } } }) };
    const result = await resolveAddressedThreads({
      digest: digest([t]),
      findings: [],
      suppressedActions: [{ action: 'resolve_thread', threadId: 'PRT_addr', reason: 'author response is valid' }],
      graphqlClient,
    });
    expect(result.resolvedThreadIds).toEqual(['PRT_addr']);
    expect(graphqlClient.graphql).toHaveBeenCalledOnce();
  });

  it('skips thread when current findings re-raise the same path:line', async () => {
    const t = thread({
      thread_id: 'PRT_kept',
      path: 'a.go', line: 10,
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'issue' },
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'fixed' },
      ],
    });
    const finding: Finding = {
      action: 'new_comment', severity: 'important', path: 'a.go', line: 10, side: 'RIGHT', message: 'still broken',
    };
    const graphqlClient = { graphql: vi.fn() };
    const result = await resolveAddressedThreads({ digest: digest([t]), findings: [finding], graphqlClient });
    expect(result.resolvedThreadIds).toEqual([]);
    expect(graphqlClient.graphql).not.toHaveBeenCalled();
  });

  it('skips already-resolved threads', async () => {
    const t = thread({
      thread_id: 'PRT_done',
      resolved: true,
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'issue' },
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'fixed' },
      ],
    });
    const graphqlClient = { graphql: vi.fn() };
    const result = await resolveAddressedThreads({
      digest: digest([t]),
      findings: [],
      suppressedActions: [{ action: 'resolve_thread', threadId: 'PRT_done', reason: 'already fixed' }],
      graphqlClient,
    });
    expect(result.resolvedThreadIds).toEqual([]);
    expect(graphqlClient.graphql).not.toHaveBeenCalled();
  });

  it('skips threads with no Wrily authorship', async () => {
    const t = thread({
      thread_id: 'PRT_human',
      comments: [
        { author: 'human-a', is_wrily: false, is_authorized: true, body: 'thought' },
        { author: 'human-b', is_wrily: false, is_authorized: true, body: 'reply' },
      ],
    });
    const graphqlClient = { graphql: vi.fn() };
    const result = await resolveAddressedThreads({ digest: digest([t]), findings: [], graphqlClient });
    expect(result.resolvedThreadIds).toEqual([]);
  });

  it('skips threads where authorized reply precedes the most recent Wrily comment', async () => {
    const t = thread({
      thread_id: 'PRT_stale',
      comments: [
        { author: 'human-dev',     is_wrily: false, is_authorized: true,  body: 'old reply' },
        { author: 'wrily', is_wrily: true,  is_authorized: false, body: 'new issue' },
      ],
    });
    const graphqlClient = { graphql: vi.fn() };
    const result = await resolveAddressedThreads({ digest: digest([t]), findings: [], graphqlClient });
    expect(result.resolvedThreadIds).toEqual([]);
  });

  it('logs + skips per-thread on 4xx; continues with remaining', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = thread({
      thread_id: 'PRT_a',
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'a' },
        { author: 'h',             is_wrily: false, is_authorized: true,  body: 'b' },
      ],
    });
    const b = thread({
      thread_id: 'PRT_b',
      path: 'b.go',
      comments: [
        { author: 'wrily', is_wrily: true, is_authorized: false, body: 'a' },
        { author: 'h',             is_wrily: false, is_authorized: true,  body: 'b' },
      ],
    });
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const graphqlClient = {
      graphql: vi.fn()
        .mockRejectedValueOnce(err404)
        .mockResolvedValueOnce({ resolveReviewThread: { thread: { id: 'PRT_b' } } }),
    };
    const result = await resolveAddressedThreads({
      digest: digest([a, b]),
      findings: [],
      suppressedActions: [
        { action: 'resolve_thread', threadId: 'PRT_a', reason: 'fixed' },
        { action: 'resolve_thread', threadId: 'PRT_b', reason: 'fixed' },
      ],
      graphqlClient,
    });
    expect(result.resolvedThreadIds).toEqual(['PRT_b']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('retries 3× on 5xx then logs + skips', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = thread({
        thread_id: 'PRT_x',
        comments: [
          { author: 'wrily', is_wrily: true, is_authorized: false, body: 'a' },
          { author: 'h',             is_wrily: false, is_authorized: true,  body: 'b' },
        ],
      });
      const err500 = Object.assign(new Error('Server'), { status: 500 });
      const graphqlClient = { graphql: vi.fn().mockRejectedValue(err500) };
      const promise = resolveAddressedThreads({
        digest: digest([t]),
        findings: [],
        suppressedActions: [{ action: 'resolve_thread', threadId: 'PRT_x', reason: 'fixed' }],
        graphqlClient,
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.resolvedThreadIds).toEqual([]);
      expect(graphqlClient.graphql).toHaveBeenCalledTimes(4);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
