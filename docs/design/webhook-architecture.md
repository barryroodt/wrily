# Wrily — Webhook-Driven Review Architecture (Design Draft)

**Status:** Implementing. Receiver integrations live in `integrations/` (Cloudflare Worker is the recommended path; n8n kept as a documented alternative); Wrily workflow in `.github/workflows/dispatch-review.yml`.

**Authors:** Barry Roodt
**Last updated:** 2026-04-28

---

## Problem

Wrily initially shipped as a reusable GitHub Actions workflow that consumers call from their own repos. That has three concrete problems:

1. **Secret proliferation.** Reusable workflows cannot access the called repo's secrets directly. The Anthropic API key must live as an org secret (visible to every workflow in the org — a malicious PR can `echo $SECRET`) or be duplicated into every consumer repo.
2. **No "just install and use" path.** Every consumer must add a workflow YAML, a secret, and have an admin grant Actions access + GHCR package access. The adoption friction is high.
3. **Environment-scoped secrets don't help.** We tried `environment: anthropic` in the reusable workflow; environment secrets do not resolve for reusable workflows called from a different repo (evidence: Wrily PRs #7, #9).

Target end state: consumer installs a GitHub App → reviews happen. No YAML, no secret, no admin per-repo dance beyond the install click.

## Proposed architecture

```
┌─────────────────┐        webhook         ┌──────────────┐   repository_dispatch   ┌─────────────────────┐
│  Consumer repo  │ ─────────────────────► │  Cloudflare  │ ────────────────────►   │  barryroodt/wrily      │
│  (PR opened /   │    (pull_request       │  Worker      │                         │  Actions workflow   │
│   synchronize)  │     event via App)     │  receiver    │                         │  runs the review    │
└─────────────────┘                        └──────────────┘                         └──────────┬──────────┘
         ▲                                                                                     │
         │                                                                                     │
         │  PR review comments (posted via App installation token)                             │
         └─────────────────────────────────────────────────────────────────────────────────────┘
```

### Flow

1. Someone opens / updates a PR on a consumer repo that has the Wrily App installed.
2. GitHub delivers a `pull_request` webhook to the App's webhook URL (pointed at the Worker).
3. The Worker verifies the HMAC signature against the webhook secret, filters to relevant actions (`opened`, `synchronize`, `reopened`), mints two short-lived installation tokens (one scoped to `barryroodt/wrily` for the dispatch call, one scoped to the consumer repo for downstream use), and POSTs a `repository_dispatch` event with `event_type: review-pr` and a payload containing `{consumer_repo, pr_number, head_sha, base_ref, consumer_token}`.
4. Wrily's `dispatch-review.yml` workflow fires. It runs `node /app/dist/main.js` with `ANTHROPIC_API_KEY` (Wrily repo secret) + consumer repo metadata + the consumer-scoped token from the dispatch payload (masked at job start with `::add-mask::`).
5. The Mastra workflow clones the consumer repo at `head_sha`, runs the review, posts comments back to the PR using the consumer-scoped token, and clones the optional shared skills repo when `SHARED_REPO`/`SHARED_TOKEN` are present.

### Why Cloudflare Worker (and why not n8n)

The original draft of this design picked n8n on the assumption that an existing automation host was a free win. Implementation revealed three n8n Cloud constraints that erode that win:

1. **`$env` doesn't resolve on n8n Cloud** — only `$vars` (instance-scoped Variables) work. Discovered while wiring up the App ID.
2. **Built-in `GitHub API` credential is PAT-only** — no App-auth mode, no Private Key field. Storing a GitHub App PEM in a credential isn't a supported path.
3. **Code nodes can't access credentials at all** — `this.getCredentials()` throws. Per [n8n's own docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code/common-issues/#cant-access-credentials-in-a-code-node), this is by design. The HMAC verification *must* happen in a Code node (no native GitHub HMAC support on the Webhook node), so the webhook secret is forced into a plaintext n8n Variable.

The Cloudflare Worker has none of these constraints: `wrangler secret put` puts both secrets into Cloudflare's KMS-encrypted store, the runtime exposes them via the typed `env` binding, Web Crypto handles RS256 JWTs and HMAC verification natively, and the whole receiver is ~120 LOC of TypeScript with vitest coverage in the repo.

Explicit tradeoffs:

- **Pro:** Both secrets encrypted at rest. Code reviewable + version-controlled in the repo. ~120 LOC vs an opaque JSON workflow blob. `wrangler deploy` is reproducible and CI-friendly. Latency drops from 200–500ms to 50–100ms (still not load-bearing, but free win).
- **Con:** A `wrangler` dependency in the deploy path (vs n8n's "edit in UI"). One more managed service if you weren't already on Cloudflare. PKCS#1→PKCS#8 PEM wrapping handled in code (small, tested helper).

The n8n integration is preserved at `integrations/n8n/` for teams already running n8n who accept the plaintext-Variable tradeoff. Both receivers are wire-compatible — switching is a single URL swap in the App's webhook config.

## Components

### GitHub App

Single App. Name suggestion: `wrily-reviewer`. Scope: a dedicated App, not a reused unrelated automation App.

**Repository permissions:**
- `contents: read` — clone the consumer repo during review.
- `pull_requests: write` — post review comments / suggested edits on PRs.
- `checks: write` — write a status check the consumer PR can gate on (optional, v2).
- `metadata: read` — implicit.
- `actions: write` — dispatch workflow events on `barryroodt/wrily`.

**Subscribed events:**
- `pull_request` (actions: `opened`, `synchronize`, `reopened`).

**Installation scope:** `barryroodt/wrily` + every approved consumer repo. Org admins manage installations.

**Webhook URL:** points at the Cloudflare Worker (`*.workers.dev` initially, custom domain to follow).

**Webhook secret:** a high-entropy string generated once (`openssl rand -hex 32`), stored in the App settings and as the Worker's `WRILY_WEBHOOK_SECRET` Cloudflare secret.

### Cloudflare Worker (recommended)

`integrations/cloudflare-worker/` — see that folder's README + RUNBOOK for setup.

Single fetch handler:

1. **HMAC verify** — `crypto.subtle.verify` against `WRILY_WEBHOOK_SECRET`. 401 on mismatch.
2. **Event filter** — only `pull_request` events with action in `{opened, synchronize, reopened}` continue; everything else gets 204.
3. **JWT mint** — RS256 sign `{iss=app_id, iat=now-30, exp=now+540}` with `WRILY_APP_PRIVATE_KEY` via `crypto.subtle.sign`.
4. **Installation tokens** — POST to `/app/installations/{installation_id}/access_tokens` for the Wrily runner repo, the consumer repo, and optionally the configured shared skills repo.
5. **Dispatch** — POST `/repos/barryroodt/wrily/dispatches` with `{event_type: "review-pr", client_payload: {..., consumer_token, shared_token, shared_repo}}`.
6. **Respond** — 200 on success, 502 on upstream GitHub failure (triggers GitHub's retry).

### n8n workflow (alternative)

`integrations/n8n/` — kept for teams running n8n. Same wire contract, but with the constraints noted under "Why Cloudflare Worker": three n8n Variables (App ID, PEM, webhook secret), all stored in plaintext at the database layer.

### Wrily workflow

New file: `.github/workflows/dispatch-review.yml`. Triggered on `repository_dispatch(review-pr)`.

Pseudocode:

```yaml
on:
  repository_dispatch:
    types: [review-pr]

jobs:
  review:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/barryroodt/wrily:1
    steps:
      - run: node /app/dist/main.js
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.event.client_payload.consumer_token }}
          GITHUB_REPOSITORY: ${{ github.event.client_payload.consumer_repo }}
          PR_NUMBER: ${{ github.event.client_payload.pr_number }}
          COMMIT_SHA: ${{ github.event.client_payload.head_sha }}
          BASE_BRANCH: ${{ github.event.client_payload.base_ref }}
          SHARED_TOKEN: ${{ github.event.client_payload.shared_token }}
          SHARED_REPO: ${{ github.event.client_payload.shared_repo }}
          ...
```

The Mastra entrypoint clones the target repo when no checkout exists in the container.

## Credential inventory

| Credential | Location | Granted by | Rotatable | Leak blast radius |
|-----------|----------|-----------|-----------|-------------------|
| `ANTHROPIC_API_KEY` | Wrily repo secret | Operator | Yes (via Anthropic console) | Anthropic usage under this key only — capped by project budget |
| `WRILY_APP_ID` | Worker non-secret config | App settings (not sensitive — just an integer) | N/A | None |
| `WRILY_APP_PRIVATE_KEY` | Wrily repo secret **and** n8n credentials | App settings → Generate private key | Yes (one click, generates new; old key invalidated immediately; tokens already minted expire within 1h) | Attacker can mint tokens for any installation — scoped by the App's permissions (above) |
| App webhook secret | App settings **and** n8n credentials | You choose at App creation | Yes (rotate in App settings + n8n together) | Attacker can spoof `pull_request` webhooks to n8n, causing spurious Wrily runs |
| **(nothing)** | Consumer repos | — | — | **Zero. This is the design win.** |

## Security model — explicit statements

- **"I'm a consumer repo maintainer who can open PRs on my own repo. What can I leak?"** Nothing Wrily-related. No credential is stored in your repo. The worst you can do is open a PR that gets reviewed, which is the normal case.
- **"I'm an n8n admin. What do I have access to?"** The App private key and webhook secret. With these: mint tokens for any installation (scoped by App permissions), and spoof incoming webhooks. You cannot read `ANTHROPIC_API_KEY` directly (it lives only in Wrily's repo secrets).
- **"I've compromised n8n through a supply-chain attack on a workflow node."** Same as n8n admin. Rotation of both the App private key and webhook secret removes access.
- **"I've compromised Wrily's repo."** You have `ANTHROPIC_API_KEY`, the App private key, and App ID. Same blast radius as App private key + Anthropic usage. Rotation of both keys + the App private key remediates.
- **"GitHub's webhook delivery IP range is blocked or changes."** The receiver endpoint is publicly reachable; GitHub delivers from a published IP range that can optionally be allowlisted. Failure mode: reviews stop, with receiver logs showing no inbound calls.

## Open questions

1. **Check run vs PR comment for results.** PR review comments are the default. Adding a check run on the head commit gives a gated "Wrily Review / passed|failing" status that branch protection can require.
2. **Consumer opt-out.** A consumer can uninstall the App. Is that sufficient, or do we want a per-PR label like `[skip-wrily]`?
3. **Failure handling.** If the review fails (Claude timeout, budget exceeded), do we post a sentinel comment or fail silently? The TypeScript entrypoint logs and summarizes failure modes while respecting DRY_RUN.
4. **Observability / billing attribution.** Each review is one Claude Code session. Tag requests with `{consumer_repo, pr_number}` so usage can be attributed back to the team whose PR triggered it.

## What this replaces

- Wrily supports two integration paths: the webhook-driven GitHub App (recommended for org-wide rollout) and the reusable workflow `.github/workflows/review.yml` (for repos that prefer to invoke Wrily directly from their own GitHub Actions). Both call the same `node /app/dist/main.js` entrypoint.

## What stays the same

- The Wrily container image API surface — same environment variables, same `.wrily.yml`, same review template behavior. The implementation entrypoint is now the Mastra/TypeScript workflow.
- The `agent-team-review` + `code-review` skills — unchanged.
- The `.wrily.yml` per-repo config file — unchanged.
- The `publish.yml` release workflow — unchanged.

## Rollout plan

1. Create the `wrily-reviewer` App.
2. Deploy the Cloudflare Worker and register its webhook URL on the App.
3. Land the Wrily `dispatch-review.yml` workflow + required secrets.
4. Install the App on one consumer repo. Verify a PR triggers a review end-to-end.
5. Install on 2–3 additional repos. Gather feedback.
6. Deprecate the reusable workflow. Archive `review.yml`.

## Appendix — rejected alternatives

- **Org-wide secret + reusable workflow.** `echo $SECRET` attack from any PR in the org.
- **Environment-scoped secrets in the reusable workflow.** Doesn't work cross-repo (PRs #7, #9). Rejected by evidence.
- **Fine-grained PAT in consumer repos.** A PAT is bound to a user; rotates on that user's schedule; goes stale if the user leaves. App credentials are organizational and don't have this coupling.
- **Two Apps (dispatch + review).** Overkill — one App with the union of permissions is simpler. Rejected per Luiz.
- **Hosted service that calls Anthropic directly (CodeRabbit pattern, no GitHub Actions at all).** Bigger lift, requires persistent infra for the review runtime, not just webhook receipt. Good v3 if demand warrants.
