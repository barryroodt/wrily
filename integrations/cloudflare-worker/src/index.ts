// Wrily review dispatcher (Cloudflare Worker).
//
// Receives webhooks from the Wrily GitHub App, verifies the HMAC signature,
// mints short-lived installation tokens (one scoped to the Wrily runner repo
// for the dispatch call, one scoped to the consumer repo to ride along in the
// dispatch payload, and optionally one scoped to a shared skills repo), and
// POSTs repository_dispatch(review-pr) at the Wrily runner repo.
//
// Security posture: both secrets (App PEM, webhook HMAC secret) live in
// Cloudflare-encrypted Worker secrets. No npm runtime deps. No log output
// of either token or the PEM.

import { mintAppJwt, verifyWebhookSignature } from "./crypto.js";
import { parseTrigger } from "./trigger.js";
import { fetchWrilyConfig } from "./wrily-config.js";

const IN_FLIGHT_FRESHNESS_MS = 20 * 60_000;

interface CheckRun {
  status: string;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
}

async function fetchWrilyCheckRuns(
  repo: string,
  headSha: string,
  token: string,
): Promise<CheckRun[]> {
  const url =
    `https://api.github.com/repos/${repo}/commits/${headSha}/check-runs` +
    `?check_name=${encodeURIComponent("Wrily / review")}`;
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
    });
    if (res.status !== 200) return [];
    const json = (await res.json()) as { check_runs?: CheckRun[] };
    return json.check_runs ?? [];
  } catch {
    return [];
  }
}

function findFreshInFlight(runs: CheckRun[], now: number): CheckRun | null {
  for (const run of runs) {
    if (run.status !== "in_progress") continue;
    const started = Date.parse(run.started_at);
    if (Number.isFinite(started) && now - started < IN_FLIGHT_FRESHNESS_MS) return run;
  }
  return null;
}

function findRecentCompletion(runs: CheckRun[], now: number, cooldownMs: number): CheckRun | null {
  for (const run of runs) {
    if (run.status !== "completed" || !run.completed_at) continue;
    const completed = Date.parse(run.completed_at);
    if (Number.isFinite(completed) && now - completed < cooldownMs) return run;
  }
  return null;
}

async function postRejectReply(
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  }).catch(() => {});
}

interface Env {
  WRILY_APP_ID: string;
  WRILY_REPO: string;
  SHARED_REPO?: string;
  WRILY_APP_PRIVATE_KEY: string;
  WRILY_WEBHOOK_SECRET: string;
}

const ALLOWED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const USER_AGENT = "wrily-review-dispatcher";

interface DispatchInput {
  env: Env;
  installationId: number;
  consumerRepo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  scopeOverride: "full" | "delta" | null;
  triggerSource: "push" | "re_request";
  actor: string | null;
  prAuthorLogin: string;
}

interface DispatchOutcome {
  status: "dispatched" | "error";
  httpStatus: number;
  detail?: string;
}

async function dispatchReview(input: DispatchInput): Promise<DispatchOutcome> {
  const consumerRepoName = repositoryName(input.consumerRepo);
  const wrilyRepoName = repositoryName(input.env.WRILY_REPO);
  if (!consumerRepoName || !wrilyRepoName) {
    return { status: "error", httpStatus: 500, detail: "bad config: repository names must be owner/repo" };
  }
  let appJwt: string;
  try {
    appJwt = await mintAppJwt(input.env.WRILY_APP_PRIVATE_KEY, input.env.WRILY_APP_ID);
  } catch (err) {
    return { status: "error", httpStatus: 500, detail: `bad config: ${(err as Error).message}` };
  }
  let wrilyToken: string;
  let consumerToken: string;
  try {
    [wrilyToken, consumerToken] = await Promise.all([
      mintInstallationToken(appJwt, input.installationId, [wrilyRepoName]),
      mintInstallationToken(appJwt, input.installationId, [consumerRepoName]),
    ]);
  } catch (err) {
    return { status: "error", httpStatus: 502, detail: `upstream: ${(err as Error).message}` };
  }

  // Optional shared-skills token. Soft-fails when no repo is configured or the
  // installation doesn't cover the repo — review still runs without org skills.
  const sharedRepo = input.env.SHARED_REPO?.trim() ?? "";
  const sharedRepoName = sharedRepo ? repositoryName(sharedRepo) : null;
  if (sharedRepo && !sharedRepoName) {
    return { status: "error", httpStatus: 500, detail: "bad config: SHARED_REPO must be owner/repo" };
  }
  let sharedToken: string | null = null;
  if (sharedRepoName) {
    try {
      sharedToken = await mintInstallationToken(appJwt, input.installationId, [sharedRepoName]);
    } catch {
      sharedToken = null;
    }
  }
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${input.env.WRILY_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${wrilyToken}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: "review-pr",
        client_payload: {
          consumer_repo: input.consumerRepo,
          pr_number: input.prNumber,
          head_sha: input.headSha,
          base_ref: input.baseRef,
          consumer_token: consumerToken,
          shared_token: sharedToken,
          shared_repo: sharedToken ? sharedRepo : null,
          scope_override: input.scopeOverride,
          trigger_source: input.triggerSource,
          actor: input.actor,
          pr_author_login: input.prAuthorLogin,
        },
      }),
    },
  );
  if (dispatchRes.status !== 204) {
    const detail = await dispatchRes.text().catch(() => "");
    return {
      status: "error",
      httpStatus: 502,
      detail: `dispatch failed (${dispatchRes.status}): ${detail}`,
    };
  }
  return { status: "dispatched", httpStatus: 200 };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return text("method not allowed", 405);
    }
    const body = await request.arrayBuffer();
    const sigHeader = request.headers.get("x-hub-signature-256") ?? "";
    if (!(await verifyWebhookSignature(env.WRILY_WEBHOOK_SECRET, body, sigHeader))) {
      return text("unauthorized", 401);
    }

    const event = request.headers.get("x-github-event") ?? "";
    if (event === "pull_request") {
      return await handlePullRequest(body, env);
    }
    if (event === "issue_comment") {
      return await handleIssueComment(body, env);
    }
    return text("accepted (event ignored)", 204);
  },
};

