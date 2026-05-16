# n8n Workflow Runbook — Wrily Review Dispatcher

Operations guide for the n8n workflow that receives Wrily App webhooks and dispatches `repository_dispatch(review-pr)` to `barryroodt/wrily`.

Companion to `../../docs/design/webhook-architecture.md` (design + security model).

---

## Prerequisites

- n8n instance, reachable from the public internet. GitHub's webhook delivery must be able to POST to it.
- Wrily GitHub App already created (permissions listed in `../../docs/design/webhook-architecture.md` → **Components → GitHub App**).
- Three values to hand:
  - App ID (numeric, e.g. `1234567`).
  - App private key (PEM, including `-----BEGIN RSA PRIVATE KEY-----` markers, newlines preserved).
  - App webhook secret (any high-entropy string).

---

## Setup

### 1. Create n8n Variables

In n8n Cloud: **Settings → Variables**. Add three Variables:

| Variable name | Sensitive | Value |
|---------------|-----------|-------|
| `WRILY_APP_ID` | No — visible on the App settings page | Integer App ID (e.g. `1234567`) |
| `WRILY_APP_PRIVATE_KEY` | **Yes** | Full PEM content, `-----BEGIN RSA PRIVATE KEY-----` through `-----END RSA PRIVATE KEY-----`, newlines preserved. The Variables field accepts multi-line input. |
| `WRILY_WEBHOOK_SECRET` | **Yes** | Webhook secret string (see step 3) |

**Why all three live in Variables, not in a credential:** n8n's built-in **GitHub API** credential type is PAT-only — fields are GitHub Server, User, Access Token, Allowed HTTP Request Domains. There is no App-auth mode and no Private Key field. The Code node builds the App JWT manually with `crypto.createSign`, so the PEM has to come from a `$vars` lookup. The webhook secret is already a Variable, so this isn't a new trust boundary.

If your security posture requires the PEM to be encrypted with `N8N_ENCRYPTION_KEY` (the per-credential key) rather than stored as a Variable, the workaround is to abuse a generic credential type (e.g. **HTTP Header Auth**: name=`PrivateKey`, value=`<PEM>`) and change the Code node to read `(await this.getCredentials('httpHeaderAuth')).value`. That trades clean semantics for credential-level encryption-at-rest.

### 2. Import the workflow

1. n8n UI → **Workflows** → **Import from File** → pick `workflow.json` from this folder.
2. Open the imported workflow. No credentials need to be bound — the **Mint installation tokens** Code node reads everything from `$vars`.
3. Click **Activate** (top right).
4. Open the **Receive GitHub webhook** node. Copy the **Production URL** (not the test URL).

### 3. Point the App at the n8n webhook

1. Open the Wrily App settings on GitHub.
2. Under **Webhook**:
   - URL: paste the n8n Production URL from step 2.4.
   - Secret: the same value you set as `WRILY_WEBHOOK_SECRET`.
   - Content type: `application/json`.
3. Subscribe to events: `Pull requests` (if not already).
4. Save.

### 4. Install the App on a consumer repo

App settings → **Install App** → pick the repo (or "All repositories" for org-wide).

---

## Testing

### Unit test: redeliver a known webhook

1. App settings → **Advanced** → **Recent Deliveries**.
2. Find a recent `pull_request` delivery (from any install). Click **Redeliver**.
3. Watch the n8n execution log. All six nodes should pass; the **Dispatch to wrily** node returns `204`.
4. Check `barryroodt/wrily` Actions tab — expect a `review-pr` workflow run firing within ~30s.

### End-to-end: live PR

1. Open a PR on a repo where the App is installed.
2. Wrily should post a review comment within 1–2 minutes.
3. If it doesn't: check the App **Recent Deliveries** panel → find the delivery → check n8n's execution log for it → check Wrily's Actions log.

### Failure injection

| Inject | Expected result |
|--------|----------------|
| Wrong `WRILY_WEBHOOK_SECRET` in n8n | `Verify signature` sets `signature_valid=false` → `Respond 401` fires. App's Recent Deliveries shows `401`. |
| Wrong PEM in `WRILY_APP_PRIVATE_KEY` | `Mint installation tokens` throws; the node fails. n8n execution log shows the mint API returning `401`. Dispatch never happens. |
| `WRILY_APP_PRIVATE_KEY` Variable unset | `Mint installation tokens` throws early with a clear error before calling GitHub. |
| `installation.id` missing from payload | `Mint installation tokens` throws early with a clear error. |
| Delete the `review-pr` workflow in Wrily | n8n dispatch still returns `204` (GitHub accepts dispatch events against any repo event_type); nothing runs on Wrily. No error surfaced to n8n. |

