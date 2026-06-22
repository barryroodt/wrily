# Wrily — Adoption Guide

> This guide is for **repo owners** in an org that already has Wrily set up. If you're an org admin standing up Wrily for the first time, start with [self-hosting.md](self-hosting.md).

## Quick Start

Ask your org's Wrily admin to **install the GitHub App** on your repo. That's it. Open a PR and Wrily reviews it automatically.

No workflow YAML. No secrets. No per-repo Actions/GHCR permissions. No `ANTHROPIC_API_KEY` to plumb — your org admin handles that once.

Behind the scenes: GitHub delivers the `pull_request` event to the App's webhook → a Cloudflare Worker verifies the HMAC, mints minimum-scope installation tokens (Wrily runner / consumer / optional shared skills), and dispatches `repository_dispatch(review-pr)` at your org's fork of Wrily → Wrily's Actions workflow clones the consumer repo and optional shared skills repo, runs the review, posts comments and a `Wrily / review` Check Run back to the PR using the consumer-scoped token. See `docs/design/webhook-architecture.md` for the full flow + security model.

## Verification

When you push a commit to a PR:

1. App settings → **Advanced → Recent Deliveries** should show a `pull_request.synchronize` delivery within seconds. `200` = handed off to the Worker. Anything else = check the Worker logs (`pnpm tail` from `integrations/cloudflare-worker/` for admins).
2. PR's checks panel should show `Wrily / review — In progress…` within ~10s, transitioning to `Review completed` after the run finishes.
3. Inline review comment lands within 1–2 min for typical PRs.

## Customization (Optional)

Wrily reads `.wrily.yml` from the root of your repo. All keys optional — defaults work for most repos.

```yaml
model: anthropic/claude-opus-4-8  # provider/model slug (default); anthropic / openai / google, e.g. openai/gpt-4o
mode: auto                # auto (default) | single | team
team_threshold: 5         # auto-flips to team mode at this many files/folders
team_threshold_unit: files # files (default) | folders
style: terse              # terse (default, caveman-review) | verbose (full prose)
sensitivity: important    # important (default) | minor | critical — severity floor for posted findings
max_tokens: 8000000       # token budget; override the per-mode default (2M single / 8M team)
request_changes: false    # true → REQUEST_CHANGES on Critical findings; false → COMMENT-only
rerequest_cooldown_minutes: 0  # cooldown between /wrily review re-requests on the same head SHA, in minutes. 0 disables (default).
reply_feedback: on        # on (default) | off — when 'on', suppresses replies on disputed prior comments. Set 'off' to disable.

ignore:
  - "**/*.lock"
  - "**/*.generated.*"
  - "vendor/**"
  - "gen/**"
  - "**/*.pb.go"

shared_skills:            # Opt-in org skills from your optional shared skills repo;
  - rust-pro              # this list controls which skills are explicitly loaded into Claude)
  - security-standards
```

> **Glob patterns** in `ignore:` should use the recursive form (`**/*.lock`, `**/*.pb.go`) to match nested files. Single-`*` patterns may only match files at the repo root depending on the matcher. The recursive form is unambiguous.

### Comment style

| `style:` | Output |
|---|---|
| `terse` (default) | One-liner per finding: `L<line>: 🔴 bug: <problem>. <fix>.` — terse, scannable, severity-prefixed |
| `verbose` | Full prose, explanation paragraphs |

Security findings and architectural disagreements always get full prose regardless of style — the `caveman-review` skill has an "auto-clarity" rule that switches to prose when explanation is load-bearing.

### Severity floor

| `sensitivity:` | Inline behavior | Summary behavior |
|---|---|---|
| `minor` | Critical + Important + Minor all posted inline | All severities listed |
| `important` (default) | Critical + Important posted inline; Minor hidden | Summary appends `N minor findings hidden — set sensitivity: minor in .wrily.yml to see` when `N > 0` |
| `critical` | Only Critical posted inline; Important + Minor hidden | Summary appends `N important + M minor findings hidden — lower sensitivity in .wrily.yml to see` when either count is non-zero |

