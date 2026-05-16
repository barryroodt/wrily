# n8n Integration

Webhook receiver for the Wrily GitHub App, implemented as an n8n workflow.

## Files

| File | Purpose |
|------|---------|
| `workflow.json` | Importable n8n workflow. Import via n8n UI → workflows → import from file. |
| `RUNBOOK.md` | Setup, testing, operations, rotation, and failure-injection guide. |

## Prerequisites

- An n8n instance reachable from the public internet. GitHub's webhook delivery must be able to POST to the webhook URL.
- Wrily GitHub App created with the permissions listed in `../../docs/design/webhook-architecture.md`.
- The App's private key (`.pem`), webhook secret (any high-entropy string), and App ID.

## What the workflow reads from n8n

All three values live in n8n Variables (`$vars`); no n8n credential is required. The built-in **GitHub API** credential type is PAT-only and has no App-auth mode, so the App private key has to be stored as a Variable. Set up per `RUNBOOK.md`.

### Variables (`$vars`)

| Variable | Contents | Sensitive? |
|----------|----------|-----------|
| `WRILY_APP_ID` | Integer App ID (e.g. `1234567`) | No — visible on the App settings page |
| `WRILY_APP_PRIVATE_KEY` | Full PEM, including `-----BEGIN RSA PRIVATE KEY-----` markers, newlines preserved | **Yes** |
| `WRILY_WEBHOOK_SECRET` | Shared secret for HMAC verification; same value set in the App's webhook config | **Yes** |

All three are accessed via `$vars.X` in the **Mint installation tokens** and **Verify signature** Code nodes.

## Importing the workflow

1. In n8n: **Workflows → Import from File** → select `workflow.json`.
2. Review each node. The Code nodes contain the logic; the HTTP Request node points at `https://api.github.com/repos/barryroodt/wrily/dispatches`.
3. Activate the workflow. Copy the Webhook node's production URL.
4. Paste that URL into the Wrily App's webhook settings on GitHub, alongside the webhook secret.

## Testing the integration

See [`RUNBOOK.md`](./RUNBOOK.md) for step-by-step verification including:

- Redelivering a recent `pull_request` webhook from the App's **Advanced → Recent Deliveries** panel.
- End-to-end test on a real PR.
- Failure injection (bad signature, bad installation ID, missing payload field).

## Operations

- **Rotation**: see `RUNBOOK.md` → "Operational notes". App private key rotation is coordinated between the App settings page and the `WRILY_APP_PRIVATE_KEY` Variable.
- **Observability**: n8n exposes per-execution logs in its UI. For alerting, add a downstream node that POSTs to Slack/Datadog/your sink of choice when the dispatch HTTP node errors.
- **Redelivery**: on n8n outage, GitHub retries webhook deliveries with exponential backoff. Failed deliveries are visible in the App's Recent Deliveries panel and can be redelivered manually.

## When not to use n8n

The [Cloudflare Worker integration](../cloudflare-worker/) is the recommended default — both secrets land in Cloudflare-encrypted storage, the receiver is ~120 LOC of TypeScript with tests in the repo, and `wrangler deploy` is reproducible. Pick n8n only if:

- You're already running n8n and want to keep the deploy surface there.
- You're OK with the n8n Cloud plaintext-Variable tradeoff for both secrets (Code nodes can't read credentials, so the App PEM and webhook secret are forced into Variables).
- You don't have or don't want a Cloudflare account.

Other constraints that argue against n8n outright:

- Latency-sensitive paths (n8n adds 200–500ms vs the Worker's 50–100ms — irrelevant for this use case but noted).
- Security postures that demand encrypted-at-rest storage for the App PEM specifically. The Worker integration solves this; the AWS Lambda + Secrets Manager path (planned, see `../aws-lambda/`) will too.
