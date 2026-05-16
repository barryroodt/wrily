# Wrily

AI-powered code review agent using Claude Code. Named after the workshop where code gets refined.

## Features

- **Delta reviews** — Subsequent pushes review only changed files, merges don't inflate scope
- **Team mode** — Parallel agents for broad changes (correctness, conventions, contracts, spec-compliance)
- **Custom skills** — Opt-in org-wide skills from `your-org/shared-wrily-skills` or per-repo `.claude/skills/`
- **Reply-as-feedback** — Wrily honors author disputes on prior comments and re-running on demand via `/wrily review`. See [adoption.md](./docs/adoption.md).
- **Configurable sensitivity** — Filter findings by severity (Critical, Important, Minor)

Two ways to use it:

| Path | When | Setup |
|---|---|---|
| **GitHub App** (recommended) | Continuous PR reviews on an organization repo | Org admin installs the App on the repo. Zero per-repo config required. |
| **Local CLI** | Ad-hoc / cross-org / pre-PR review | `git clone` + `./wrily <owner>/<repo> <pr>` |

---

## GitHub App adoption (new repos)

### 1. Install the App on your repo

Org admin only. `https://github.com/organizations/<your-org>/settings/installations` → **Wrily** → **Configure** → **Repository access** → either add the new repo or switch to "All repositories". Save.

### 2. Open a PR

That's it. Wrily fires on `pull_request` (`opened` / `synchronize` / `reopened`). Review lands in 1–2 min, surfaced as:

- A `Wrily / review` check in the PR's checks panel (in_progress → completed)
- A review comment on the PR with inline findings

No workflow YAML, no secrets, no Actions / GHCR perms to grant per-repo.

### 3. (Optional) Add `.wrily.yml`

Repo root. All keys optional — defaults are sensible.

```yaml
model: opus              # opus | sonnet | haiku
mode: auto               # auto | single | team
team_threshold: 5        # auto-flips to team mode at this many files/folders
team_threshold_unit: files # files (default) | folders
style: terse             # terse (caveman-review) | verbose (full prose)
sensitivity: important   # important (default) | minor | critical
max_budget_usd: 15       # override the per-mode default
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
  - metal-standards
```

**Breaking default (2026-04-30):** `sensitivity:` defaults to `important`, so Minor / nit findings are no longer posted inline by default. Repos that want the previous behavior add `sensitivity: minor` to their `.wrily.yml`. `critical` is also available for repos that only want Critical findings inline.

### Verification

PR opens → `Wrily / review — In progress…` should appear in the checks panel within ~10s. If nothing happens after a few minutes, App settings → **Advanced → Recent Deliveries** is the ground truth (200 = good, anything else = debug).

---

## Local CLI

### Prerequisites

- Docker
- `gh` CLI (authenticated: `gh auth login`)
- One of: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`

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
MODEL=sonnet ./wrily your-org/your-repo 2209

# Verbose comment style (default is terse / caveman-review)
STYLE=verbose ./wrily your-org/your-repo 2209
```

`./wrily --help` lists all options.

---

## Review Modes

| Mode | When | Default budget | What runs |
|------|------|---------------|-----------|
| **Single** | <`team_threshold` files/folders changed | $5 | One reviewer, 8 review criteria |
| **Team** | ≥`team_threshold` files/folders changed | $15 | Parallel agents: correctness, conventions, contracts, spec-compliance |
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
        ├── applyEnvOverrides()  — MODE/MODEL/MAX_BUDGET env > .wrily.yml > default
        ├── selectRunner(cfg.model) — claude-code | codex runner
        └── Mastra workflow (src/workflow/)
              ├── cloneRepo               — git-clone consumer PR into ephemeral /tmp dir; checkout commit SHA
              ├── cloneShared             — best-effort your-org/shared-wrily-skills clone for org context (skips on missing token)
              ├── bridgeSkills            — copy opt-in cfg.shared_skills into ~/.claude/skills/
              ├── fetchDigest             — prior review threads + reviewsCount via GraphQL (dual-window pagination)
              ├── resolveReview           — SCOPE_OVERRIDE → reviewType; reviewRoundIndex from prior handoff markers;
              │                             delta merge-filter (excludes files merged in from base since last review)
              ├── renderPrompt            — typed prompt template (forbids gh posting, JSON-in-fence only)
              ├── agentCall               — spawn claude -p; AgentTimeoutError / AgentBudgetExceededError on SIGTERM / budget
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
| `agent/` | `AgentRunner` interface + `ClaudeCodeRunner` (with `AgentTimeoutError`/`AgentBudgetExceededError`) + factory |
| `git/` | Diff range + ignore-pattern + team-threshold scope + `intersectFileLists` + `computeDiffFiles` |
| `skills/` | `bridgeSkills` helper for copying shared skills |
| `workflow/` | Mastra `createStep` definitions (cloneRepo → … → resolveAddressedThreads) + `createWorkflow` assembly |

Tests (`pnpm test`) cover the full workflow including clone, scope override, round index, merge-filter, watermark dedupe, and failure fallback. Container build smoke runs in CI (`.github/workflows/smoke.yml`).

Env vars consumed (canonical names — see `src/config/env.ts`):

| Var | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN`, `PR_NUMBER`, `GITHUB_REPOSITORY`, `BASE_BRANCH`, `COMMIT_SHA` | yes | Workflow inputs |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | one | Claude auth |
| `SHARED_REPO` | no | Optional shared skills repo in owner/repo form |
| `SHARED_TOKEN` | no | Shared-skills clone token; skipped silently when empty |
| `MODE`, `MODEL`, `MAX_BUDGET` | no | Layer over `.wrily.yml` |
| `SCOPE_OVERRIDE` | no | `'full'` / `'delta'` — re-request override |
| `PR_AUTHOR_LOGIN` | no | Used by digest `is_authorized` |
| `WRILY_TRIGGER_SOURCE` | no | `'push'` (default) / `'re_request'` |
| `GITHUB_ACTOR` | no | Re-request actor for prompt context |
| `WRILY_BOT_LOGIN` | no | Default `wrily` |
| `REVIEW_ROUND_INDEX` | no | Workflow computes from prior handoff markers; this env is a fallback |
| `DRY_RUN` | no | `'true'` → log body instead of posting |
| `WRILY_AGENT_TIMEOUT_MS` | no | Override claude CLI timeout (default 30 min) |
| `WRILY_DEBUG_AGENT_OUTPUT` | no | Path to dump raw model stdout/stderr |

---

## Docs

- [Adoption guide](docs/adoption.md) — onboarding playbook
- [Webhook architecture](docs/design/webhook-architecture.md) — full design + security model
- [Writing skills](docs/writing-skills.md) — how to write custom reviewer skills
- [`integrations/cloudflare-worker/RUNBOOK.md`](integrations/cloudflare-worker/RUNBOOK.md) — Worker setup, deploy, rotate, observe
- [Design spec](docs/superpowers/specs/2026-04-01-auto-reviewer-design.md) — original design document
