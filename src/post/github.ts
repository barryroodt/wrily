import { Octokit } from '@octokit/rest';

export type GhBaseArgs = {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
};

export type ReviewComment = {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
};

export type CreateReviewInput = GhBaseArgs & {
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  comments: ReviewComment[];
};

export type ReviewResult = {
  reviewId: number | null;
  fallbackUsed: boolean;
  failedComments: { path: string; line: number; side: 'LEFT' | 'RIGHT' }[];
};

export type InlineCommentInput = GhBaseArgs & ReviewComment;

export type ReplyInput = GhBaseArgs & {
  /**
   * Numeric review-comment ID for the FIRST comment in the thread (per GitHub REST
   * `pulls.createReplyForReviewComment`). NOT the GraphQL `PullRequestReviewThread`
   * node ID (`PRT_…`) — the digest layer must resolve a thread to its first comment's
   * REST `databaseId` before passing it here.
   */
  inReplyToCommentId: number;
  body: string;
};

export type ReplyResult = { skipped: boolean };

export type CheckRunInput = GhBaseArgs & {
  conclusion: 'success' | 'failure' | 'neutral';
  summary: string;
  checkRunId?: number;
};

type Client = Pick<Octokit, 'rest'>;

const FIVE_XX = (err: any) => err?.status >= 500 && err?.status < 600;

export async function withRetries<T>(fn: () => Promise<T>, max = 3): Promise<T> {
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

function logReviewDiagnostic(input: CreateReviewInput) {
  const summary = input.comments.map((c) => `${c.path}:${c.line}:${c.side}`).join(', ');
  console.log(
    `[postReview] body.size=${input.body.length} comments=${input.comments.length} ${summary ? `[${summary}]` : ''}`,
  );
}

export async function postReview(client: Client, input: CreateReviewInput): Promise<ReviewResult> {
  logReviewDiagnostic(input);

  const callBulk = (comments: ReviewComment[]) =>
    client.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      commit_id: input.commitSha,
      event: input.event,
      body: input.body,
      comments,
    });

  try {
    const res = await withRetries(() => callBulk(input.comments));
    return { reviewId: res.data?.id ?? null, fallbackUsed: false, failedComments: [] };
  } catch (err: any) {
    if (err?.status !== 422) throw err;

    console.warn('[postReview] 422 with comments — stripping comments, retrying body-only');
    let bodyOnly: Awaited<ReturnType<typeof callBulk>>;
    try {
      bodyOnly = await withRetries(() => callBulk([]));
    } catch (bodyErr: any) {
      if (bodyErr?.status !== 422) throw bodyErr;
      console.warn('[postReview] body-only 422 — retrying without commit_id');
      bodyOnly = await withRetries(() =>
        client.rest.pulls.createReview({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.prNumber,
          event: input.event,
          body: input.body,
          comments: [],
        }),
      );
    }

    const failed: ReviewResult['failedComments'] = [];
    for (const c of input.comments) {
      try {
        await withRetries(() =>
          postInlineReviewComment(client, {
            owner: input.owner,
            repo: input.repo,
            prNumber: input.prNumber,
            commitSha: input.commitSha,
            ...c,
          }),
        );
      } catch (cErr: any) {
        if (cErr?.status === 422) {
          console.warn(`[postReview] per-comment 422 at ${c.path}:${c.line}:${c.side} — skipping`);
          failed.push({ path: c.path, line: c.line, side: c.side });
        } else {
          throw cErr;
        }
      }
    }

    return { reviewId: bodyOnly.data?.id ?? null, fallbackUsed: true, failedComments: failed };
  }
}

export async function postInlineReviewComment(client: Client, input: InlineCommentInput) {
  return client.rest.pulls.createReviewComment({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    commit_id: input.commitSha,
    path: input.path,
    line: input.line,
    side: input.side,
    body: input.body,
  });
}

export async function replyInThread(client: Client, input: ReplyInput): Promise<ReplyResult> {
  try {
    await withRetries(() =>
      client.rest.pulls.createReplyForReviewComment({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        comment_id: input.inReplyToCommentId,
        body: input.body,
      }),
    );
    return { skipped: false };
  } catch (err: any) {
    if (err?.status === 422) {
      console.warn(`[replyInThread] 422 on inReplyToCommentId=${input.inReplyToCommentId} — logging + skipping`);
      return { skipped: true };
    }
    throw err;
  }
}

export type FailureKind = 'timeout' | 'budget' | 'failure';

export type FailureCommentArgs = GhBaseArgs & {
  kind: FailureKind;
  errMessage: string;
};

const FAILURE_BODY: Record<FailureKind, (msg: string, commit: string) => string> = {
  timeout: (msg, commit) => `## Wrily Review — timed out

The review for commit \`${commit.slice(0, 7)}\` did not finish within the allotted time.

\`\`\`
${msg}
\`\`\`

Push a new commit or comment \`/wrily review\` to retry.

<!-- auto-reviewer: failure=timeout, commit=${commit} -->
`,
  budget: (msg, commit) => `## Wrily Review — budget exceeded

The review for commit \`${commit.slice(0, 7)}\` hit the configured \`max_tokens\` ceiling.

\`\`\`
${msg}
\`\`\`

Raise \`max_tokens\` in \`.wrily.yml\` (or \`MAX_TOKENS\`) or comment \`/wrily review\` to retry.

<!-- auto-reviewer: failure=budget, commit=${commit} -->
`,
  failure: (msg, commit) => `## Wrily Review — failed

The review for commit \`${commit.slice(0, 7)}\` failed before posting findings.

\`\`\`
${msg}
\`\`\`

Push a new commit or comment \`/wrily review\` to retry.

<!-- auto-reviewer: failure=generic, commit=${commit} -->
`,
};

export async function postFailureComment(client: Client, input: FailureCommentArgs): Promise<void> {
  const body = FAILURE_BODY[input.kind](input.errMessage, input.commitSha);
  // Prefer review-as-COMMENT (consistent with happy-path posting); fall back to
  // issue comment if the review API rejects (e.g. invalid commit).
  try {
    await client.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      commit_id: input.commitSha,
      event: 'COMMENT',
      body,
    });
  } catch (err) {
    console.warn(`[postFailureComment] review API failed (${(err as Error).message}); falling back to issue comment`);
    try {
      await client.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.prNumber,
        body,
      });
    } catch (err2) {
      console.warn(`[postFailureComment] issue-comment fallback also failed: ${(err2 as Error).message}`);
      // No further escalation — log only. Caller still has the original error.
    }
  }
}

export async function updateCheckRun(client: Client, input: CheckRunInput) {
  if (input.checkRunId) {
    return client.rest.checks.update({
      owner: input.owner,
      repo: input.repo,
      check_run_id: input.checkRunId,
      status: 'completed',
      conclusion: input.conclusion,
      output: { title: 'Wrily Review', summary: input.summary },
    });
  }
  return client.rest.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: 'Wrily Review',
    head_sha: input.commitSha,
    status: 'completed',
    conclusion: input.conclusion,
    output: { title: 'Wrily Review', summary: input.summary },
  });
}
