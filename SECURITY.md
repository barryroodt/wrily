# Security Policy

## Supported Versions

Wrily is pre-1.0 and ships from `main`. Security fixes land on `main` and the next tagged container image. Older tags are not patched — pin to a SHA only if you're willing to upgrade when a fix lands.

| Version | Supported |
|---------|-----------|
| `main` / latest container tag | ✅ |
| Anything older | ❌ |

## Reporting a Vulnerability

**Do not open a public issue or PR for security reports.**

Use one of:

1. **GitHub Private Vulnerability Reporting** — preferred. Repo → Security → "Report a vulnerability". Encrypted, tracked, fixes can be coordinated through a draft security advisory.
2. **Email** — `barry@jumptag.co.za`. Subject prefix: `[wrily-security]`. PGP available on request.

Please include:

- Affected component (CLI / GitHub App / Cloudflare Worker / Action / container image).
- Affected commit SHA or container tag.
- Reproduction steps or proof-of-concept.
- Impact assessment (what an attacker gains).
- Your disclosure timeline preference.

## What's In Scope

- Token handling in the Mastra workflow (`src/`) — install token scope, leakage, persistence.
- Webhook receiver (`integrations/cloudflare-worker/`, `integrations/n8n/`) — HMAC verification, replay, token minting.
- GitHub Actions workflows in `.github/workflows/` — privilege escalation, untrusted-input injection, artifact poisoning.
- Container image (`ghcr.io/barryroodt/wrily`) — baked-in secrets, supply-chain integrity, base-image CVEs we ship unpatched.
- Prompt construction (`src/prompt/`) — injection vectors that let PR content steer Wrily into posting attacker-controlled content under the bot identity.
- `.wrily.yml` parsing — config-driven path traversal, command injection, schema-bypass.

## Out of Scope

- Findings produced by Wrily on third-party code (those are Wrily output, not Wrily vulns).
- Social-engineering attacks against repo maintainers.
- Denial-of-service via large diffs / large repos — budget caps + timeouts are the documented mitigation.
- Issues that require a malicious GitHub App owner — that's a trust boundary, not a vuln.
- Vulnerabilities in third-party dependencies without a demonstrated impact on Wrily (file upstream).

## Response Targets

- Acknowledgement: within 3 business days.
- Triage + severity assessment: within 7 business days.
- Fix or mitigation plan: within 30 days for High/Critical, best-effort otherwise.
- Public disclosure: coordinated through a GitHub security advisory once a fix is available, with credit to the reporter unless they decline.

## Safe Harbor

Good-faith security research on your own installations (or test installations you control) is welcomed. Do not test against installations you do not own — Wrily processes other people's source code, and unauthorized access to a consumer repo is a real-world incident, not research.
