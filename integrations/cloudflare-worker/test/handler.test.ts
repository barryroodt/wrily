import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { TEST_PKCS1_PEM, issueCommentPayload, pullRequestApiResponse } from "./fixtures.js";

const SECRET = "test-webhook-secret-do-not-use-in-prod";
const APP_ID = "1234567";
const INSTALLATION_ID = 99887766;
const WRILY_TOKEN = "ghs_wrily_scoped_token";
const CONSUMER_TOKEN = "ghs_consumer_scoped_token";
const SHARED_TOKEN = "ghs_shared_scoped_token";

function buildEnv(overrides: Partial<Record<string, string>> = {}) {
  return {
    WRILY_APP_ID: APP_ID,
    WRILY_REPO: "barryroodt/wrily",
    SHARED_REPO: "octo-org/shared-wrily-skills",
    WRILY_APP_PRIVATE_KEY: TEST_PKCS1_PEM,
    WRILY_WEBHOOK_SECRET: SECRET,
    ...overrides,
  } as any;
}

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function signedRequest(eventType: string, payload: object): Promise<Request> {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, bodyBytes);
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return new Request("https://worker/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-hub-signature-256": "sha256=" + sigHex,
      "x-github-delivery": "test-delivery-uuid",
    },
    body: bodyBytes,
  });
}

function prPayload(action = "opened", consumerRepo = "octo-org/example", prAuthorLogin = "ellotheth") {
  return {
    action,
    number: 42,
    pull_request: {
      number: 42,
      head: { sha: "abc123" },
      base: { ref: "main" },
      user: { login: prAuthorLogin },
    },
    repository: { full_name: consumerRepo },
    installation: { id: INSTALLATION_ID },
  };
}

