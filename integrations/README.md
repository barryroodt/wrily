# Integrations

Webhook receivers and adapters that sit between the Wrily GitHub App and Wrily's GitHub Actions workflow. Each subfolder is one deployment option — pick whichever fits your infrastructure.

## Why this layer exists

The Wrily App sends `pull_request` webhooks to some URL. Something at that URL needs to:

1. Verify the HMAC signature on the incoming webhook.
2. Filter to relevant events (`pull_request` with `opened`/`synchronize`/`reopened`).
3. Mint App installation tokens — one scoped to `barryroodt/wrily`, one scoped to the consumer repo, and optionally one scoped to a shared skills repo.
4. POST a `repository_dispatch(review-pr)` event to `barryroodt/wrily` with the consumer-scoped token and optional shared-skills token in the payload.

That receiver is what lives here. Swapping implementations is a single URL change in the App's webhook config — the Wrily-side workflow (`.github/workflows/dispatch-review.yml`) never changes.

See `docs/design/webhook-architecture.md` for the full flow and security model.

## Available integrations

| Folder | Runtime | Status | Best for |
|--------|---------|--------|----------|
| [`cloudflare-worker/`](./cloudflare-worker) | Cloudflare Workers | ✅ **Recommended** | Default choice. Both secrets in CF-encrypted Worker secrets, ~120 LOC TypeScript with tests, `wrangler deploy`. |
| [`n8n/`](./n8n) | Self-hosted or Cloud n8n | ✅ Alternative | Teams already running n8n and OK with secrets stored as plaintext n8n Variables (Code nodes can't access n8n credentials — known platform limitation). |
| `aws-lambda/` | AWS Lambda | 🟡 Not yet built | Teams standardised on AWS. Same shape as the Worker, packaged as a Lambda. |

The receivers are wire-compatible. The Wrily-side workflow doesn't care which one is in front of it.

## Contract

Every receiver must:

- Accept POST to its webhook URL with GitHub's `X-Hub-Signature-256` header.
- Verify the signature against a shared webhook secret. Reject 401 on mismatch.
- Filter to `pull_request` events with action in `{opened, synchronize, reopened}`.
- For matching events:
  - Mint a short-lived installation token scoped to `barryroodt/wrily`.
  - Mint a short-lived installation token scoped to the consumer repo (`$.repository.full_name`).
  - Optionally mint a short-lived installation token scoped to the configured shared skills repo.
  - POST to `https://api.github.com/repos/barryroodt/wrily/dispatches` with:
    ```json
    {
      "event_type": "review-pr",
      "client_payload": {
        "consumer_repo": "<org>/<repo>",
        "pr_number": 123,
        "head_sha": "...",
        "base_ref": "main",
        "consumer_token": "ghs_...",
        "shared_token": "ghs_... or null",
        "shared_repo": "your-org/shared-wrily-skills or null"
      }
    }
    ```
  - Return 200 to the webhook.
- Never log the private key or any minted token.

## Adding a new integration

1. Create a new subfolder named after the runtime (`cloudflare-worker/`, `aws-lambda/`, etc.).
2. Include: the receiver code/config, a `README.md`, and a setup runbook.
3. Follow the contract above — Wrily-side changes should be zero.
4. Add the row to the table above.