The default is `sensitivity: important`. Repos that want every Minor finding inline must add `sensitivity: minor` to `.wrily.yml`.

### `CLAUDE.md` / `AGENTS.md`

Claude reads these naturally for project conventions. Add review-specific guidance:

```markdown
## Code Review Focus
- This repo handles PII — prioritize security findings
- All new endpoints must have integration tests
```

### Application criticality

Wrily's confidence rating reads the repo's criticality tier from `CLAUDE.md` or `AGENTS.md`. If you don't declare one, the reviewer asks per-PR — and if it can't get an answer, it refuses to score and tells you to add the declaration here.

| Tier | Label | When |
|------|-------|------|
| 1 | Critical | Data plane, auth, encryption, wire protocol — bad merge breaks production for users. |
| 2 | Important | Control plane, orchestration — bad merge degrades service but doesn't break the data path. |
| 3 | Supporting | Observability, admin tooling, internal dashboards — bad merge inconveniences operators. |
| 4 | Development | Local-only tooling, docs, examples — bad merge has no production impact. |

Add a short stanza near the top of `CLAUDE.md` / `AGENTS.md`:

````markdown
## Wrily Review

**Application criticality: Tier 1 (Critical)** — handles the wire-protocol path and customer PII. A bad merge here can break production traffic, so reviews should weight risk accordingly.
````

Pick the tier whose *When* row best matches your repo. The one-line rationale after the tier label is what the reviewer cites in the confidence-rating breakdown — keep it concrete (what the repo does, what breaks if a bad merge ships).

### Custom skills

Add specialist skills to `.claude/skills/` in your repo. Auto-discovered by the reviewer.

- **Specialist reviewer** — used by agent-team mode when relevant files change:
  ```
  .claude/skills/rust-postgres-ext/SKILL.md
  ```
- **Codebase context** — read by all reviewers for background:
  ```
  .claude/skills/my-repo-context/SKILL.md
  ```

See `docs/writing-skills.md` for how to author custom skills.

### Org skills via shared

`<your-shared-skills-repo>/skills/<name>/SKILL.md` skills are available to any repo that opts in via the `shared_skills:` list. Configure the shared skills repo with `SHARED_REPO`; when it is unset, Wrily runs without org-context skills. `shared_skills:` only controls which skills get explicitly loaded into Claude's skill set for the review.

## Review Modes

| Mode | When | Default budget | What runs |
|------|------|---------------|-----------|
| **Single** | <`team_threshold` files/folders changed | 2M tokens | One reviewer, 8 review criteria |
| **Team** | ≥`team_threshold` files/folders changed | 8M tokens | Parallel agents (correctness, conventions, contracts, spec-compliance) |
| **Auto** (default) | — | varies | Picks single or team based on file scope |

`team_threshold` defaults to 5 and `team_threshold_unit` defaults to `files`; override either per-repo in `.wrily.yml`. With `team_threshold_unit: folders`, Wrily counts distinct changed parent directories such as `src/api` and `src/db`, not only top-level repo folders.

## Operator Configuration

### Wrily bot login

Reply-as-feedback identifies Wrily's prior comments by author login. Default
`wrily` matches the deployed App slug. If you deploy under a different
slug, override with the GitHub Actions repository variable `WRILY_BOT_LOGIN`:

```bash
gh variable set WRILY_BOT_LOGIN --body "<your-slug>" --repo barryroodt/wrily
```

Either bare slug (`wrily`) or `[bot]`-suffixed (`wrily[bot]`)
form is accepted — the helper strips `[bot]` before comparing. GraphQL returns
`<slug>` without the suffix; REST returns `<slug>[bot]` with it.

Wrong slug → digest silently excludes all threads, suppression never fires.

## Delta Reviews

