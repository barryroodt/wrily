# Wrily

AI-powered code review agent using Claude Code.

## Features

- **Delta reviews** — Subsequent pushes review only changed files, merges don't inflate scope
- **Team mode** — Parallel agents for broad changes (correctness, conventions, contracts, spec-compliance)
- **Custom skills** — Opt-in org-wide skills from `your-org/shared-wrily-skills` or per-repo `.claude/skills/`
- **Reply-as-feedback** — Wrily honors author disputes on prior comments and re-running on demand via `/wrily review`. See [adoption.md](./docs/adoption.md).
- **Configurable sensitivity** — Filter findings by severity (Critical, Important, Minor)

Wrily is self-hosted — there is no shared Wrily service. Each org runs its own GitHub App + webhook receiver against its own fork of this repo, so your code never traverses someone else's infrastructure.

| Path | When | Setup |
|---|---|---|
| **GitHub App** (recommended) | Continuous PR reviews across an org | Org admin sets up the App + Worker once (~30 min). Consumer repos opt in with zero config. |
| **Local CLI** | Ad-hoc / cross-org / pre-PR review | `git clone` + `./wrily <owner>/<repo> <pr>` |

---

## Self-hosting (org admins)

Stand up your own Wrily instance in ~30 minutes:

1. **Fork** this repo into your org and tag a `v0.1.0` release so the container image publishes to `ghcr.io/<your-org>/wrily`.
2. **Create a GitHub App** in your org with the permissions Wrily needs (`Contents: Read`, `Pull requests: Read/Write`, `Checks: Write`, `Issues: Read/Write`, `Actions: Write`) and subscribe it to `pull_request` + `issue_comment` events.
3. **Deploy the Cloudflare Worker** in [`integrations/cloudflare-worker/`](integrations/cloudflare-worker/) (or the n8n alternative). Set `WRILY_APP_PRIVATE_KEY` and `WRILY_WEBHOOK_SECRET` as Worker secrets.
4. **Point the App** at the Worker's `*.workers.dev` URL and install it on your consumer repos.

Step-by-step walkthrough with every command, screenshot-worthy field, and verification checklist: **[docs/self-hosting.md](docs/self-hosting.md)**.

Operational details (rotation, observability, failure modes) live in the [Worker runbook](integrations/cloudflare-worker/RUNBOOK.md).