---

## Operations

### Rotation

**App private key rotation:**

1. App settings → **Private keys** → **Generate a private key**. Download the new PEM.
2. In n8n: **Settings → Variables** → edit `WRILY_APP_PRIVATE_KEY` → replace with the new PEM → save.
3. In App settings, **revoke** the old private key. The old key stops working immediately; already-minted installation tokens continue to work until their 1-hour expiry.

**Webhook secret rotation:**

1. App settings → **Webhook** → set a new secret. Save.
2. Update the `WRILY_WEBHOOK_SECRET` Variable in n8n with the new value.
3. Both sides must change in the same short window — deliveries signed with the old secret will fail verification after step 2; deliveries signed with the new secret will fail before step 1.
4. Redeliver any missed webhooks from the App's Recent Deliveries panel once both sides are updated.

### Observability

- Per-execution logs in the n8n UI (Executions tab of the workflow).
- For alerting: add a node at the end of the flow that POSTs to Slack/Datadog/your sink. Wire it from the **Dispatch to wrily** node's error output so only failed dispatches fire an alert.
- GitHub's App **Recent Deliveries** panel is the ground truth for what reached n8n; n8n's execution log is the ground truth for what n8n did with each delivery.

### Retries

- GitHub retries webhook deliveries on 5xx responses. 401 and 204 are terminal (no retry). If n8n is temporarily down and returns 5xx, GitHub backs off and retries.
- Manual redelivery is always possible via the Recent Deliveries panel.

### Token hygiene

- Installation tokens minted inside the **Mint installation tokens** node are valid for 1 hour.
- The consumer-scoped token travels to Wrily via `client_payload` in the dispatch. Wrily's `dispatch-review.yml` masks it at job start with `::add-mask::` so it doesn't leak into step logs.
- Never log a token in the Code node (no `console.log(token)` etc.) — n8n execution logs capture stdout.

---

## What NOT to do

- **Don't put the App private key in a Code node literal.** Always read it from `$vars.WRILY_APP_PRIVATE_KEY` so rotation is a Variable edit, not a workflow change.
- **Don't skip signature verification.** Without it, anyone who finds the webhook URL can trigger arbitrary Wrily reviews — at minimum a DOS surface, possibly worse if downstream logic trusts payload contents.
- **Don't broaden the installation token scope.** Keep `repositories: [consumer-repo]` — one narrow token per request.
- **Don't add protection rules (required reviewers, wait timer) to Wrily's `anthropic` environment.** They'd pause every review waiting for human approval.
- **Don't modify `workflow.json` in place without committing** — any workflow changes belong in this repo so future deployments stay reproducible.

---

## Node-by-node reference

If you need to understand or modify the workflow, here's what each node does. The actual node parameters are in `workflow.json`.

| Node | Type | Purpose |
|------|------|---------|
| Receive GitHub webhook | `webhook` | POST endpoint; `rawBody: true` so the HMAC verification can see the original bytes. |
| Verify signature | `code` | HMAC-SHA256 of raw body vs `X-Hub-Signature-256` header; extracts PR metadata for downstream nodes. |
| Signature valid? | `if` | Routes to Respond 401 on mismatch, continues on match. |
| Respond 401 | `respondToWebhook` | Rejects unauthenticated requests. |
| Event of interest? | `if` | Filters to `pull_request` with action in `{opened, synchronize, reopened}`. |
| Respond 204 | `respondToWebhook` | Acknowledges uninteresting events (push, issues, other PR actions) without triggering a review. |
| Mint installation tokens | `code` | Builds App JWT (RS256), exchanges for two installation tokens (scoped to `wrily` and to the consumer repo). |
| Dispatch to wrily | `httpRequest` | POSTs `repository_dispatch(review-pr)` with the consumer token in `client_payload`. |
| Respond 200 | `respondToWebhook` | Acknowledges the successful dispatch. |