describe("worker fetch handler", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let calls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const body = JSON.parse((init.body as string) ?? "{}");
        const repos: string[] = body.repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects requests with an invalid HMAC", async () => {
    const req = new Request("https://worker/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "00".repeat(32),
      },
      body: JSON.stringify(prPayload()),
    });
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns 405 for non-POST requests", async () => {
    const res = await worker.fetch(new Request("https://worker/", { method: "GET" }), buildEnv(), ctx);
    expect(res.status).toBe(405);
  });

  it("returns 204 for events that aren't pull_request", async () => {
    const req = await signedRequest("push", { ref: "refs/heads/main" });
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("returns 204 for pull_request actions outside the allowlist", async () => {
    const req = await signedRequest("pull_request", prPayload("closed"));
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("returns 204 (self-review skipped) when consumer_repo equals WRILY_REPO", async () => {
    const req = await signedRequest("pull_request", prPayload("opened", "barryroodt/wrily"));
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("mints wrily + consumer + shared tokens and dispatches review-pr on opened", async () => {
    const req = await signedRequest("pull_request", prPayload("opened", "octo-org/example"));
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);

    const mintCalls = calls.filter((c) => c.url.includes("/access_tokens"));
    expect(mintCalls).toHaveLength(3);
    const repoSets = mintCalls.map((c) => JSON.parse((c.init.body as string) ?? "{}").repositories);
    expect(repoSets).toEqual(expect.arrayContaining([["wrily"], ["example"], ["shared-wrily-skills"]]));

    const dispatchCalls = calls.filter((c) => c.url === "https://api.github.com/repos/barryroodt/wrily/dispatches");
    expect(dispatchCalls).toHaveLength(1);
    const dispatchHeaders = new Headers(dispatchCalls[0]!.init.headers as HeadersInit);
    expect(dispatchHeaders.get("authorization")).toBe(`Bearer ${WRILY_TOKEN}`);
    const dispatchBody = JSON.parse((dispatchCalls[0]!.init.body as string) ?? "{}");
    expect(dispatchBody).toEqual({
      event_type: "review-pr",
      client_payload: {
        consumer_repo: "octo-org/example",
        pr_number: 42,
        head_sha: "abc123",
        base_ref: "main",
        consumer_token: CONSUMER_TOKEN,
        shared_token: SHARED_TOKEN,
        shared_repo: "octo-org/shared-wrily-skills",
        scope_override: null,
        trigger_source: "push",
        actor: null,
        pr_author_login: "ellotheth",
      },
    });
  });

  it("skips shared-skills token minting when SHARED_REPO is unset", async () => {
    const req = await signedRequest("pull_request", prPayload("opened", "octo-org/example"));
    const res = await worker.fetch(req, buildEnv({ SHARED_REPO: "" }), ctx);
    expect(res.status).toBe(200);

    const mintCalls = calls.filter((c) => c.url.includes("/access_tokens"));
    expect(mintCalls).toHaveLength(2);
    const repoSets = mintCalls.map((c) => JSON.parse((c.init.body as string) ?? "{}").repositories);
    expect(repoSets).toEqual(expect.arrayContaining([["wrily"], ["example"]]));

    const dispatchCall = calls.find((c) => c.url === "https://api.github.com/repos/barryroodt/wrily/dispatches");
    expect(dispatchCall).toBeTruthy();
    const body = JSON.parse((dispatchCall!.init.body as string) ?? "{}");
    expect(body.client_payload.shared_token).toBeNull();
    expect(body.client_payload.shared_repo).toBeNull();
  });

  it("pull_request dispatch includes pr_author_login from payload.pull_request.user.login", async () => {
    const req = await signedRequest(
      "pull_request",
      prPayload("opened", "octo-org/example", "octocat-author"),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    const dispatchCall = calls.find((c) => c.url === "https://api.github.com/repos/barryroodt/wrily/dispatches");
    expect(dispatchCall).toBeTruthy();
    const body = JSON.parse((dispatchCall!.init.body as string) ?? "{}");
    expect(body.client_payload.pr_author_login).toBe("octocat-author");
  });

  it("pull_request dispatch falls back to empty string when pull_request.user.login is missing", async () => {
    const payload = prPayload("opened", "octo-org/example");
    // Remove the user field to simulate the missing-author edge case.
    (payload.pull_request as any).user = undefined;
    const req = await signedRequest("pull_request", payload);
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    const dispatchCall = calls.find((c) => c.url === "https://api.github.com/repos/barryroodt/wrily/dispatches");
    expect(dispatchCall).toBeTruthy();
    const body = JSON.parse((dispatchCall!.init.body as string) ?? "{}");
    expect(body.client_payload.pr_author_login).toBe("");
  });

  it("dispatches with shared_token=null when shared mint fails (installation doesn't cover shared)", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const body = JSON.parse((init.body as string) ?? "{}");
        const repos: string[] = body.repositories ?? [];
        if (repos.includes("shared-wrily-skills")) {
          return new Response('{"message":"Repository not accessible"}', { status: 422 });
        }
        const token = repos.includes("wrily") ? WRILY_TOKEN : CONSUMER_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest("pull_request", prPayload("opened", "octo-org/example"));
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    const dispatchCalls = calls.filter((c) => c.url === "https://api.github.com/repos/barryroodt/wrily/dispatches");
    expect(dispatchCalls).toHaveLength(1);
    const body = JSON.parse((dispatchCalls[0]!.init.body as string) ?? "{}");
    expect(body.client_payload.shared_token).toBeNull();
    expect(body.client_payload.shared_repo).toBeNull();
    expect(body.client_payload.consumer_token).toBe(CONSUMER_TOKEN);
  });

  it("returns 502 when GitHub rejects token minting", async () => {
    fetchSpy.mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/access_tokens")) {
        return new Response("Bad credentials", { status: 401 });
      }
      return new Response(null, { status: 204 });
    });
    const req = await signedRequest("pull_request", prPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(502);
  });

  it("returns 400 when the webhook payload is missing installation.id", async () => {
    const payload = { ...prPayload(), installation: undefined };
    const req = await signedRequest("pull_request", payload);
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

describe("issue_comment branch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let calls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      // PR fetch — handler hits this to learn head.sha + base.ref + PR author.
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\.wrily\.yml/)) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.match(/\/check-runs/)) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it("ignores edited comments (Q6)", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ action: "edited" }));
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(0);
  });

  it("ignores deleted comments", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ action: "deleted" }));
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(204);
  });

  it("ignores comments from any Bot user", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ authorType: "Bot" }));
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(204);
  });

  it("ignores non-PR issue comments", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ isPullRequest: false }));
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(204);
  });

  it("ignores closed PRs", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ prState: "closed" }));
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(204);
  });

  it("ignores body without trigger", async () => {
    const req = await signedRequest("issue_comment", issueCommentPayload({ body: "LGTM" }));
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(204);
  });

  it("rejects unauthorized commenter with confused reaction, no dispatch", async () => {
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ authorAssoc: "NONE", authorLogin: "drive-by", prAuthorLogin: "ellotheth" }),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    const reactions = calls.filter((c) => c.url.match(/\/reactions$/));
    expect(reactions).toHaveLength(1);
    expect(JSON.parse((reactions[0]!.init.body as string) ?? "{}").content).toBe("confused");
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(0);
  });

  it("accepts PR author and dispatches with scope_override=delta + trigger_source=re_request", async () => {
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ authorAssoc: "NONE", authorLogin: "ellotheth", prAuthorLogin: "ellotheth" }),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    // Handler must fetch the PR object — issue_comment payload lacks head/base.
    const prFetches = calls.filter((c) => c.url.match(/\/pulls\/42$/));
    expect(prFetches).toHaveLength(1);
    const dispatch = calls.find((c) => c.url.endsWith("/dispatches"));
    expect(dispatch).toBeTruthy();
    const body = JSON.parse((dispatch!.init.body as string) ?? "{}");
    expect(body.client_payload.head_sha).toBe("abc123");
    expect(body.client_payload.base_ref).toBe("main");
    expect(body.client_payload.scope_override).toBe("delta");
    expect(body.client_payload.trigger_source).toBe("re_request");
    expect(body.client_payload.actor).toBe("ellotheth");
    expect(body.client_payload.pr_author_login).toBe("ellotheth");
    const reactions = calls.filter((c) => c.url.match(/\/reactions$/));
    expect(reactions.map((c) => JSON.parse((c.init.body as string) ?? "{}").content)).toEqual([
      "eyes",
      "rocket",
    ]);
  });

  it("issue_comment re-request dispatch carries pr_author_login from the fetched PR object", async () => {
    // PR-author from the GitHub API response wins over any value derivable
    // from the webhook payload — the handler trusts the canonical PR.user.login.
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return new Response(
          JSON.stringify({ token: CONSUMER_TOKEN, expires_at: "2099-01-01T00:00:00Z" }),
          { status: 201 },
        );
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(
          JSON.stringify(pullRequestApiResponse({ prAuthor: "canonical-pr-author" })),
          { status: 200 },
        );
      }
      if (url.match(/\/reactions$/)) return new Response("{}", { status: 201 });
      if (url.match(/\.wrily\.yml/)) return new Response("Not Found", { status: 404 });
      if (url.match(/\/check-runs/)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({
        authorAssoc: "COLLABORATOR",
        authorLogin: "drive-by-collaborator",
        prAuthorLogin: "stale-payload-author",
      }),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    const dispatch = calls.find((c) => c.url.endsWith("/dispatches"));
    expect(dispatch).toBeTruthy();
    const body = JSON.parse((dispatch!.init.body as string) ?? "{}");
    expect(body.client_payload.pr_author_login).toBe("canonical-pr-author");
  });

  it("uses PR-fetched user.login for auth when comment author matches", async () => {
    // PR author returned by the fetch is "real-author"; comment author "real-author" with NONE assoc → accept.
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return new Response(JSON.stringify({ token: CONSUMER_TOKEN, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse({ prAuthor: "real-author" })), { status: 200 });
      }
      if (url.match(/\/reactions$/)) return new Response("{}", { status: 201 });
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ authorAssoc: "NONE", authorLogin: "real-author", prAuthorLogin: "wrong-from-payload" }),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
  });

  it("returns 502 if the PR-object fetch fails (cannot resolve head.sha)", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return new Response(JSON.stringify({ token: CONSUMER_TOKEN, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(0);
  });

  it("accepts COLLABORATOR even when not PR author", async () => {
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ authorAssoc: "COLLABORATOR", authorLogin: "alice", prAuthorLogin: "ellotheth" }),
    );
    expect((await worker.fetch(req, buildEnv(), ctx)).status).toBe(200);
  });

  it("propagates scope_override=full when body says 'full'", async () => {
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ body: "/wrily review full" }),
    );
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    const dispatch = calls.find((c) => c.url.endsWith("/dispatches"));
    const body = JSON.parse((dispatch!.init.body as string) ?? "{}");
    expect(body.client_payload.scope_override).toBe("full");
  });

  // ---------------------------------------------------------------------------
  // In-flight + cooldown check tests
  // ---------------------------------------------------------------------------

  function checkRunFixture(opts: {
    status: string;
    startedAgoMs?: number;
    completedAgoMs?: number;
    conclusion?: string;
  }) {
    const now = Date.now();
    return {
      status: opts.status,
      started_at: new Date(now - (opts.startedAgoMs ?? 0)).toISOString(),
      completed_at: opts.completedAgoMs ? new Date(now - opts.completedAgoMs).toISOString() : null,
      conclusion: opts.conclusion ?? null,
    };
  }

  it("rejects when an in-flight check run is fresh (<20 min)", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/contents\/\.wrily\.yml/)) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.match(/\/check-runs/)) {
        return new Response(
          JSON.stringify({ check_runs: [checkRunFixture({ status: "in_progress", startedAgoMs: 5 * 60_000 })] }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });

    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(0);
    const replyComments = calls.filter((c) => c.url.match(/\/issues\/42\/comments$/));
    expect(replyComments).toHaveLength(1);
    const replyBody = JSON.parse((replyComments[0]!.init.body as string) ?? "{}").body as string;
    expect(replyBody).toMatch(/already in progress/);
  });

  it("accepts when in-flight check is older than 20 min (stuck)", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/contents\/\.wrily\.yml/)) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.match(/\/check-runs/)) {
        return new Response(
          JSON.stringify({ check_runs: [checkRunFixture({ status: "in_progress", startedAgoMs: 25 * 60_000 })] }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });

    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(1);
    const reactions = calls.filter((c) => c.url.match(/\/reactions$/));
    const reactionContents = reactions.map((c) => JSON.parse((c.init.body as string) ?? "{}").content);
    expect(reactionContents).toContain("eyes");
    expect(reactionContents).toContain("rocket");
    expect(reactionContents).not.toContain("confused");
  });

  it("rejects when cooldown active on same head_sha", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/contents\/\.wrily\.yml/)) {
        return new Response("rerequest_cooldown_minutes: 5\nreply_feedback: on\n", { status: 200 });
      }
      if (url.match(/\/check-runs/)) {
        return new Response(
          JSON.stringify({
            check_runs: [
              checkRunFixture({
                status: "completed",
                completedAgoMs: 3 * 60_000,
                conclusion: "success",
              }),
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });

    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(204);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(0);
    const replyComments = calls.filter((c) => c.url.match(/\/issues\/42\/comments$/));
    expect(replyComments).toHaveLength(1);
    const replyBody = JSON.parse((replyComments[0]!.init.body as string) ?? "{}").body as string;
    expect(replyBody).toMatch(/cooldown/i);
  });

  it("accepts when cooldown elapsed", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/contents\/\.wrily\.yml/)) {
        return new Response("rerequest_cooldown_minutes: 5\nreply_feedback: on\n", { status: 200 });
      }
      if (url.match(/\/check-runs/)) {
        return new Response(
          JSON.stringify({
            check_runs: [
              checkRunFixture({
                status: "completed",
                completedAgoMs: 6 * 60_000,
                conclusion: "success",
              }),
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });

    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(1);
  });

  it("ignores cooldown when head_sha differs (no completed runs for current SHA)", async () => {
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        const repos: string[] = JSON.parse((init.body as string) ?? "{}").repositories ?? [];
        let token = CONSUMER_TOKEN;
        if (repos.includes("wrily")) token = WRILY_TOKEN;
        else if (repos.includes("shared-wrily-skills")) token = SHARED_TOKEN;
        return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      }
      if (url.match(/\/issues\/comments\/\d+\/reactions$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/issues\/\d+\/comments$/)) {
        return new Response("{}", { status: 201 });
      }
      if (url.match(/\/contents\/\.wrily\.yml/)) {
        return new Response("rerequest_cooldown_minutes: 5\nreply_feedback: on\n", { status: 200 });
      }
      if (url.match(/\/check-runs/)) {
        // Mimics API returning no runs for the current head_sha (prior run was on a different SHA)
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (url === "https://api.github.com/repos/barryroodt/wrily/dispatches") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 599 });
    });

    const req = await signedRequest("issue_comment", issueCommentPayload());
    const res = await worker.fetch(req, buildEnv(), ctx);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/dispatches"))).toHaveLength(1);
  });

  it("logs re_request_received and re_request_dispatched on accept path", async () => {
    const logs: any[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => {
      if (typeof s === "string") {
        try { logs.push(JSON.parse(s)); } catch { /* not JSON */ }
      }
    });
    // Use the default fetchSpy from beforeEach (404 .wrily.yml, [] check_runs).
    const req = await signedRequest("issue_comment", issueCommentPayload());
    await worker.fetch(req, buildEnv(), ctx);
    const events = logs.map((l) => l.event);
    expect(events).toContain("re_request_received");
    expect(events).toContain("re_request_dispatched");
    logSpy.mockRestore();
  });

  it("logs re_request_rejected_auth on unauthorized commenter", async () => {
    const logs: any[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => {
      if (typeof s === "string") {
        try { logs.push(JSON.parse(s)); } catch { /* not JSON */ }
      }
    });
    const req = await signedRequest(
      "issue_comment",
      issueCommentPayload({ authorAssoc: "NONE", authorLogin: "drive-by", prAuthorLogin: "ellotheth" }),
    );
    await worker.fetch(req, buildEnv(), ctx);
    const events = logs.map((l) => l.event);
    expect(events).toContain("re_request_rejected_auth");
    logSpy.mockRestore();
  });

  it("logs re_request_rejected_inflight on fresh in-flight", async () => {
    const logs: any[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => {
      if (typeof s === "string") {
        try { logs.push(JSON.parse(s)); } catch { /* not JSON */ }
      }
    });
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.match(/\/check-runs\?check_name=Wrily/)) {
        return new Response(
          JSON.stringify({
            check_runs: [checkRunFixture({ status: "in_progress", startedAgoMs: 5 * 60_000 })],
          }),
          { status: 200 },
        );
      }
      if (url.match(/\/access_tokens$/))
        return new Response(JSON.stringify({ token: CONSUMER_TOKEN }), { status: 201 });
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/))
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      if (url.match(/\/reactions$/) || url.match(/\/comments$/))
        return new Response("{}", { status: 201 });
      if (url.match(/\.wrily\.yml/)) return new Response("Not Found", { status: 404 });
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest("issue_comment", issueCommentPayload());
    await worker.fetch(req, buildEnv(), ctx);
    const events = logs.map((l) => l.event);
    expect(events).toContain("re_request_rejected_inflight");
    logSpy.mockRestore();
  });

  it("logs re_request_rejected_cooldown when cooldown active", async () => {
    const logs: any[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => {
      if (typeof s === "string") {
        try { logs.push(JSON.parse(s)); } catch { /* not JSON */ }
      }
    });
    fetchSpy.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, init });
      if (url.match(/\/check-runs\?check_name=Wrily/)) {
        return new Response(
          JSON.stringify({
            check_runs: [checkRunFixture({ status: "completed", completedAgoMs: 3 * 60_000 })],
          }),
          { status: 200 },
        );
      }
      if (url.match(/\/access_tokens$/))
        return new Response(JSON.stringify({ token: CONSUMER_TOKEN }), { status: 201 });
      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/))
        return new Response(JSON.stringify(pullRequestApiResponse()), { status: 200 });
      if (url.match(/\/reactions$/) || url.match(/\/comments$/))
        return new Response("{}", { status: 201 });
      if (url.match(/\/contents\/\.wrily\.yml/))
        return new Response("rerequest_cooldown_minutes: 5\n", { status: 200 });
      return new Response("unexpected", { status: 599 });
    });
    const req = await signedRequest("issue_comment", issueCommentPayload());
    await worker.fetch(req, buildEnv(), ctx);
    const events = logs.map((l) => l.event);
    expect(events).toContain("re_request_rejected_cooldown");
    logSpy.mockRestore();
  });
});
