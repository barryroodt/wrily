export type ThreadComment = {
  author: string;
  is_wrily: boolean;
  is_authorized: boolean;
  body: string;
};

export type Thread = {
  thread_id: string;
  /**
   * REST `databaseId` of the FIRST comment in this thread. Required to call
   * `pulls.createReplyForReviewComment(comment_id: ...)` — GraphQL thread node
   * IDs (`PRT_…`) are not accepted by that endpoint.
   *
   * `null` when the GraphQL response did not include a numeric `databaseId`
   * (missing or non-numeric). Callers MUST guard for `null` before invoking
   * `pulls.createReplyForReviewComment` — passing `null`/`0` will fail.
   */
  first_comment_rest_id: number | null;
  path: string;
  line: number;
  diff_side: 'LEFT' | 'RIGHT';
  resolved: boolean;
  comments: ThreadComment[];
};

export type PrComment = {
  author: string;
  body: string;
};

export type PriorFeedbackDigest = {
  watermarkSha: string | null;
  threads: Thread[];
  prComments: PrComment[];
  /**
   * Count of prior review bodies containing the `wrily-review-handoff` marker.
   * Used to derive `reviewRoundIndex` (capped at 5 in resolveReviewStep).
   */
  priorReviewsCount: number;
};

type GraphqlClient = { graphql: (query: string, vars?: Record<string, unknown>) => Promise<any> };

type DigestEnv = {
  githubToken: string;
  githubRepository: string;
  prNumber: number;
  wrilyBotLogin: string;
  prAuthorLogin: string;
};

const QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $threadFirst: Int!, $threadAfter: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: $threadFirst, after: $threadAfter) {
          nodes {
            id path line diffSide isResolved
            comments(first: 50) { nodes { databaseId author { login } authorAssociation body } }
          }
          pageInfo { hasNextPage endCursor }
        }
        comments(last: 50) { nodes { author { login } body } }
        reviews(last: 20) { nodes { body } }
      }
    }
  }
`;

const WATERMARK_RE = /<!--\s*auto-reviewer:\s*commit=([a-f0-9]+)/i;
const HANDOFF_RE = /wrily-review-handoff/;
const FIVE_XX = (err: any) => err?.status >= 500 && err?.status < 600;
const AUTHORIZED_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const THREAD_PAGE_SIZE = 100;
const MAX_THREADS = 500;

async function withRetries<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!FIVE_XX(err) || i === max) throw err;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function stripBotSuffix(login: string): string {
  return login.endsWith('[bot]') ? login.slice(0, -'[bot]'.length) : login;
}

function mapThread(node: any, wrilyLogin: string, prAuthorLogin: string): Thread {
  const commentNodes = node?.comments?.nodes ?? [];
  const firstRestId = commentNodes[0]?.databaseId;
  return {
    thread_id: node.id,
    first_comment_rest_id: typeof firstRestId === 'number' ? firstRestId : null,
    path: node.path,
    line: node.line,
    diff_side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    resolved: !!node.isResolved,
    comments: commentNodes.map((c: any) => {
      const author = c?.author?.login ?? 'unknown';
      const is_authorized =
        author === prAuthorLogin || AUTHORIZED_ASSOC.has(c?.authorAssociation);
      return {
        author,
        is_wrily: stripBotSuffix(author) === wrilyLogin,
        is_authorized,
        body: c?.body ?? '',
      };
    }),
  };
}

export async function fetchPriorFeedbackDigest(
  env: DigestEnv,
  client: GraphqlClient,
): Promise<PriorFeedbackDigest> {
  const [owner, repo] = env.githubRepository.split('/');
  if (!owner || !repo) throw new Error(`Invalid githubRepository: ${env.githubRepository}`);

  const pages: any[] = [];
  let threadAfter: string | null = null;
  let fetchedThreads = 0;

  let lastPageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined;
  while (fetchedThreads < MAX_THREADS) {
    const threadFirst = Math.min(THREAD_PAGE_SIZE, MAX_THREADS - fetchedThreads);
    const page = await withRetries(() =>
      client.graphql(QUERY, { owner, repo, pr: env.prNumber, threadFirst, threadAfter }),
    );
    pages.push(page);

    const reviewThreads = page?.repository?.pullRequest?.reviewThreads;
    const nodes = reviewThreads?.nodes ?? [];
    fetchedThreads += nodes.length;
    lastPageInfo = reviewThreads?.pageInfo;

    if (!lastPageInfo?.hasNextPage || !lastPageInfo?.endCursor || nodes.length === 0) break;
    threadAfter = lastPageInfo.endCursor;
  }

  // Silent-truncation guard: the loop exited because we hit MAX_THREADS while
  // GitHub still has more pages. Suppression/reply routing now operates on a
  // truncated digest — reviewer may reraise issues that already have threads
  // beyond the cap. Surface this so it's visible in CI logs.
  if (fetchedThreads >= MAX_THREADS && lastPageInfo?.hasNextPage) {
    console.warn(
      `[digest] pagination capped at MAX_THREADS=${MAX_THREADS}; more pages remain on PR #${env.prNumber}. ` +
        `Suppression/reply routing operates on a truncated digest.`,
    );
  }

  const merged = new Map<string, Thread>();
  for (const page of pages) {
    const nodes = page?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const n of nodes) {
      if (!n?.id) continue;
      if (!merged.has(n.id)) merged.set(n.id, mapThread(n, env.wrilyBotLogin, env.prAuthorLogin));
    }
  }

  const filteredThreads: Thread[] = [];
  for (const t of merged.values()) {
    if (t.comments.some((c) => c.is_wrily)) filteredThreads.push(t);
  }

  const source = pages[0];

  const reviews = source?.repository?.pullRequest?.reviews?.nodes ?? [];
  let watermarkSha: string | null = null;
  let priorReviewsCount = 0;
  for (const review of reviews) {
    const body = review?.body ?? '';
    if (HANDOFF_RE.test(body)) priorReviewsCount++;
    if (watermarkSha === null) {
      const m = body.match(WATERMARK_RE);
      if (m && m[1]) watermarkSha = m[1];
    }
  }

  const prCommentNodes = source?.repository?.pullRequest?.comments?.nodes ?? [];
  const prComments: PrComment[] = prCommentNodes.map((c: any) => ({
    author: c?.author?.login ?? 'unknown',
    body: c?.body ?? '',
  }));

  return { watermarkSha, threads: filteredThreads, prComments, priorReviewsCount };
}