- *(Optional)* Persist per-review cost to a self-hosted Supabase project — see [Optional: cost tracking](docs/self-hosting.md#optional-cost-tracking).

---

## Using Wrily on a repo (consumers)

Once an org admin has done the self-hosting setup above, individual repo owners just need to install the App and (optionally) tune a config file. Full consumer-facing guide: [docs/adoption.md](docs/adoption.md).

### 1. Install the App on your repo

`https://github.com/organizations/<your-org>/settings/installations` → **Wrily** → **Configure** → **Repository access** → either add the new repo or switch to "All repositories". Save.

### 2. Open a PR

That's it. Wrily fires on `pull_request` (`opened` / `synchronize` / `reopened`). Review lands in 1–2 min, surfaced as:

- A `Wrily / review` check in the PR's checks panel (in_progress → completed)
- A review comment on the PR with inline findings

No workflow YAML, no secrets, no Actions / GHCR perms to grant per-repo.

### 3. (Optional) Add `.wrily.yml`

Repo root. All keys optional — defaults are sensible.

```yaml
model: anthropic/claude-opus-4-8  # anthropic, openai, google, or openrouter slug (e.g. openai/gpt-4o, openrouter/anthropic/claude-3.5-sonnet)
mode: auto               # auto | single | team
team_threshold: 5        # auto-flips to team mode at this many files/folders
team_threshold_unit: files # files (default) | folders
style: terse             # terse (caveman-review) | verbose (full prose)
sensitivity: important   # important (default) | minor | critical
max_tokens: 8000000      # token budget; override the per-mode default
request_changes: false   # true → Wrily can block merge; false → COMMENT-only

ignore:
  - "**/*.lock"
  - "vendor/**"
  - "gen/**"
  - "**/*.pb.go"

# Opt-in org skills from your optional shared skills repo. When SHARED_REPO is
# configured, the repo is cloned for context; this list controls which skills
# are explicitly loaded into Claude's skill set for the review.
shared_skills:
  - rust-pro
  - security-standards
```

`sensitivity:` defaults to `important`, so Minor / nit findings are not posted inline. Set `sensitivity: minor` to surface every finding, or `sensitivity: critical` to limit inline comments to Critical findings only.

### Verification

PR opens → `Wrily / review — In progress…` should appear in the checks panel within ~10s. If nothing happens after a few minutes, App settings → **Advanced → Recent Deliveries** is the ground truth (200 = good, anything else = debug).

---

## Local CLI

### Prerequisites

- Docker
- `gh` CLI (authenticated: `gh auth login`)
- A provider API key — one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` (anthropic / openai / google / openrouter)

### Setup

```bash
git clone git@github.com:barryroodt/wrily.git
cd wrily
cp .env.example .env   # add your auth token
```

### Review a PR

```bash
# Dry-run — outputs review to stdout (default)
./wrily your-org/your-repo 2209

# Post review to GitHub
./wrily your-org/your-repo 2209 --post

# Force team mode (parallel reviewers)
MODE=team ./wrily your-org/your-repo 2209

# Different model
MODEL=openai/gpt-4o ./wrily your-org/your-repo 2209

# OpenRouter gateway (vendor-qualified slug; free models cost nothing)
MODEL=openrouter/deepseek/deepseek-chat-v3-0324:free ./wrily your-org/your-repo 2209

# Verbose comment style (default is terse / caveman-review)
STYLE=verbose ./wrily your-org/your-repo 2209
```

`./wrily --help` lists all options.

---

## Review Modes

| Mode | When | Default budget | What runs |
|------|------|---------------|-----------|
| **Single** | <`team_threshold` files/folders changed | 2M tokens | One reviewer, 8 review criteria |
| **Team** | ≥`team_threshold` files/folders changed | 8M tokens | Parallel agents: correctness, conventions, contracts, spec-compliance |
| **Auto** (default) | — | varies | Picks single or team based on file scope |

`team_threshold` defaults to 5 and `team_threshold_unit` defaults to `files`; override either per-repo in `.wrily.yml`. With `team_threshold_unit: folders`, Wrily counts distinct changed parent directories such as `src/api` and `src/db`, not only top-level repo folders.

## Comment Style

| `style:` | Output |
|---|---|
| `terse` (default) | One-liner per finding: `L<line>: 🔴 bug: <problem>. <fix>.` — uses the [caveman-review](skills/caveman-review/SKILL.md) skill |
| `verbose` | Full prose, CodeRabbit-style explanations |

Security findings and architectural disagreements always get full prose regardless of mode.

## Context Sources

On every review, Wrily reads:

1. **Optional shared skills repo** (`SHARED_REPO`, for example `your-org/shared-wrily-skills`) — org conventions, team docs, domain knowledge. Cloned only when configured and when the App installation covers it.
2. **CLAUDE.md / AGENTS.md** — project-specific coding standards.
3. **Context skills** — any `*-context` skills under `.claude/skills/` in the consumer repo.
4. **Opt-in shared skills** — listed under `shared_skills:` in `.wrily.yml`, copied from `your-org/shared-wrily-skills/skills/<name>/`.
5. **The diff + changed files** — the actual code under review.

## Custom Skills (per-repo)

Add skills to `.claude/skills/` in the consumer repo:

**Specialist reviewer** — automatically used when matching files change:
```
.claude/skills/rust-conductor/SKILL.md
```

**Codebase context** — read by all reviewers for background:
```
.claude/skills/my-repo-context/SKILL.md
```

See [docs/writing-skills.md](docs/writing-skills.md) for details.

## CLAUDE.md hooks

Claude reads project-root `CLAUDE.md` naturally. Add review-specific guidance:

```markdown
## Code Review Focus
- Prioritize security findings
- All new endpoints must have integration tests
```

## Delta Reviews

On subsequent pushes to a PR, Wrily detects the last reviewed commit (from a marker comment in its prior reviews) and reviews only files the author changed since that point. Files merged in from the base branch since the last review are excluded — so a `git merge main` to refresh the branch doesn't inflate the review scope. Falls back to full review on force-push.

---

## Architecture

### App (production)

```
┌─────────────────┐     pull_request      ┌──────────────────┐
│ Consumer repo   │ ───────────────────►  │ Cloudflare Worker│
│ (PR opened/sync)│  webhook (HMAC sig)   │ (HMAC verify,    │
└─────────────────┘                       │  JWT mint, token  │
                                          │  install mint)   │
                                          └────────┬─────────┘
                                                   │ repository_dispatch(review-pr)
                                                   ▼
                                          ┌──────────────────┐
                                          │ barryroodt/wrily    │
                                          │ Actions          │
                                          │ (dispatch-review │
                                          │  .yml → Mastra   │
                                          │  entrypoint)     │
                                          └────────┬─────────┘
                                                   │ review comment + Check Run
                                                   ▼
                                          ┌──────────────────┐
                                          │ Consumer PR      │
                                          └──────────────────┘
```

Three short-lived install tokens minted per webhook, each minimum-scope:

| Token | Scope | Purpose |
|---|---|---|
| wrily_token | `["wrily"]` | Worker → POST `/repos/barryroodt/wrily/dispatches` |
| consumer_token | `[<consumer>]` | Review activity on the PR |
| shared_token | `[<shared-skills-repo>]` | Optional org-context clone (soft-fails when unset or inaccessible) |

Webhook receiver implementations live in [`integrations/`](integrations/):

- **[`cloudflare-worker/`](integrations/cloudflare-worker/)** ✅ recommended — encrypted secrets, ~120 LOC TypeScript, `wrangler deploy`
- **[`n8n/`](integrations/n8n/)** ✅ alternative — for teams already on n8n; secrets land in plaintext n8n Variables (platform limitation)

### Local

```
./wrily owner/repo 123 [--post]
  │
  ├── Fetch PR metadata + author (gh pr view)
  ├── Authenticate (API key or OAuth token)
  ├── Build Docker image (node:22-slim, multi-stage TS build)
  └── docker run wrily
        │
        node /app/dist/main.js  (entrypoint)
        ├── parseEnv()           — Zod-validated runtime env
        ├── parseWrilyYml()     — .wrily.yml config + defaults
        ├── applyEnvOverrides()  — MODE/MODEL/MAX_TOKENS env > .wrily.yml > default
        ├── GantryRunner          — spawns the gantry subprocess (NDJSON event stream)
        └── Mastra workflow (src/workflow/)
              ├── cloneRepo               — git-clone consumer PR into ephemeral /tmp dir; checkout commit SHA
              ├── cloneShared             — best-effort your-org/shared-wrily-skills clone for org context (skips on missing token)
              ├── bridgeSkills            — copy opt-in cfg.shared_skills into ~/.claude/skills/
              ├── fetchDigest             — prior review threads + reviewsCount via GraphQL (dual-window pagination)
              ├── resolveReview           — SCOPE_OVERRIDE → reviewType; reviewRoundIndex from prior handoff markers;
              │                             delta merge-filter (excludes files merged in from base since last review)
              ├── renderPrompt            — typed prompt template (forbids gh posting, JSON-in-fence only)
              ├── agentCall               — runs the gantry subprocess (GantryRunner); AgentTimeoutError / AgentBudgetExceededError on timeout / budget abort
              ├── extractFindings         — JSON-in-fence → discriminated-union Review (delta-clean prose fallback)
              ├── routeFindings           — new_comment / reply_in_thread / suppress; re-raise unknown threads
              ├── postToGitHub            — watermark dedupe → REST review POST → 422 per-comment fallback; DRY_RUN guards writes
              └── resolveAddressedThreads — heuristic GraphQL resolveReviewThread on addressed prior threads

  On workflow crash: maybePostFailure() posts a timeout / budget / generic
  comment to the PR explaining the failure mode (unless DRY_RUN=true).
```

Source layout under `src/`:

| Dir | What |
|---|---|
| `config/` | `RuntimeEnv` + `WrilyConfig` Zod schemas + `applyEnvOverrides` (`env.ts`, `wrilyYml.ts`, `types.ts`) |
| `prompt/` | Prompt templates + typed renderer + instruction builders |
| `post/` | Findings extract → route → GitHub REST (review POST + reply-in-thread + thread resolve) + body renderer + failure fallback |
| `agent/` | `AgentRunner` interface + `GantryRunner` (gantry subprocess; `AgentTimeoutError`/`AgentBudgetExceededError`) + `modelResolver` + `models` manifest |
| `git/` | Diff range + ignore-pattern + team-threshold scope + `intersectFileLists` + `computeDiffFiles` |
| `skills/` | `bridgeSkills` helper for copying shared skills |
| `workflow/` | Mastra `createStep` definitions (cloneRepo → … → resolveAddressedThreads) + `createWorkflow` assembly |

Tests (`pnpm test`) cover the full workflow including clone, scope override, round index, merge-filter, watermark dedupe, and failure fallback. Container build smoke runs in CI (`.github/workflows/smoke.yml`).

Env vars consumed (canonical names — see `src/config/env.ts`):

| Var | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN`, `PR_NUMBER`, `GITHUB_REPOSITORY`, `BASE_BRANCH`, `COMMIT_SHA` | yes | Workflow inputs |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`) | one | Provider auth (anthropic / openai / google / openrouter) |
| `OPENROUTER_BASE_URL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_X_TITLE` | no | Optional OpenRouter overrides; passed through to gantry verbatim |
| `SHARED_REPO` | no | Optional shared skills repo in owner/repo form |
| `SHARED_TOKEN` | no | Shared-skills clone token; skipped silently when empty |
| `MODE`, `MODEL`, `MAX_TOKENS` | no | Layer over `.wrily.yml` |
| `SCOPE_OVERRIDE` | no | `'full'` / `'delta'` — re-request override |
| `PR_AUTHOR_LOGIN` | no | Used by digest `is_authorized` |
| `WRILY_TRIGGER_SOURCE` | no | `'push'` (default) / `'re_request'` |
| `GITHUB_ACTOR` | no | Re-request actor for prompt context |
| `WRILY_BOT_LOGIN` | no | Default `wrily` |
| `REVIEW_ROUND_INDEX` | no | Workflow computes from prior handoff markers; this env is a fallback |
| `DRY_RUN` | no | `'true'` → log body instead of posting |
| `WRILY_AGENT_TIMEOUT_MS` | no | Override gantry subprocess timeout (default 30 min) |
| `WRILY_DEBUG_AGENT_OUTPUT` | no | Path to dump raw model stdout/stderr |
| `WRILY_GANTRY_BIN` | no | Path to a local gantry binary (default: the binary bundled in the image) |
| `WRILY_ALLOW_UNKNOWN_MODEL` | no | `'1'` → allow a model slug absent from the rate manifest (cost rows = 0) |

---

## Contributing

PRs welcome. Wrily is small enough that a single round of review usually clears most changes — keep them focused and they'll land faster.

### Quick start

```bash
git clone git@github.com:barryroodt/wrily.git
cd wrily
pnpm install
pnpm test          # vitest, full workflow + unit coverage
pnpm typecheck     # strict tsc pass
```

Node 22+ and `pnpm@9.12.0` (root) / `pnpm@10.33.4` (cloudflare-worker subdir) are pinned via `packageManager`. Use Corepack: `corepack enable`.

### Branching + commits

- Branch off `main`. Short kebab-case branch names (`fix-watermark-dedupe`, `feat-criticality-tier`).
- One logical change per PR. Refactors land separately from behavior changes.
- Conventional Commit-ish prefixes are fine but not enforced: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Keep diffs reviewable. Anything past ~400 lines should explain why in the PR description.

### What needs to pass

- `pnpm test` — full vitest suite. Add coverage for the change; tests live next to the code they cover.
- `pnpm typecheck` — strict TS, no `any` escape hatches without a `// reason:` line.
- `smoke.yml` — container build smoke test runs in CI.
- For Worker / integration changes, run that subdir's test + typecheck too.

### Style

- Match surrounding code. No drive-by reformatting in feature PRs.
- Prefer Zod schemas at boundaries; trust internal types past that point.
- Errors get typed classes (`AgentTimeoutError`, `AgentBudgetExceededError`) — re-use rather than ad-hoc `throw new Error`.
- New env vars: document in `src/config/env.ts` schema + the env-vars table in this README.

### Dependency pinning

Wrily's supply chain is locked down. PRs that loosen pins will be rejected.

- **GitHub Actions** — pin by full commit SHA with the version as a trailing comment: `uses: actions/checkout@<sha>  # v4`. Never use tag refs (`@v4`, `@main`). Dependabot keeps the SHA and refreshes the comment.
- **npm** — exact versions in `package.json`, `pnpm-lock.yaml` committed. No `^` / `~` / `*` ranges.
- **Docker base images** — pin by digest (`image@sha256:…`) where possible, immutable tag otherwise.

Dependabot config is in [`.github/dependabot.yml`](.github/dependabot.yml).

### Adding a skill

See [docs/writing-skills.md](docs/writing-skills.md). Specialist skills land under `skills/`, repo-context skills are consumer-side (`.claude/skills/`).

### Reporting bugs / requesting features

- Bugs: open an issue with a reproducer (PR URL with `DRY_RUN=true` output if possible).
- Features: open a discussion or draft an issue with the problem statement first — implementation discussion follows.
- Security: see [SECURITY.md](SECURITY.md). Do not file security reports as public issues.

### Maintainers

`@barryroodt` is the current maintainer. Review SLA is best-effort; ping in the PR if it's been idle more than a week.

---

## Docs

- [Self-hosting guide](docs/self-hosting.md) — fork, App creation, Worker deploy, verification (org admins)
- [Adoption guide](docs/adoption.md) — consumer onboarding playbook (after self-hosting is set up)
- [Webhook architecture](docs/design/webhook-architecture.md) — full design + security model
- [Writing skills](docs/writing-skills.md) — how to write custom reviewer skills
- [`integrations/cloudflare-worker/RUNBOOK.md`](integrations/cloudflare-worker/RUNBOOK.md) — Worker setup, deploy, rotate, observe
- [Security policy](SECURITY.md) — reporting vulnerabilities, supported versions, scope
