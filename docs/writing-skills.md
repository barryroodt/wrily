# Writing Custom Skills for Wrily

Wrily discovers and uses skills from two locations:
- **Shared skills** (org-wide, opt-in via `.wrily.yml`)
- **Repo skills** (in `.claude/skills/` within your repository)

## Skill Types

### Specialist Reviewer

A skill that reviews code with domain-specific expertise. Used by agent-team mode when the diff contains matching file types.

**Example: Rust/pgrx specialist for payments-service**

```
.claude/skills/rust-conductor/SKILL.md
```

```markdown
---
name: rust-conductor
description: Reviews Rust code in payments-service for pgrx patterns, unsafe blocks, and Postgres extension idioms
---

# Rust Conductor Reviewer

You review Rust code in the payments-service service, focusing on:

## Focus Areas
- pgrx macro usage and Postgres extension patterns
- Unsafe block justification and soundness
- Error handling with proper PostgreSQL error codes
- Memory safety around SPI (Server Programming Interface) calls
- Schema migration compatibility

## What NOT to Review
- General Rust style (that's the conventions reviewer)
- Logic bugs not specific to pgrx (that's the correctness reviewer)

## Output Format
[Same as other reviewer templates — verdict, issues by severity, strengths]
```

**How it gets discovered:** The `agent-team-review` skill scans `.claude/skills/` for skills whose descriptions match file extensions in the diff. When `.rs` files change in `payments-service/`, this skill is picked up.

### Codebase Context

A skill that provides background knowledge about the codebase. Read by all reviewers before they start.

**Example: payments-service context**

```
.claude/skills/payments-service-context/SKILL.md
```

```markdown
---
name: payments-service-context
description: Background context for the payments-service monorepo — architecture, services, patterns
---

# payments-service

Cloudflare Workers monorepo with these services:

## Services
- **payments-service** (Rust) — Postgres extension that manages instance lifecycle
- **tenant-manager** (TypeScript) — Tenant provisioning and configuration
- **api-gateway** (TypeScript) — Public API entry point

## Key Patterns
- All services communicate via Cloudflare Durable Objects
- Configuration flows: API → tenant-manager → payments-service → launcher
- Error handling uses structured error codes (see errors/ directory)

## Common Review Concerns
- Durable Object state mutations must be idempotent
- Cross-service schema changes need coordinated deployment
- The launcher env var format is strict — see LAUNCHER_CONFIG.md
```

**How it gets discovered:** The review prompt searches for skills with `context` in their path and reads them before starting the review.

## Skill File Structure

Every skill is a directory containing a `SKILL.md` file:

```
.claude/skills/
  my-skill/
    SKILL.md          # Required — the skill definition
    templates/         # Optional — reviewer templates (for specialist reviewers)
    examples/          # Optional — example code for reference
```

The `SKILL.md` file uses YAML frontmatter:

```markdown
---
name: skill-name           # Used for identification
description: One-line description used for skill discovery and matching
---

# Skill Title

[Skill content — instructions, patterns, focus areas, output format]
```

## Tips

- Keep skills focused. One skill per concern.
- The `description` field is how the agent-team skill discovers specialists — include keywords that match file extensions and directory names.
- Context skills should be factual and stable. Don't put temporary information here.
- Test your skill locally: `DRY_RUN=true ./test-local.sh your-org/your-repo PR_NUMBER`

## Publishing Org-Wide Skills via Shared

To make a skill available to all repos:

1. Add it to `your-org/shared-wrily-skills/skills/your-skill/SKILL.md`
2. Repos opt in via `.wrily.yml`:
   ```yaml
   shared_skills:
     - your-skill
   ```
