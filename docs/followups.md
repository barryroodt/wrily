# Followups

Running list of things we know we want to do, captured across sessions so they don't get lost. Not a roadmap — priority and timing are decided when work starts.

## CI / quality

- Add `pnpm test` + `pnpm typecheck` jobs to PR CI. Currently `smoke.yml` only builds the container; type errors and unit-test regressions don't fail the build.
- Add worker `pnpm test` + `pnpm typecheck` on PRs touching `integrations/cloudflare-worker/`. Today worker tests only run inside `deploy-worker.yml` (workflow_dispatch).
- Verify CodeQL fires on the next opened PR. It was added as a required check but didn't run on the first Dependabot batch — confirm the trigger is wired before it silently blocks merges.
- Run `shellcheck` against the `wrily` bash entrypoint in CI.

## Release pipeline (touch when tagging next `v*`)

- Trivy image scan in `publish.yml`; fail on HIGH+ CVEs.
- `cosign` sign published images (keyless via GitHub OIDC).
- SBOM + provenance attestation via `actions/attest-build-provenance`.
- Pin Dockerfile base image by digest (`node:22-slim@sha256:…`) instead of by tag, so Dependabot tracks digest moves.

## Package updates (Dependabot backlog)

Closed [#19](https://github.com/barryroodt/wrily/pull/19) (May 2026) — grouped `prod-minor-patch` bump; smoke CI passed but `pnpm test` failed 43/272 on the Mastra jump. Split the work below; don't re-bundle.

### Safe to land separately (were bundled in #19)

- `@octokit/graphql` 8.1.1 → 8.2.2 — patch/minor; no code changes expected.
- `@octokit/rest` 21.0.2 → 21.1.1 — includes ReDoS mitigation in Octokit deps.
- `yaml` 2.5.1 → 2.9.0 — parser hardening + bugfixes; no API change for our usage.

### Already merged (May 2026 Dependabot triage)

- ✅ `protobufjs` 7.5.6 → 7.6.0 ([#21](https://github.com/barryroodt/wrily/pull/21))
- ✅ `docker/login-action` 4.1.0 → 4.2.0 ([#22](https://github.com/barryroodt/wrily/pull/22))
- ✅ `docker/build-push-action` 7.1.0 → 7.2.0 ([#23](https://github.com/barryroodt/wrily/pull/23))
- ✅ `docker/metadata-action` 5.10.0 → 6.1.0 ([#24](https://github.com/barryroodt/wrily/pull/24))
- ✅ Cloudflare worker dev deps: `workers-types`, `vitest` 4.1.6→4.1.7, `wrangler` 4.92→4.94 ([#25](https://github.com/barryroodt/wrily/pull/25))

### Deferred elsewhere

- Node 26 (#2) — node 22 LTS is fine for now.
- Consider excluding `@mastra/core` from the Dependabot `prod-minor-patch` group so future bumps don't reopen a bundled PR.

## Self-hosting polish

- Pre-bake a GitHub App manifest JSON so step 2 of `docs/self-hosting.md` collapses to one click. Manifest payload + a one-shot script that posts to `app-manifests/<code>/conversions`.
- Dogfood the self-hosting guide on a throwaway org. Fold any pain points back into `docs/self-hosting.md`.
- Optional: Terraform / Pulumi snippet covering App + Cloudflare Worker + GHCR repo settings, so the whole thing is setup-as-code.
- `integrations/cloudflare-worker/wrangler.jsonc` ships with `WRILY_REPO` defaulting to `barryroodt/wrily`. Consider changing the default to a sentinel value (e.g. `REPLACE_WITH_FORK`) so a fork that forgets to edit it fails loudly instead of dispatching at the canonical repo.

## Docs

- Add a screenshot or asciinema cast to the README so the value is visible at a glance.
- Worked example for `team_threshold_unit: folders` (current docs explain the unit but not the counting boundary in a worked case).
- Document the threat model for PR-content prompt injection — Wrily reads attacker-controllable diffs and produces comments under a bot identity. Worth a section in `docs/design/webhook-architecture.md`.

## Repo hygiene (when triggers fire, not before)

- `.github/CODEOWNERS` — once there's more than one maintainer.
- `.github/ISSUE_TEMPLATE/{bug,feature}.yml` + `PULL_REQUEST_TEMPLATE.md` — once external contributors start showing up.
- Re-evaluate Dependabot grouping rules after the first month of bumps to see what patterns are noisy.

## Operational gaps

- No alerting on Worker failure rate or `dispatch-review.yml` failure rate. Cloudflare Notifications + a GitHub Actions failure webhook would cover both.
- No dashboard for provider spend across reviews. `max_tokens` caps the per-review token budget, but cumulative spend is invisible.
- Re-request race window (two `/wrily review` comments within 5–15 s on the same head SHA dispatch parallel reviews) is accepted per spec but not surfaced in user-facing docs.

## Security backlog

- Secret scanning non-provider patterns + validity checks — requires GitHub Advanced Security. Note in case the repo ever moves to a plan that includes GHAS.
- Pen-test the webhook receiver before broader adoption (HMAC bypass attempts, replay, payload-injection, large-payload DoS).
- Add a `gitleaks` GitHub Action workflow so history scans run on every push, not just locally.

## Post-cutover follow-ups

The [`claude -p` → in-process pi cutover](https://github.com/barryroodt/wrily/pull/32) (June 2026) was itself superseded by the [pi → gantry subprocess cutover](https://github.com/barryroodt/wrily/pull/40) (June 2026): `PiRunner` no longer exists — the agent now runs as the gantry subprocess (`GantryRunner`). The pi-specific items below are historical and must be re-evaluated against gantry before any action:

- **Surface pi provider/auth errors clearly.** `PiRunner` currently lets a failed `prompt()` resolve with empty stdout (e.g. expired API key), which the workflow surfaces downstream as a generic "no \`\`\`json fence" failure comment. Subscribe to pi's `agent_end` / message-error events and throw a typed `ConfigError` / provider error so the failure comment names the cause.
- **Eval framework.** Fixture-driven agent eval runs (sql-injection probe, delta-clean confirmation, team-mode behaviour, budget-trip) with assertions. Easier under pi than the abandoned Rust sidecar because PiRunner accepts an injected `PiSessionFactory` — replay-style fakes can drive whole reviews in-process and deterministically.
- **MCP support.** Deferred — pi's native tools (`read,grep,find,ls,bash`) plus the hermetic resource loader covered v1. Revisit when reviewers need richer tool surfaces (databases, internal docs).
- **`bridgeSkills` ↔ pi loader.** `cfg.shared_skills` still copies skills into `~/.claude/skills`, but PiRunner's hermetic `DefaultResourceLoader` (`noSkills: true`) does not read from there — the bridge is currently inert. Either wire `shared_skills` into pi's resource loader as an explicit allowlist or delete the bridge.
- **Test-fixture consolidation.** `tests/workflow/*.test.ts` carry ~1.3k duplicated lines of `baseEnv`/`baseCfg`/`emptyDigestPage` + the `buildReviewWorkflow → createRun → start` scaffold (~15 files; ~11% duplication per `fallow dupes`). Extract a `tests/workflow/fixtures.ts` helper — behaviour-neutral but cross-cutting, hence a separate PR.

## Closed / done (kept for context)

- ✅ Public release (`feat: Initial release`).
- ✅ Legacy reference scrub (caveman branding removed, metal-standards example replaced).
- ✅ SECURITY.md, Dependabot config, Contributing section, gitleaks allowlist.
- ✅ Branch protection on `main` (build + CodeQL required, linear history, no force-push).
- ✅ Workflow permissions tightened (top-level `contents: read`; reusable workflow `permissions: {}`).
- ✅ CodeQL default setup, private vulnerability reporting, secret scanning, Dependabot security updates all enabled.
- ✅ First Dependabot batch triaged: vitest CVE patch, hono CVE patch, actions/docker majors merged; node 26 + Mastra major bump closed for later.
- ✅ May 2026 Dependabot triage: merged #21–#25 (protobufjs, docker actions, worker dev deps); closed #19 (Mastra + octokit/yaml bundle) — octokit/yaml/Mastra tracked above.
- ✅ Self-hosting guide drafted; README reframed around BYO deployment.
- ✅ `@mastra/core` 0.10.0 → 1.37.1 (Mastra moved past 0.x while we deferred — jumped directly to 1.37.1). API note: `createRunAsync()` doesn't exist — `createRun()` itself is async and returns `Promise<Run>`, so all 35 call sites became `await workflow.createRun()`. `createStep` / `createWorkflow` signatures compatible as-is.
- ✅ `claude -p` → in-process pi coding agent ([#32](https://github.com/barryroodt/wrily/pull/32), June 2026). Made Wrily provider-agnostic (any pi-supported model via `provider/model` slug); dropped Cursor + `CLAUDE_CODE_OAUTH_TOKEN` + Claude-Agent-Teams; team mode reframed as Wrily-orchestrated parallel reviewers + unify pass.