async function handlePullRequest(body: ArrayBuffer, env: Env): Promise<Response> {
  const payload = safeJsonParse(body);
  if (!payload || !ALLOWED_ACTIONS.has(payload.action)) {
    return text("accepted (action ignored)", 204);
  }

  const installationId = payload.installation?.id;
  const consumerRepo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  const baseRef = payload.pull_request?.base?.ref;
  if (!installationId || typeof consumerRepo !== "string" || !consumerRepo.includes("/")) {
    return text("bad request: missing installation.id or repository.full_name", 400);
  }

  // Skip self-review: PRs on the Wrily runner repo itself should not trigger a
  // dispatch (would cause wrily to review its own dispatcher changes,
  // confusing test runs and potentially loops).
  if (consumerRepo.toLowerCase() === env.WRILY_REPO.toLowerCase()) {
    return text("accepted (self-review skipped)", 204);
  }

  const result = await dispatchReview({
    env,
    installationId,
    consumerRepo,
    prNumber,
    headSha,
    baseRef,
    scopeOverride: null,
    triggerSource: "push",
    actor: payload.sender?.login ?? null,
    prAuthorLogin: payload.pull_request?.user?.login ?? "",
  });
  if (result.status !== "dispatched") {
    return text(result.detail ?? "dispatch failed", result.httpStatus);
  }
  return Response.json({ status: "dispatched", consumer_repo: consumerRepo, pr_number: prNumber });
}

