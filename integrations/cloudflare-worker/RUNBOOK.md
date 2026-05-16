# Cloudflare Worker Runbook — Wrily Review Dispatcher

Operations guide for the Worker that receives Wrily App webhooks and dispatches `repository_dispatch(review-pr)` to `barryroodt/wrily`.

Companion to `../../docs/design/webhook-architecture.md` (design + security model).

---

## Prerequisites

- A Cloudflare account with Workers enabled (free plan is sufficient).
- Wrily GitHub App already created (permissions listed in `../../docs/design/webhook-architecture.md` → **Components → GitHub App**).
- Three values to hand:
  - App ID (numeric, e.g. `1234567`).
  - App private key (PEM, including markers, newlines preserved). PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) is what GitHub gives you on download — the Worker accepts that directly. PKCS#8 (`-----BEGIN PRIVATE KEY-----`) also works.
  - App webhook secret (any high-entropy string — `openssl rand -hex 32` works).
- Node 20+ and pnpm locally: `npm i -g pnpm`.

---

## Setup

### 1. Install and authenticate

```bash
cd integrations/cloudflare-worker
pnpm install
pnpm wrangler login   # opens browser, OAuths into your CF account
```

`wrangler login` writes credentials to `~/.wrangler/config/default.toml`. Subsequent `wrangler` commands pick them up automatically.

### 2. Set the App ID in wrangler.jsonc

Edit the `vars.WRILY_APP_ID` value in `wrangler.jsonc` — replace `REPLACE_WITH_APP_ID` with the integer App ID from the Wrily App settings page. Commit the change.

`WRILY_REPO` defaults to `barryroodt/wrily` and only needs editing if you fork.

### 3. Set the secrets

```bash
pnpm wrangler secret put WRILY_APP_PRIVATE_KEY
# Wrangler prompts for the value. Paste the entire PEM, including the
# -----BEGIN RSA PRIVATE KEY----- and -----END RSA PRIVATE KEY----- markers,
# newlines preserved. Press Enter (or Ctrl-D depending on shell) when done.

pnpm wrangler secret put WRILY_WEBHOOK_SECRET
# Paste the same string you'll set in the App's webhook config in step 5.
```

Cloudflare encrypts both secrets at rest with their KMS-backed key. The Worker reads them via typed `env` bindings — they never appear in logs, in the dashboard, or in the bundled Worker output.

### 4. Deploy

```bash
pnpm deploy
```

This prints something like:

```
Deployed wrily-review-dispatcher triggers (1.23 sec)
  https://wrily-review-dispatcher.<your-subdomain>.workers.dev
Current Version ID: <uuid>
```

Copy that URL — it's the webhook endpoint. The Worker is now live.

### 5. Point the Wrily App at the Worker

1. Open the Wrily App settings on GitHub.
2. Under **Webhook**:
   - URL: paste the `*.workers.dev` URL from step 4.
   - Secret: the same value you set as `WRILY_WEBHOOK_SECRET` in step 3.
   - Content type: `application/json`.
3. Under **Repository permissions**, ensure:
   - `Pull requests`: **Read & Write** (already required for review posting).
   - `Contents`: **Read** (already required for cloning consumer repos).
   - `Checks`: **Write** (already required for the check-run surface).
   - `Issues`: **Read & Write** — required by the reply-as-feedback feature for posting `eyes`/`rocket`/`confused` reactions on PR comments and reject-reply messages. Without Write, every reaction silently 403s and rejected `/wrily review` requests get no visible feedback.
4. Subscribe to events:
   - `Pull request`
   - `Issue comment` — required for the `/wrily review` re-request trigger.
5. Save. GitHub forces every existing installation to re-accept on permission upgrades — installers will see a banner the next time they visit the install settings.

### 6. Install the App on a consumer repo

App settings → **Install App** → pick the repo (or "All repositories" for org-wide).

---

## Testing

### Unit tests

```bash
pnpm test
```

Covers HMAC verification (good/bad/missing/wrong-length signatures), JWT minting from both PKCS#1 and PKCS#8 PEMs (round-trip verified with the matching public key), event filtering, parallel installation token minting, dispatch wiring, and error paths.

The tests use a throwaway 2048-bit RSA key in `test/fixtures.ts` — never use it in any real deployment.

### Local end-to-end against the dev runtime

```bash
pnpm dev
```

Runs the Worker on `http://localhost:8787` via Miniflare. You can `curl` a signed payload at it for manual verification, or expose it through `cloudflared tunnel` and point the App's webhook at the tunnel for fully-real testing.

### Redeliver a known webhook (post-deploy verification)

1. App settings → **Advanced** → **Recent Deliveries**.
2. Find a recent `pull_request` delivery (from any install). Click **Redeliver**.
3. In another terminal: `pnpm tail`. Watch for the request to land — expect `[200] POST` with no error logs.
4. Check `barryroodt/wrily` Actions tab — expect a `review-pr` workflow run firing within ~30s.

### End-to-end: live PR

1. Open a PR on a repo where the App is installed.
2. Wrily should post a review comment within 1–2 minutes.
3. If it doesn't: check the App **Recent Deliveries** panel → find the delivery → check `wrangler tail` output → check Wrily's Actions log.

### Failure injection