On subsequent pushes to an open PR, Wrily detects the last reviewed commit (from a marker comment in its prior reviews) and reviews only files **the author changed** since that point. Files merged in from the base branch since the last review are excluded — so a `git merge main` to refresh the branch doesn't inflate the review scope. Falls back to full review on force-push.

If a push contains only a base-branch merge with no author changes, Wrily exits cleanly with `Delta scope: nothing to review` — no wasted run.

## Opt out per PR

Add `[skip-wrily]` to the PR title. The workflow skips any PR with that marker.

## FAQ

**Q: How much does it cost per review?**
Single mode: ~$1–3 for typical PRs. Team mode: ~$5–10. Budget caps prevent runaway costs.

**Q: Can it approve PRs?**
No. Wrily only posts `COMMENT` reviews by default. Enable `request_changes: true` in `.wrily.yml` to allow `REQUEST_CHANGES` for Critical findings.

**Q: What about forked PRs?**
The App only receives webhook events from the upstream repo, not from fork-opened PRs that GitHub delivers with restricted tokens. `pull_request_target`-equivalent handling is on the Worker side — see `docs/design/webhook-architecture.md`.

**Q: What if the App isn't installed on `your-org/shared-wrily-skills`?**
Reviews still run, just without org context. If `SHARED_REPO` is unset, no shared-skills token is minted. If it is set but inaccessible to the App installation, the dispatch payload carries `shared_token: null` and the entrypoint skips the org-context clone with a clear log line.

**Q: Something failed — where do I look?**
1. PR → checks panel → `Wrily / review` row → click `Details` → run log
2. App settings → **Advanced → Recent Deliveries** → ground truth for what reached the receiver
3. Worker logs: admin runs `pnpm tail` from `integrations/cloudflare-worker/`

Wrily posts a fallback comment on the PR when a review can't complete (timeout, budget exceeded, Anthropic API failure).

**Q: How do I switch from n8n to the Cloudflare Worker?**
The receiver layer in `integrations/` ships both. The App's webhook URL is the only thing that changes. See `integrations/README.md` for the comparison and `integrations/cloudflare-worker/RUNBOOK.md` for the deploy steps.

**Q: Why are GitHub Actions runs in `barryroodt/wrily` and not in my repo?**
The App centralizes the runner in `barryroodt/wrily` so consumer repos don't need to plumb `ANTHROPIC_API_KEY` or grant Actions/GHCR permissions. The review activity (comments, Check Run) lands on the consumer PR via the consumer-scoped install token.

## Re-requesting a review

Comment `/wrily review` (or `@wrily review`) on a PR conversation to trigger a fresh review. By default the new review is delta-scoped (changes since the last review). Append `full` to force a full-PR review:

    /wrily review full

The trigger must be on its own line, not inside a fenced code block, and not inside a `>` blockquote. Only the PR author or repo collaborators can trigger re-reviews.

If a review is already running for the current commit, a new request is rejected with a `confused` reaction and a one-line reply. Set `rerequest_cooldown_minutes` in `.wrily.yml` to add a cooldown between reviews on the same commit.

### App permission requirements

Re-request and reply-as-feedback need permissions beyond the original Wrily install. If you upgraded an existing install, GitHub will prompt installers to re-accept; new installs get them by default.

| Permission | Level | Why |
|---|---|---|
| Pull requests | Read & Write | Post review comments, replies-in-thread (already required) |
| Contents | Read | Clone consumer repo (already required) |
| Checks | Write | Surface the `Wrily / review` check-run (already required) |
| **Issues** | **Read & Write** | Post `eyes`/`rocket`/`confused` reactions on PR comments and reject-reply messages. **Write** is required, not Read — POST `/issues/comments/.../reactions` requires `issues:write` per GitHub's REST docs. Without Write, every reaction and reject reply silently 403s and rejected users see no feedback. |

| Event subscription | Why |
|---|---|
| Pull request | Push-triggered reviews (already required) |
| **Issue comment** | `/wrily review` re-request trigger. Without this subscription, the Worker never receives the comment payload and the feature is dead. |
