# Cloudflare Worker Integration

Webhook receiver for the Wrily GitHub App, implemented as a Cloudflare Worker. Recommended integration — both secrets live in Cloudflare-encrypted Worker secrets, ~100 LOC of TypeScript, deploys via `wrangler deploy`, code-reviewable in the repo.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker `fetch` handler — HMAC verify → event filter → mint scoped installation tokens → `repository_dispatch(review-pr)`. |
| `src/crypto.ts` | Web Crypto helpers — HMAC verify, RS256 JWT mint, PKCS#1→PKCS#8 conversion. |
| `test/` | Vitest suite covering crypto helpers and full handler flow with mocked `fetch`. |
| `wrangler.jsonc` | Worker config — name, entry, compat date, non-secret vars. |
| `RUNBOOK.md` | Setup, deploy, testing, rotation, failure-injection, observability. |

## Prerequisites

- Cloudflare account with Workers enabled. Free plan covers our usage (100k requests/day).
- Wrily GitHub App created with the permissions in `../../docs/design/webhook-architecture.md`.
- The App's private key (`.pem`) and webhook secret (any high-entropy string) and integer App ID.
- Node 20+ and `pnpm` for local dev (`npm i -g pnpm`).

## What the Worker reads

| Source | Name | Sensitive? | Purpose |
|--------|------|-----------|---------|
| `wrangler.jsonc` `vars` | `WRILY_APP_ID` | No | Integer App ID |
| `wrangler.jsonc` `vars` | `WRILY_REPO` | No | Defaults to `barryroodt/wrily`; the repo to dispatch into |
| `wrangler.jsonc` `vars` | `SHARED_REPO` | No | Optional shared skills repo in owner/repo form |
| `wrangler secret put` | `WRILY_APP_PRIVATE_KEY` | **Yes** | Full PEM (PKCS#1 from GitHub's download, or PKCS#8) |
| `wrangler secret put` | `WRILY_WEBHOOK_SECRET` | **Yes** | HMAC shared secret matching the App's webhook config |

Both secrets are encrypted at rest by Cloudflare and only readable by the Worker runtime via the typed `env` binding.

## Quick start

```bash
cd integrations/cloudflare-worker
pnpm install

# Set the two secrets (interactive prompts — paste PEM, then secret string)
pnpm wrangler secret put WRILY_APP_PRIVATE_KEY
pnpm wrangler secret put WRILY_WEBHOOK_SECRET

# Edit wrangler.jsonc → replace WRILY_APP_ID with the integer App ID
# Then deploy
pnpm deploy
```

`wrangler deploy` prints the Worker URL, e.g. `https://wrily-review-dispatcher.<your-subdomain>.workers.dev`. Paste that into the Wrily App's webhook config along with `WRILY_WEBHOOK_SECRET`.

Full setup steps and verification flow are in [`RUNBOOK.md`](./RUNBOOK.md).

## Local development

```bash
pnpm test           # vitest run
pnpm test:watch     # vitest watch mode
pnpm typecheck      # tsc --noEmit
pnpm dev            # wrangler dev (local Worker runtime, hot reload)
pnpm tail           # wrangler tail (live logs from prod)
```

The test suite uses a throwaway 2048-bit RSA test key (`test/fixtures.ts`) — never use it for any real deployment.

## Operations

- **Rotation**: re-run `wrangler secret put WRILY_APP_PRIVATE_KEY` (or `WRILY_WEBHOOK_SECRET`) and follow the GitHub-side coordination steps in `RUNBOOK.md` → "Rotation".
- **Observability**: `wrangler tail` for live logs; the Worker's structured logs land in the Cloudflare dashboard with each request's status code and duration.
- **Redelivery**: GitHub retries webhook deliveries on 5xx responses with exponential backoff. Manual redelivery is always available from the App's **Advanced → Recent Deliveries** panel.

## When not to use this Worker

- Your team is standardised on AWS and prefers a Lambda. See `../aws-lambda/` (planned).
- You'd rather click through a UI than `wrangler deploy`. See `../n8n/` (alternative integration; secrets live as plaintext n8n Variables — see that folder's README for the full tradeoff).

## Security notes

- The PEM is never logged. Don't add `console.log(env.WRILY_APP_PRIVATE_KEY)` even temporarily.
- Minted installation tokens (wrily-scoped, consumer-scoped, and optionally shared-skills-scoped) are valid for 1 hour. The consumer and shared-skills tokens ride along in `client_payload` and are masked at the Wrily job entry via `::add-mask::` in `dispatch-review.yml`.
- HMAC verification uses `crypto.subtle.verify` which is constant-time.
- The Worker ignores any event that isn't `pull_request` with action in `{opened, synchronize, reopened}` — even with a valid signature, off-target events get a 204 with no GitHub API calls.