async function handleIssueComment(body: ArrayBuffer, env: Env): Promise<Response> {
  const payload = safeJsonParse(body);
  if (!payload) return text("accepted (malformed)", 204);

  if (payload.action !== "created") return text("accepted (action ignored)", 204);
  if (payload.comment?.user?.type === "Bot") return text("accepted (bot ignored)", 204);
  if (!payload.issue?.pull_request) return text("accepted (non-PR comment)", 204);
  if (payload.issue.state === "closed") return text("accepted (closed PR)", 204);

  const trigger = parseTrigger(payload.comment?.body ?? "");
  if (!trigger) return text("accepted (no trigger)", 204);

  const installationId = payload.installation?.id;
  const consumerRepo = payload.repository?.full_name;
  const prNumber = payload.issue?.number;
  const commenter = payload.comment?.user?.login;
  const association = payload.comment?.author_association;
  const commentId = payload.comment?.id;
  if (
    !installationId ||
    typeof consumerRepo !== "string" ||
    !consumerRepo.includes("/") ||
    !prNumber ||
    !commentId
  ) {
    return text("bad request: missing required fields", 400);
  }
  if (consumerRepo.toLowerCase() === env.WRILY_REPO.toLowerCase()) {
    return text("accepted (self-review skipped)", 204);
  }

  // Mint app JWT once for tokens used by PR fetch, reactions, raw API, check-runs, dispatch.
  let appJwt: string;
  try {
    appJwt = await mintAppJwt(env.WRILY_APP_PRIVATE_KEY, env.WRILY_APP_ID);
  } catch (err) {
    return text(`bad config: ${(err as Error).message}`, 500);
  }
  const consumerRepoName = consumerRepo.split("/")[1]!;
  let consumerToken: string;
  try {
    consumerToken = await mintInstallationToken(appJwt, installationId, [consumerRepoName]);
  } catch (err) {
    return text(`upstream: ${(err as Error).message}`, 502);
  }

  // GitHub's issue_comment payload only carries `issue.pull_request.url` —
  // not head.sha or base.ref. Fetch the PR object to resolve them and the
  // canonical PR-author login.
  const pr = await fetchPullRequest(consumerRepo, prNumber, consumerToken);
  if (!pr) {
    return text(`upstream: failed to fetch PR ${consumerRepo}#${prNumber}`, 502);
  }
  const headSha = pr.head?.sha;
  const baseRef = pr.base?.ref;
  const prAuthor = pr.user?.login;
  if (!headSha || !baseRef || !prAuthor) {
    return text("upstream: PR object missing head.sha / base.ref / user.login", 502);
  }

  const authorized =
    commenter === prAuthor ||
    association === "OWNER" ||
    association === "MEMBER" ||
    association === "COLLABORATOR";

  if (!authorized) {
    await postReaction(consumerRepo, commentId, "confused", consumerToken).catch(() => {});
    log("re_request_rejected_auth", { actor: commenter, association });
    return text("accepted (unauthorized)", 204);
  }

  const config = await fetchWrilyConfig(consumerRepo, headSha, consumerToken);
  const checkRuns = await fetchWrilyCheckRuns(consumerRepo, headSha, consumerToken);
  const now = Date.now();
  const inFlight = findFreshInFlight(checkRuns, now);
  if (inFlight) {
    await postReaction(consumerRepo, commentId, "confused", consumerToken).catch(() => {});
    await postRejectReply(
      consumerRepo,
      prNumber,
      "Wrily review already in progress for this commit. Wait for it to finish, then re-request.",
      consumerToken,
    );
    log("re_request_rejected_inflight", { head_sha: headSha });
    return text("accepted (in-flight)", 204);
  }
  if (config.rerequest_cooldown_minutes > 0) {
    const cooldownMs = config.rerequest_cooldown_minutes * 60_000;
    const recent = findRecentCompletion(checkRuns, now, cooldownMs);
    if (recent) {
      const completedAt = Date.parse(recent.completed_at!);
      const minutesRemaining = Math.max(
        1,
        Math.ceil((cooldownMs - (now - completedAt)) / 60_000),
      );
      await postReaction(consumerRepo, commentId, "confused", consumerToken).catch(() => {});
      await postRejectReply(
        consumerRepo,
        prNumber,
        `Wrily re-request cooldown active. Try again in ${minutesRemaining} minute(s).`,
        consumerToken,
      );
      log("re_request_rejected_cooldown", { minutes_remaining: minutesRemaining });
      return text("accepted (cooldown)", 204);
    }
  }

  await postReaction(consumerRepo, commentId, "eyes", consumerToken).catch(() => {});
  log("re_request_received", {
    actor: commenter,
    repo: consumerRepo,
    pr_number: prNumber,
    head_sha: headSha,
    scope_override: trigger.scope_override,
  });

  const result = await dispatchReview({
    env,
    installationId,
    consumerRepo,
    prNumber,
    headSha,
    baseRef,
    scopeOverride: trigger.scope_override,
    triggerSource: "re_request",
    actor: commenter,
    prAuthorLogin: prAuthor,
  });
  if (result.status !== "dispatched") {
    return text(result.detail ?? "dispatch failed", result.httpStatus);
  }
  await postReaction(consumerRepo, commentId, "rocket", consumerToken).catch(() => {});
  log("re_request_dispatched", { actor: commenter, scope_override: trigger.scope_override });
  return Response.json({ status: "dispatched", consumer_repo: consumerRepo, pr_number: prNumber });
}

interface PullRequestObject {
  head?: { sha?: string };
  base?: { ref?: string };
  user?: { login?: string };
}

async function fetchPullRequest(
  repo: string,
  prNumber: number,
  token: string,
): Promise<PullRequestObject | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
    });
    if (res.status !== 200) return null;
    return (await res.json()) as PullRequestObject;
  } catch {
    return null;
  }
}

async function postReaction(
  repo: string,
  commentId: number,
  content: "eyes" | "rocket" | "confused",
  token: string,
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );
  if (res.status !== 201 && res.status !== 200) {
    log("reaction_failed", { repo, comment_id: commentId, content, status: res.status });
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function repositoryName(fullName: string | undefined): string | null {
  if (!fullName) return null;
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1];
}

async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  repositories: string[],
): Promise<string> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appJwt}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repositories }),
  });
  if (res.status !== 201) {
    const detail = await res.text().catch(() => "");
    throw new Error(`mint token (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("mint token: response missing token field");
  return json.token;
}

function safeJsonParse(buf: ArrayBuffer): any | null {
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

// Null-body statuses (204/205/304) per the Fetch spec. Passing a string body
// on these throws `Invalid response status code` in Workers and Node alike.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function text(body: string, status: number): Response {
  const init: ResponseInit = { status, headers: { "content-type": "text/plain; charset=utf-8" } };
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, init);
}
