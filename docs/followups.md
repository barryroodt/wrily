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

## Mastra upgrade (was PR #10)

- `@mastra/core` 0.10 → 0.24 is a 14-minor jump on a 0.x package — effectively a breaking change. Path:
  1. Read Mastra changelog `0.10 → 0.24`.
  2. Adapt `src/workflow/` step definitions if the `createStep` / `createWorkflow` API surface changed.
  3. Re-run full vitest suite.
  4. Open as a standalone PR; don't bundle with other changes.
- Other PRs we closed (#2 node 26, #11 yaml duplicate of #10) — node 22 LTS is fine for now; yaml will roll in with the Mastra upgrade.

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
- No dashboard for Anthropic spend across reviews. `max_budget_usd` caps per-review cost, but cumulative spend is invisible.
- Re-request race window (two `/wrily review` comments within 5–15 s on the same head SHA dispatch parallel reviews) is accepted per spec but not surfaced in user-facing docs.

## Security backlog

- Secret scanning non-provider patterns + validity checks — requires GitHub Advanced Security. Note in case the repo ever moves to a plan that includes GHAS.
- Pen-test the webhook receiver before broader adoption (HMAC bypass attempts, replay, payload-injection, large-payload DoS).
- Add a `gitleaks` GitHub Action workflow so history scans run on every push, not just locally.

## Closed / done (kept for context)

- ✅ Public release (`feat: Initial release`).
- ✅ Legacy reference scrub (caveman branding removed, metal-standards example replaced).
- ✅ SECURITY.md, Dependabot config, Contributing section, gitleaks allowlist.
- ✅ Branch protection on `main` (build + CodeQL required, linear history, no force-push).
- ✅ Workflow permissions tightened (top-level `contents: read`; reusable workflow `permissions: {}`).
- ✅ CodeQL default setup, private vulnerability reporting, secret scanning, Dependabot security updates all enabled.
- ✅ First Dependabot batch triaged: vitest CVE patch, hono CVE patch, actions/docker majors merged; node 26 + Mastra major bump closed for later.
- ✅ Self-hosting guide drafted; README reframed around BYO deployment.
