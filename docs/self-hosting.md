# Self-hosting Wrily

This guide is for **org admins** who want to run Wrily for their own team. Wrily is intentionally not offered as a hosted service — every org runs its own GitHub App + webhook receiver, so your code never traverses someone else's infrastructure.

The end-to-end setup takes ~30 minutes and costs nothing beyond a provider API key (Cloudflare Worker free tier covers the webhook receiver; GitHub Actions free tier covers the reviewer).

## What you're setting up

```
your-org/some-repo (PR opened)
        │
        │ pull_request webhook
        ▼
Cloudflare Worker  ──── HMAC verify, mint App tokens ────►  GitHub API
        │                                                   │
        │ repository_dispatch(review-pr)                     │ installation tokens
        ▼                                                   │
your-fork-of/wrily (Actions)  ◄─────────────────────────────┘
        │
        │ posts review comments using consumer-scoped token
        ▼
your-org/some-repo (review lands on the PR)
```

Three moving parts to own:
1. A **fork of this repo** that runs the reviewer in Actions.
2. A **GitHub App** in your org that delivers webhooks and mints minimum-scope install tokens.
3. A **Cloudflare Worker** (or n8n workflow) that receives the webhooks and dispatches the reviewer.

## Prerequisites

- A GitHub org you administer (or a personal account if you're trialing).
- A provider API key — Anthropic, OpenAI, Google, or OpenRouter (or a `CLAUDE_CODE_OAUTH_TOKEN` for the Anthropic default).
- A Cloudflare account (free plan is fine).
- Local tooling: `git`, `gh` (authenticated), `pnpm` (`corepack enable`), `wrangler` (installed via `pnpm install` in the worker dir).
- ~30 minutes.

---

## 1. Fork the repo

```bash
gh repo fork barryroodt/wrily --clone --org=<your-org>
cd wrily
```

If you're trialing under a personal account, drop the `--org` flag.

The fork hosts:
- The container image (`ghcr.io/<your-org>/wrily`), built and pushed by `.github/workflows/publish.yml` when you tag `v*`.
- The Actions workflow that runs each review (`.github/workflows/dispatch-review.yml`).
- An `anthropic` environment that holds your `ANTHROPIC_API_KEY` secret.

### Replace hard-coded references

Update any reference to `barryroodt/wrily` to your fork's `<your-org>/wrily`:

```bash
grep -rln 'barryroodt/wrily' --include='*.yml' --include='*.jsonc' --include='*.md' --include='*.ts' .
```

The load-bearing ones are:
- `.github/workflows/dispatch-review.yml` — container image reference.
- `.github/workflows/review.yml` — reusable workflow's container image.
- `integrations/cloudflare-worker/wrangler.jsonc` — `WRILY_REPO` var.
- `integrations/cloudflare-worker/src/index.ts` — default `WRILY_REPO`.

Other references are documentation and can be updated in passing.

### Tag a release so the image publishes

```bash
git tag v0.1.0
git push origin v0.1.0
```

`publish.yml` builds and pushes `ghcr.io/<your-org>/wrily:0.1.0` and `:0` (major-tag alias). Confirm in your fork's **Packages** tab.

If your org's GHCR packages default to private, make the package public or grant pull access to the App's installation — otherwise the Actions runner won't be able to pull the image.

The image bundles the [gantry](https://github.com/barryroodt/gantry) review
binary, fetched and SHA256-verified at Docker build time (version pinned in
`.gantry-version`). There is no Node-side `@earendil-works/*` agent dependency
to install — `pnpm install` pulls only wrily's own runtime deps.

> **Local dev:** to run wrily against a locally-built gantry instead of the
> image's bundled binary, set `WRILY_GANTRY_BIN` to the binary path (e.g. a
> sibling checkout's `../gantry/target/release/gantry`).

### Add the Anthropic secret

```bash
gh secret set ANTHROPIC_API_KEY --env anthropic --body '<your-key>' --repo <your-org>/wrily
```

(Or via the UI: **Settings → Environments → anthropic → Add secret**.)

To use a different provider, set that provider's API-key secret instead (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`) and set `MODEL` to its slug (e.g. `openai/gpt-4o`, `openrouter/anthropic/claude-3.5-sonnet`). Wrily's provider matrix is anthropic / openai / google / openrouter.

---

## 2. Create the GitHub App

Two paths: manual (UI) or manifest (one-click).

### Manual

**Settings → Developer settings → GitHub Apps → New GitHub App** (under your org if installing org-wide).

| Field | Value |
|-------|-------|
| Name | `<your-org>-wrily-reviewer` (names are globally unique on GitHub) |
| Homepage URL | Your fork URL |
| Webhook URL | Leave blank for now (you'll fill this in after step 3) |
| Webhook secret | Generate: `openssl rand -hex 32` — save it; you'll paste it into the Worker |
| Repository permissions | `Contents: Read`, `Pull requests: Read & Write`, `Checks: Write`, `Issues: Read & Write`, `Metadata: Read` (implicit), `Actions: Write` |
| Subscribe to events | `Pull request`, `Issue comment` |
| Where can this GitHub App be installed? | Choose org-only or any-account based on your intent |

Save. On the next page:
1. Note the **App ID** (numeric).
2. **Generate a private key** — downloads a `.pem` file. Keep it safe; you'll paste it into the Worker.

### Manifest (optional, faster)

If you'd rather use GitHub's app-manifest flow:

```bash
gh api -X POST app-manifests/<manifest-code>/conversions
```

A pre-baked manifest isn't shipped yet — contributions welcome. Until then, the manual path is the supported one.

---

## 3. Deploy the Cloudflare Worker

The Worker receives webhooks, verifies HMAC signatures, mints minimum-scope installation tokens, and dispatches `repository_dispatch(review-pr)` at your fork.

Full operational guide: [`integrations/cloudflare-worker/RUNBOOK.md`](../integrations/cloudflare-worker/RUNBOOK.md). The short path:

```bash
cd integrations/cloudflare-worker
pnpm install
pnpm wrangler login        # OAuths your CF account
```

Edit `wrangler.jsonc`:
- `vars.WRILY_APP_ID` — the numeric App ID from step 2.
- `vars.WRILY_REPO` — `<your-org>/wrily` (your fork).
- (Optional) `vars.SHARED_REPO` — set if you'll add an org-wide shared skills repo (see [docs/writing-skills.md](writing-skills.md)).

Set the secrets:

```bash
pnpm wrangler secret put WRILY_APP_PRIVATE_KEY
# Paste the entire PEM from step 2, including BEGIN/END markers.

pnpm wrangler secret put WRILY_WEBHOOK_SECRET
# Paste the same value you used in the App's webhook secret field.
```

Deploy:

```bash
pnpm deploy
```

Wrangler prints a URL: `https://wrily-review-dispatcher.<your-subdomain>.workers.dev`. Copy it.

If you'd rather use n8n, swap step 3 for [`integrations/n8n/RUNBOOK.md`](../integrations/n8n/RUNBOOK.md). The two receivers are wire-compatible.

---

## 4. Point the App at the Worker

Back in the GitHub App settings:

1. **Webhook URL** — paste the `*.workers.dev` URL from step 3.
2. **Webhook content type** — `application/json`.
3. Confirm permissions/events match step 2.
4. Save.

GitHub forces existing installations to re-accept on permission upgrades — installers will see a banner on their next visit.

---

## 5. Install the App on a consumer repo

App settings → **Install App** → pick a repo (or "All repositories" for org-wide).

The App now needs to be installed on **two** places for Wrily to work end-to-end:
- **The consumer repo** — so Wrily can read the PR, clone the code, and post the review.
- **Your fork (`<your-org>/wrily`)** — so the Worker can dispatch workflows. If you forked into the same org as the consumer repos, "All repositories" covers both.

If you set up a shared skills repo (see [docs/writing-skills.md](writing-skills.md)), install the App there too.

---

## 6. Verify

Open a PR on the consumer repo (or push a commit to an existing one).

| Where | Expected within | What you should see |
|-------|----------------|---------------------|
| App settings → **Advanced → Recent Deliveries** | ~5s | `200 OK` on the `pull_request.synchronize` delivery |
| Cloudflare → `wrangler tail` (run from worker dir) | ~5s | One `POST /` → `[200]` |
| Your fork's **Actions** tab | ~30s | A `Wrily Review (dispatch)` run firing |
| Consumer PR's checks panel | ~30s | `Wrily / review — In progress…` |
| Consumer PR | 1–2 min | Inline review comments + summary |

If anything stalls, the breadcrumbs (in order) are: Recent Deliveries → `wrangler tail` → Actions run logs.

The full failure-injection table is in [`integrations/cloudflare-worker/RUNBOOK.md`](../integrations/cloudflare-worker/RUNBOOK.md#failure-injection).

---

## 7. Hand the App to your users

Once installed and verified, your users only need [`docs/adoption.md`](adoption.md) — the consumer-facing onboarding doc. They don't need to know about the Worker or the fork.

A typical handoff message:

> Wrily is now live on our repos. Open a PR and it'll review you within a minute or two. Add `.wrily.yml` to your repo root to tune behavior — defaults are sensible. Docs: [`adoption.md`](adoption.md).

---

## Ongoing operations

- **Rotation** (App private key, webhook secret) — [`RUNBOOK.md → Rotation`](../integrations/cloudflare-worker/RUNBOOK.md#rotation).
- **Observability** — `wrangler tail`, Cloudflare dashboard, GitHub App Recent Deliveries panel. Details in the RUNBOOK.
- **Upgrading Wrily** — `git pull upstream main` on your fork, resolve any conflicts in the workflow files (the references you swapped in step 1 will reappear in some upstream PRs), tag a new `v*` release, redeploy the Worker only if `integrations/cloudflare-worker/` changed.
- **Cost** — provider API spend per review (token caps configurable via `max_tokens` in `.wrily.yml`). Cloudflare Worker invocations + GitHub Actions minutes both fall well within free tiers for typical org volume.

## Optional: cost tracking

Wrily can persist per-review token + USD cost to a self-hosted Supabase project.
Reviews still work without this enabled — it's purely additive.

### Prerequisites

- The official `supabase` CLI: `brew install supabase/tap/supabase` or `npm i -g supabase`.

### One-shot bootstrap

```bash
./wrily persistence init
```

This walks you through:

1. Logging in to Supabase (browser flow on first run).
2. Picking an org and naming the project (defaults are sensible).
3. Creating the project + waiting for it to become healthy (1–3 min).
4. Writing `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to your fork's `.env`.
5. Applying the schema (`supabase/migrations/*.sql`).

### Day-to-day

```bash
./wrily costs                          # last 30d totals, top repos
./wrily costs --since 7d --by model    # last 7d, grouped by model
./wrily persistence status             # check enabled + row counts
./wrily persistence migrate            # re-apply pending migrations
```

### What gets stored

- Per-run: repo, PR, commit, model, mode, scope, status, duration, findings posted, token usage, USD cost.
- Per-subagent (team mode): the same usage breakdown per parallel reviewer.

Nothing else — no PR content, no findings text, no commit diffs.

### Failure modes

If Supabase is unreachable, the review still ships; the cost row is dropped
after two retries and a structured warning lands in the workflow logs.

## Security

- The App's private key only lives in two places: the Cloudflare Worker secret store (encrypted at rest) and the offline `.pem` you downloaded. **Don't commit the PEM. Don't put it in `wrangler.jsonc` `vars`.**
- Installation tokens minted by the Worker are scoped to a single repo and valid for 1 hour. Never broaden the scope.
- Webhook signatures are HMAC-verified against `WRILY_WEBHOOK_SECRET`. Skipping that check turns the Worker into a public review trigger.
- See [`SECURITY.md`](../SECURITY.md) for the disclosure policy.
