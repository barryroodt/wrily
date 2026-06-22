import { describe, it, expect, vi } from 'vitest';
import {
  postReview,
  postInlineReviewComment,
  replyInThread,
  updateCheckRun,
  postFailureComment,
} from '../../src/post/github.js';

const mkClient = () => ({
  rest: {
    pulls: {
      createReview: vi.fn().mockResolvedValue({ data: { id: 1, html_url: 'http://gh/r/1' } }),
      createReplyForReviewComment: vi.fn().mockResolvedValue({ data: { id: 2 } }),
      createReviewComment: vi.fn().mockResolvedValue({ data: { id: 3 } }),
    },
    issues: {
      createComment: vi.fn().mockResolvedValue({ data: { id: 4 } }),
    },
    checks: {
      create: vi.fn().mockResolvedValue({ data: { id: 99 } }),
      update: vi.fn().mockResolvedValue({ data: { id: 99 } }),
    },
  },
});

const baseArgs = {
  owner: 'org',
  repo: 'repo',
  prNumber: 42,
  commitSha: 'abc1234',
};

const sampleComment = { path: 'a.ts', line: 1, side: 'RIGHT' as const, body: 'finding' };

describe('postReview', () => {
  it('creates a COMMENT review with body and inline comments (happy path)', async () => {
    const client = mkClient();
    const result = await postReview(client as any, {
      ...baseArgs,
      body: '## Review',
      event: 'COMMENT',
      comments: [sampleComment],
    });
    expect(client.rest.pulls.createReview).toHaveBeenCalledOnce();
    expect(result.fallbackUsed).toBe(false);
  });

  it('logs a diagnostic before POST', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = mkClient();
    await postReview(client as any, { ...baseArgs, body: '## R', event: 'COMMENT', comments: [sampleComment] });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/review.*comments=1/i));
    log.mockRestore();
  });

  it('on 422: strips comments, retries body-only, posts each comment standalone', async () => {
    const client = mkClient();
    const err422 = Object.assign(new Error('Unprocessable'), { status: 422 });
    let calls = 0;
    client.rest.pulls.createReview = vi.fn().mockImplementation(async (args: any) => {
      calls++;
      if (calls === 1 && args.comments?.length) throw err422;
      return { data: { id: 1, html_url: 'http://gh/r/1' } };
    });

    const goodComment = { path: 'good.ts', line: 1, side: 'RIGHT' as const, body: 'ok' };
    const badComment  = { path: 'bad.ts',  line: 1, side: 'RIGHT' as const, body: 'will-422' };

    client.rest.pulls.createReviewComment = vi.fn().mockImplementation(async (args: any) => {
      if (args.path === 'bad.ts') throw err422;
      return { data: { id: 99 } };
    });

    const result = await postReview(client as any, {
      ...baseArgs,
      body: '## R',
      event: 'COMMENT',
      comments: [goodComment, badComment],
    });

    expect(calls).toBe(2);
    expect(client.rest.pulls.createReviewComment).toHaveBeenCalledTimes(2);
    expect(result.fallbackUsed).toBe(true);
    expect(result.failedComments).toEqual([{ path: 'bad.ts', line: 1, side: 'RIGHT' }]);
  });

  it('throws when body-only retry also fails on 422', async () => {
    const client = mkClient();
    const err422 = Object.assign(new Error('Unprocessable'), { status: 422 });
    client.rest.pulls.createReview = vi.fn().mockRejectedValue(err422);

    await expect(
      postReview(client as any, { ...baseArgs, body: '## R', event: 'COMMENT', comments: [sampleComment] }),
    ).rejects.toThrow(/Unprocessable/);
  });

  it('retries review POST 3× on 5xx', async () => {
    vi.useFakeTimers();
    try {
      const client = mkClient();
      const err500 = Object.assign(new Error('Server'), { status: 500 });
      let calls = 0;
      client.rest.pulls.createReview = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 4) throw err500;
        return { data: { id: 1, html_url: 'http://gh/r/1' } };
      });

      const promise = postReview(client as any, {
        ...baseArgs, body: '## R', event: 'COMMENT', comments: [sampleComment],
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(calls).toBe(4);
      expect(result.fallbackUsed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('postInlineReviewComment', () => {
  it('posts a positioned, threaded standalone review comment', async () => {
    const client = mkClient();
    await postInlineReviewComment(client as any, { ...baseArgs, ...sampleComment });
    expect(client.rest.pulls.createReviewComment).toHaveBeenCalledOnce();
    expect(client.rest.pulls.createReviewComment.mock.calls[0]?.[0]).toMatchObject({
      owner: 'org', repo: 'repo', pull_number: 42, commit_id: 'abc1234',
      path: 'a.ts', line: 1, side: 'RIGHT',
    });
  });
});

describe('replyInThread', () => {
  it('passes the numeric in-reply-to comment id straight through to REST', async () => {
    const client = mkClient();
    await replyInThread(client as any, {
      ...baseArgs, inReplyToCommentId: 12345, body: 'reply',
    });
    expect(client.rest.pulls.createReplyForReviewComment).toHaveBeenCalledOnce();
    expect(client.rest.pulls.createReplyForReviewComment.mock.calls[0]?.[0]).toMatchObject({
      owner: 'org', repo: 'repo', pull_number: 42, comment_id: 12345,
    });
  });

  it('logs and skips on 422 (does not fall back to new top-level comment)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    const err422 = Object.assign(new Error('Unprocessable'), { status: 422 });
    client.rest.pulls.createReplyForReviewComment = vi.fn().mockRejectedValue(err422);

    const result = await replyInThread(client as any, {
      ...baseArgs, inReplyToCommentId: 12345, body: 'reply',
    });

    expect(result.skipped).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('retries threaded replies on transient 5xx errors', async () => {
    vi.useFakeTimers();
    try {
      const client = mkClient();
      const err500 = Object.assign(new Error('Server'), { status: 500 });
      let calls = 0;
      client.rest.pulls.createReplyForReviewComment = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 4) throw err500;
        return { data: { id: 2 } };
      });

      const promise = replyInThread(client as any, {
        ...baseArgs, inReplyToCommentId: 12345, body: 'reply',
      });
      const observed: Promise<{
        result?: Awaited<ReturnType<typeof replyInThread>>;
        error?: unknown;
      }> = promise.then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      await vi.runAllTimersAsync();
      const { result, error } = await observed;
      expect(error).toBeUndefined();
      expect(result).toBeDefined();
      expect(result?.skipped).toBe(false);
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updateCheckRun', () => {
  it('marks success', async () => {
    const client = mkClient();
    await updateCheckRun(client as any, { ...baseArgs, conclusion: 'success', summary: 'ok', checkRunId: 99 });
    expect(client.rest.checks.update).toHaveBeenCalledOnce();
  });
});

describe('postFailureComment', () => {
  it('posts a review-as-COMMENT on the happy path', async () => {
    const client = mkClient();
    await postFailureComment(client as any, {
      ...baseArgs, kind: 'timeout', errMessage: 'claude CLI timed out after 30000ms',
    });
    expect(client.rest.pulls.createReview).toHaveBeenCalledOnce();
    expect(client.rest.issues.createComment).not.toHaveBeenCalled();
    const call = client.rest.pulls.createReview.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      owner: 'org', repo: 'repo', pull_number: 42, commit_id: 'abc1234', event: 'COMMENT',
    });
    expect(call.body).toMatch(/timed out/i);
    expect(call.body).toMatch(/claude CLI timed out after 30000ms/);
    expect(call.body).toMatch(/<!-- auto-reviewer: failure=timeout/);
  });

  it('renders a budget body when kind=budget', async () => {
    const client = mkClient();
    await postFailureComment(client as any, {
      ...baseArgs, kind: 'budget', errMessage: 'claude CLI budget exceeded',
    });
    const body = client.rest.pulls.createReview.mock.calls[0]?.[0].body;
    expect(body).toMatch(/budget exceeded/i);
    expect(body).toMatch(/max_tokens/);
    expect(body).toMatch(/<!-- auto-reviewer: failure=budget/);
  });

  it('renders a generic body when kind=failure', async () => {
    const client = mkClient();
    await postFailureComment(client as any, {
      ...baseArgs, kind: 'failure', errMessage: 'boom',
    });
    const body = client.rest.pulls.createReview.mock.calls[0]?.[0].body;
    expect(body).toMatch(/failed before posting findings/i);
    expect(body).toMatch(/<!-- auto-reviewer: failure=generic/);
  });

  it('falls back to issues.createComment when the review API rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    client.rest.pulls.createReview = vi.fn().mockRejectedValue(new Error('invalid commit'));

    await postFailureComment(client as any, {
      ...baseArgs, kind: 'timeout', errMessage: 'timed out',
    });

    expect(client.rest.pulls.createReview).toHaveBeenCalledOnce();
    expect(client.rest.issues.createComment).toHaveBeenCalledOnce();
    const call = client.rest.issues.createComment.mock.calls[0]?.[0];
    expect(call).toMatchObject({ owner: 'org', repo: 'repo', issue_number: 42 });
    expect(call.body).toMatch(/timed out/i);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/review API failed.*falling back/));
    warn.mockRestore();
  });

  it('logs and swallows when both the review API and the issue-comment fallback fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = mkClient();
    client.rest.pulls.createReview = vi.fn().mockRejectedValue(new Error('review fail'));
    client.rest.issues.createComment = vi.fn().mockRejectedValue(new Error('comment fail'));

    await expect(
      postFailureComment(client as any, { ...baseArgs, kind: 'failure', errMessage: 'boom' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/review API failed/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/issue-comment fallback also failed/));
    warn.mockRestore();
  });
});
