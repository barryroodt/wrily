import { describe, it, expect, vi } from 'vitest';
import { fetchPriorFeedbackDigest } from '../../src/post/digest.js';

describe('fetchPriorFeedbackDigest', () => {
  const baseEnv = {
    githubToken: 'gho_xxx',
    githubRepository: 'org/repo',
    prNumber: 42,
    wrilyBotLogin: 'wrily',
    prAuthorLogin: 'human-dev',
  };

  const emptyPage = {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [] },
        reviews: { nodes: [] },
      },
    },
  };

  it('returns empty digest when PR has no prior threads', async () => {
    const fakeClient = { graphql: vi.fn().mockResolvedValue(emptyPage) };
    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    expect(digest.threads).toEqual([]);
    expect(digest.prComments).toEqual([]);
    expect(digest.watermarkSha).toBeNull();
    expect(digest.priorReviewsCount).toBe(0);
    expect(fakeClient.graphql).toHaveBeenCalledTimes(1);
  });

  it('counts wrily-review-handoff markers across review bodies', async () => {
    const reviewsPage = (bodies: string[]) => ({
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          comments: { nodes: [] },
          reviews: { nodes: bodies.map((body) => ({ body })) },
        },
      },
    });

    // 0 prior reviews
    const fake0 = { graphql: vi.fn().mockResolvedValue(reviewsPage(['unrelated review body'])) };
    expect((await fetchPriorFeedbackDigest(baseEnv, fake0)).priorReviewsCount).toBe(0);

    // 1 prior review
    const fake1 = { graphql: vi.fn().mockResolvedValue(reviewsPage(['has wrily-review-handoff inside'])) };
    expect((await fetchPriorFeedbackDigest(baseEnv, fake1)).priorReviewsCount).toBe(1);

    // 3 prior reviews
    const fake3 = {
      graphql: vi.fn().mockResolvedValue(
        reviewsPage([
          'r1 wrily-review-handoff',
          'r2 wrily-review-handoff',
          'noise',
          'r3 wrily-review-handoff',
        ]),
      ),
    };
    expect((await fetchPriorFeedbackDigest(baseEnv, fake3)).priorReviewsCount).toBe(3);
  });

  it('paginates review threads and de-duplicates by thread_id', async () => {
    const thread = (id: string) => ({
      id,
      path: 'a.go',
      line: 1,
      diffSide: 'RIGHT',
      isResolved: false,
      comments: { nodes: [{ databaseId: 1001, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'x' }] },
    });

    const firstPage = {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [thread('PRT_a'), thread('PRT_b')], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    };
    const secondPage = {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [thread('PRT_b'), thread('PRT_c')], pageInfo: { hasNextPage: false, endCursor: null } },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    };

    const fakeClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    };

    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    expect(digest.threads.map((t) => t.thread_id).sort()).toEqual(['PRT_a', 'PRT_b', 'PRT_c']);
    expect(fakeClient.graphql).toHaveBeenCalledTimes(2);
    expect(fakeClient.graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ threadFirst: 100, threadAfter: null }),
    );
    expect(fakeClient.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ threadFirst: 100, threadAfter: 'cursor-1' }),
    );
  });

  it('caps review-thread pagination at 500 threads', async () => {
    const page = (cursor: string, offset: number) => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array.from({ length: 100 }, (_, i) => ({
              id: `PRT_${offset + i}`,
              path: 'a.go',
              line: i,
              diffSide: 'RIGHT',
              isResolved: false,
              comments: { nodes: [{ databaseId: offset + i, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'x' }] },
            })),
            pageInfo: { hasNextPage: true, endCursor: cursor },
          },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    });

    const fakeClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce(page('cursor-1', 0))
        .mockResolvedValueOnce(page('cursor-2', 100))
        .mockResolvedValueOnce(page('cursor-3', 200))
        .mockResolvedValueOnce(page('cursor-4', 300))
        .mockResolvedValueOnce(page('cursor-5', 400))
        .mockResolvedValueOnce(page('cursor-6', 500)),
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
      expect(digest.threads).toHaveLength(500);
      expect(fakeClient.graphql).toHaveBeenCalledTimes(5);
      // Surfaces silent truncation so suppression routing's truncated input is visible.
      const capWarning = warn.mock.calls
        .map((c) => String(c[0] ?? ''))
        .find((m) => m.includes('pagination capped at MAX_THREADS=500'));
      expect(capWarning).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when pagination ends naturally before MAX_THREADS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fakeClient = {
        graphql: vi.fn().mockResolvedValue({
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              comments: { nodes: [] },
              reviews: { nodes: [] },
            },
          },
        }),
      };
      await fetchPriorFeedbackDigest(baseEnv, fakeClient);
      const capWarning = warn.mock.calls
        .map((c) => String(c[0] ?? ''))
        .find((m) => m.includes('pagination capped'));
      expect(capWarning).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('strips [bot] suffix when matching WRILY_BOT_LOGIN', async () => {
    const fakeClient = {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: 'PRT_a',
                path: 'a.go',
                line: 1,
                diffSide: 'RIGHT',
                isResolved: false,
                comments: { nodes: [
                  { databaseId: 2001, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'wrily says' },
                  { databaseId: 2002, author: { login: 'human-dev' },          authorAssociation: 'MEMBER',     body: 'fixed it' },
                ]},
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      }),
    };

    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    const t = digest.threads[0]!;
    expect(t.comments[0]?.is_wrily).toBe(true);
    expect(t.comments[1]?.is_wrily).toBe(false);
    expect(t.comments[1]?.is_authorized).toBe(true); // MEMBER
  });

  it('extracts watermark SHA from prior review body marker', async () => {
    const fakeClient = {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            comments: { nodes: [] },
            reviews: { nodes: [{
              body: '## Wrily Review\n\n<!-- auto-reviewer: commit=abc1234, status=clean -->',
            }] },
          },
        },
      }),
    };
    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    expect(digest.watermarkSha).toBe('abc1234');
  });

  it('retries 3 times on 5xx errors', async () => {
    const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
    let calls = 0;
    const fakeClient = {
      graphql: vi.fn().mockImplementation(() => {
        calls++;
        if (calls < 4) return Promise.reject(err);
        return Promise.resolve(emptyPage);
      }),
    };
    vi.useFakeTimers();
    try {
      const promise = fetchPriorFeedbackDigest(baseEnv, fakeClient);
      await vi.runAllTimersAsync();
      const digest = await promise;
      expect(calls).toBeGreaterThanOrEqual(4);
      expect(digest.threads).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on 4xx without retry', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const fakeClient = { graphql: vi.fn().mockRejectedValue(err) };
    await expect(fetchPriorFeedbackDigest(baseEnv, fakeClient)).rejects.toThrow(/Not Found/);
    expect(fakeClient.graphql).toHaveBeenCalledTimes(1);
  });

  it('drops threads with no wrily participation; keeps threads with a wrily comment', async () => {
    const page = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'PRT_no_wrily',
                path: 'a.go',
                line: 1,
                diffSide: 'RIGHT',
                isResolved: false,
                comments: { nodes: [
                  { databaseId: 3001, author: { login: 'human-dev' }, authorAssociation: 'MEMBER', body: 'random discussion' },
                  { databaseId: 3002, author: { login: 'reviewer' },  authorAssociation: 'COLLABORATOR', body: 'lgtm' },
                ]},
              },
              {
                id: 'PRT_with_wrily',
                path: 'b.go',
                line: 2,
                diffSide: 'RIGHT',
                isResolved: false,
                comments: { nodes: [
                  { databaseId: 3003, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'flag' },
                  { databaseId: 3004, author: { login: 'human-dev' },          authorAssociation: 'MEMBER',      body: 'fixed' },
                ]},
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    };
    const fakeClient = { graphql: vi.fn().mockResolvedValue(page) };

    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    expect(digest.threads.map((t) => t.thread_id)).toEqual(['PRT_with_wrily']);
  });

  it('treats PR-author CONTRIBUTOR comment as authorized', async () => {
    const fakeClient = {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: 'PRT_a',
                path: 'a.go',
                line: 1,
                diffSide: 'RIGHT',
                isResolved: false,
                comments: { nodes: [
                  { databaseId: 4001, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'flag' },
                  // PR author with CONTRIBUTOR association — NOT in AUTHORIZED_ASSOC, but matches prAuthorLogin.
                  { databaseId: 4002, author: { login: 'human-dev' },          authorAssociation: 'CONTRIBUTOR', body: 'addressed' },
                  // Random contributor — should remain unauthorized.
                  { databaseId: 4003, author: { login: 'random-person' },      authorAssociation: 'CONTRIBUTOR', body: 'drive-by' },
                ]},
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      }),
    };

    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    const t = digest.threads[0]!;
    expect(t.comments[1]?.author).toBe('human-dev');
    expect(t.comments[1]?.is_authorized).toBe(true); // PR author override
    expect(t.comments[2]?.author).toBe('random-person');
    expect(t.comments[2]?.is_authorized).toBe(false); // not PR author + CONTRIBUTOR not in set
  });

  it('returns first_comment_rest_id: null when databaseId is missing (not 0)', async () => {
    const fakeClient = {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: 'PRT_no_dbid',
                path: 'a.go',
                line: 1,
                diffSide: 'RIGHT',
                isResolved: false,
                comments: { nodes: [
                  // databaseId omitted (undefined)
                  { author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'no rest id' },
                ]},
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      }),
    };

    const digest = await fetchPriorFeedbackDigest(baseEnv, fakeClient);
    expect(digest.threads).toHaveLength(1);
    expect(digest.threads[0]?.first_comment_rest_id).toBeNull();
  });

  it('retries a failing pagination page and continues when the retry succeeds', async () => {
    const err5xx = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const firstPage = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              id: 'PRT_first',
              path: 'a.go',
              line: 1,
              diffSide: 'RIGHT',
              isResolved: false,
              comments: { nodes: [
                { databaseId: 5000, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'flag' },
              ]},
            }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
          comments: { nodes: [{ author: { login: 'observer' }, body: 'hi' }] },
          reviews: { nodes: [{
            body: '<!-- auto-reviewer: commit=deadbee, status=clean -->',
          }] },
        },
      },
    };
    const secondPage = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              id: 'PRT_latest_only',
              path: 'a.go',
              line: 1,
              diffSide: 'RIGHT',
              isResolved: false,
              comments: { nodes: [
                { databaseId: 5001, author: { login: 'wrily[bot]' }, authorAssociation: 'CONTRIBUTOR', body: 'flag' },
              ]},
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          comments: { nodes: [{ author: { login: 'observer' }, body: 'hi' }] },
          reviews: { nodes: [{
            body: '<!-- auto-reviewer: commit=deadbee, status=clean -->',
          }] },
        },
      },
    };

    const fakeClient = {
      graphql: vi.fn().mockImplementation(async (_q: string, vars: any) => {
        if (vars.threadAfter === 'cursor-1' && fakeClient.graphql.mock.calls.filter((c) => c[1]?.threadAfter === 'cursor-1').length === 1) {
          throw err5xx;
        }
        return vars.threadAfter === null ? firstPage : secondPage;
      }),
    };

    vi.useFakeTimers();
    try {
      const promise = fetchPriorFeedbackDigest(baseEnv, fakeClient);
      await vi.runAllTimersAsync();
      const digest = await promise;
      expect(digest.threads.map((t) => t.thread_id)).toEqual(['PRT_first', 'PRT_latest_only']);
      expect(digest.watermarkSha).toBe('deadbee');
      expect(digest.prComments).toEqual([{ author: 'observer', body: 'hi' }]);
      expect(fakeClient.graphql).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allSettled both reject 4xx: fetcher throws', async () => {
    const err4xx = Object.assign(new Error('Not Found'), { status: 404 });
    const fakeClient = { graphql: vi.fn().mockRejectedValue(err4xx) };
    await expect(fetchPriorFeedbackDigest(baseEnv, fakeClient)).rejects.toThrow(/Not Found/);
  });
});