| Inject | Expected result |
|--------|----------------|
| Wrong `WRILY_WEBHOOK_SECRET` in Worker | Worker returns `401`. App's Recent Deliveries shows `401`. |
| Wrong PEM in `WRILY_APP_PRIVATE_KEY` | Worker mints the App JWT successfully but GitHub rejects it; Worker returns `502 upstream: mint token (401): ...`. Dispatch never happens. |
| `WRILY_APP_PRIVATE_KEY` unset | Worker returns `500 bad config: unrecognized PEM format ...` on first delivery. |
| `installation.id` missing from payload | Worker returns `400 bad request: missing installation.id ...`. |
| Delete the `review-pr` workflow in Wrily | Worker dispatch still returns `204` (GitHub accepts dispatches against any repo event_type); nothing runs on Wrily. No error surfaced to the Worker. |

---

## Operations

### Rotation

**App private key rotation:**

1. App settings → **Private keys** → **Generate a private key**. Download the new PEM.
2. `pnpm wrangler secret put WRILY_APP_PRIVATE_KEY` → paste the new PEM. The change is atomic — the new value is live in the Worker within a few seconds.
3. App settings → **revoke** the old private key. Old key stops working immediately; already-minted installation tokens continue to work until their 1-hour expiry.

**Webhook secret rotation:**

1. App settings → **Webhook** → set a new secret. Save.
2. `pnpm wrangler secret put WRILY_WEBHOOK_SECRET` → paste the new value.
3. Both sides must change in the same short window — deliveries signed with the old secret fail verification after step 2; deliveries signed with the new secret fail before step 1. Redeliver any missed webhooks from the App's Recent Deliveries panel once both sides are updated.

### Observability

- `pnpm tail` for live request logs.
- Cloudflare dashboard → **Workers & Pages → wrily-review-dispatcher** for invocation count, error rate, CPU time, and exception traces.
- `wrangler.jsonc` has `observability.enabled: true` so structured logs are retained for 7 days on the free plan, longer on paid plans.
- For alerting: Cloudflare **Notifications** → **Workers** → **HTTP error rate exceeds threshold** is the simplest path. Or POST from the Worker into Slack/Datadog on the failure paths if you need something more bespoke.
- GitHub's App **Recent Deliveries** panel is the ground truth for what reached the Worker; `wrangler tail` is the ground truth for what the Worker did with each delivery.

### Retries

- GitHub retries webhook deliveries on 5xx responses with exponential backoff. 401 and 204 are terminal (no retry). The Worker returns 502 if the upstream GitHub API mint or dispatch fails — that triggers a retry.
- Manual redelivery is always possible via the Recent Deliveries panel.

### Token hygiene

- Installation tokens (wrily-scoped and consumer-scoped) are valid for 1 hour.
- The consumer-scoped token travels to Wrily via `client_payload` in the dispatch. Wrily's `dispatch-review.yml` masks it at job start with `::add-mask::` so it doesn't leak into step logs.
- Never log a token in the Worker (no `console.log(token)` etc.) — `wrangler tail` and the Cloudflare dashboard capture stdout.

### Custom domain (later)

Currently the Worker uses `*.workers.dev`. To migrate to a custom domain:

1. Add a `routes` block to `wrangler.jsonc` with the custom hostname (e.g. `wrily-webhook.example.com/*`) and the matching zone ID.
2. `pnpm deploy`.
3. In the Wrily App webhook config, replace the `*.workers.dev` URL with the custom one. Do this with a brief redelivery window — old deliveries will continue hitting the workers.dev URL until the App config saves.
4. Optionally remove the `workers.dev` route via the Cloudflare dashboard (Workers → wrily-review-dispatcher → Settings → Triggers → Routes).

---

## What NOT to do

- **Don't put the App private key in `wrangler.jsonc` `vars`.** That section is for non-secret config and the values land in the bundled Worker output. Always use `wrangler secret put` for the PEM and the webhook secret.
- **Don't skip signature verification.** Without it, anyone who finds the Worker URL can trigger arbitrary Wrily reviews — at minimum a DoS surface, possibly worse if downstream logic trusts payload contents.
- **Don't broaden the installation token scope.** Keep `repositories: [<one-name>]` per token — one narrow token per request.
- **Don't add protection rules (required reviewers, wait timer) to Wrily's `anthropic` environment.** They'd pause every review waiting for human approval.
- **Don't `console.log` the PEM, the JWT, or either minted token.** Cloudflare retains structured logs for at least 7 days.

---

## Code map

| File | Responsibility |
|------|---------------|
| `src/index.ts` | `fetch` handler — orchestration only. HMAC verify → event filter → JWT mint → parallel installation token mint → `repository_dispatch` → response. ~120 LOC. |
| `src/crypto.ts` | `verifyWebhookSignature` (HMAC-SHA256), `mintAppJwt` (RS256), and PKCS#1→PKCS#8 wrapping for keys downloaded from GitHub. Web Crypto only — no npm runtime deps. |
| `test/crypto.test.ts` | HMAC + JWT round-trip tests with the throwaway test key. |
| `test/handler.test.ts` | Full handler tests with mocked `fetch` covering all status-code branches. |
| `test/fixtures.ts` | Throwaway RSA-2048 test key (PKCS#1, PKCS#8, public). |

If you change the contract (request/response shape), keep `../README.md` "Contract" section and `../../docs/design/webhook-architecture.md` in sync.

---

## Re-request race window

Two `/wrily review` comments within ~5–15 s on the same head SHA can both pass the
in-flight check and dispatch parallel reviews. Accepted per spec §Error Handling
("race window accepted"). Symptoms: two review comments posted near-simultaneously
for the same head SHA. Mitigation: none in code; tell the user to use one trigger
at a time or wait for the rocket reaction.
