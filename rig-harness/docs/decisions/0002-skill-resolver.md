# ADR-0002: Skill resolver convention

**Status:** Accepted  
**Date:** 2026-05-28  
**Deciders:** rig-harness phase-0 (task 0.3)

## Context

Wrily today relies on the Claude Code CLI to discover skills from multiple locations: repo-local `.claude/skills/`, user-global `~/.claude/skills/`, and org-wide skills copied from a shared repo by the `bridgeSkills` workflow step. The rig-harness sidecar (`wrily-rig`) replaces that CLI with a Rust agent loop that must load the same skill content without MCP (invariant #8) and with strict workdir isolation (invariant #10).

The design spec defines a `SkillLoader` with two consumption paths:

- **Phase 3.1 (auto-inject):** four core review skills loaded at agent startup and prepended to the system prompt.
- **Phase 3.2 (lazy `skill_load` tool):** on-demand reads for any other skill the model chooses to invoke.

We need a single, implementable resolution convention so Phase 3 tasks do not re-litigate paths, population responsibility, or file format.

### Current Wrily conventions (preserved)

| Source | Today (Claude CLI) | Path |
|--------|-------------------|------|
| Repo skills | Auto-discovered in cloned consumer repo | `{repo}/.claude/skills/<name>/SKILL.md` |
| Org shared skills | `bridgeSkillsStep` copies opt-in names from shared clone | `~/.claude/skills/<name>/` (dest) ← `{shared}/skills/<name>/` (src) |
| Shipped Wrily skills | Bundled in repo, referenced by prompts | `wrily/skills/<name>/SKILL.md` |
| Skill name validation | `isValidSharedSkillName` | `^[A-Za-z0-9_-]+$` |

Repo-local skills already live under `.claude/skills/` when the consumer repo is cloned to `--workdir`. Org skills currently land in the user's home directory because Claude Code reads `~/.claude/skills/` globally — that path is **incompatible** with rig-harness workdir isolation.

## Decision

### 1. Canonical on-disk layout

Every skill resolved at runtime uses this layout relative to a search root:

```
<root>/.claude/skills/<name>/SKILL.md
```

For `wrily-rig`, the only runtime search root is **`--workdir`**. There is no `$HOME`, plugin, or MCP skill root in v1.

Optional sibling directories (`templates/`, `examples/`, `references/`) may exist under `<name>/`; only `SKILL.md` is loaded by `SkillLoader` / `skill_load`. Relative links inside the markdown body are the model's responsibility (via `read_file` or follow-up `skill_load` calls).

### 2. Resolution order

#### Auto-inject set (Phase 3.1 — `SkillLoader::inject_core_skills`)

Fixed set, loaded once at agent startup, in this order:

```
caveman-review
agent-team-review
code-review
confidence-rating
```

Per skill `name`, resolve **first hit wins**:

1. `{workdir}/.claude/skills/{name}/SKILL.md` — repo override or pre-bridged org copy
2. **Bundled fallback** — compile-time `include_str!` of `wrily/skills/{name}/SKILL.md` vendored into the `wrily-rig` crate at build time

If both are absent (should not happen for bundled names), log a warning to stderr and skip that skill; do not abort the run.

Each successfully loaded skill emits one NDJSON `skill_loaded` event on stdout (name + source: `workdir` | `bundled`).

#### Lazy load (Phase 3.2 — `skill_load` tool)

Lazy `skill_load` never falls back to bundled content, even for the auto-inject set.

Arguments: `{ "name": "<skill-name>" }`

Resolution:

1. `{workdir}/.claude/skills/{name}/SKILL.md` **only** — no bundled fallback, no home directory

On success, return the full file contents wrapped for the model:

```xml
<skill name="{name}">
{file contents}
</skill>
```

On failure (invalid name, missing file, path escapes workdir), return `error: <message>` in `tool_result` (invariant #5); the run continues.

The bundled four core skills **may** be loaded again via `skill_load` if a workdir copy exists; otherwise return `error: skill not found: {name}` (lazy path does not fall back to `include_str!`).

### 3. Who populates skills

| Skill class | Populator | Destination seen by `wrily-rig` |
|-------------|-----------|----------------------------------|
| **Repo-local** (specialists, `*-context`) | Consumer repo author; present after `cloneRepo` | `{workdir}/.claude/skills/<name>/` |
| **Org shared** (`.wrily.yml` → `shared_skills:`) | **Wrily TS workflow** — `bridgeSkillsStep` **must copy into `{workdir}/.claude/skills/`** before spawning `wrily-rig`, not `~/.claude/skills/` | `{workdir}/.claude/skills/<name>/` |
| **Core Wrily skills** (auto-inject set) | **`wrily-rig` build** — `include_str!` from `wrily/skills/`; overridable per-repo via workdir copy | bundled and/or `{workdir}/.claude/skills/<name>/` |
| **User global** (`~/.claude/skills/`) | **Not read by `wrily-rig` in v1** | — |

**Wrily CLI install** does not lay down skills into the user's home for rig-harness. The sidecar is self-contained via bundled fallbacks. Optional org/repo skills are the workflow's job to materialize under `--workdir` before launch.

Migration note: today's `bridgeSkillsStep` writes to `join(homedir(), '.claude', 'skills')`. When `RigRunner` replaces `ClaudeCodeRunner`, that step changes destination to `join(repoPath, '.claude', 'skills')` (same `bridgeSkills` helper, different `destRoot`). Until Phase 9 cutover, both runners may coexist briefly in development; production cutover is hard (invariant #9).

### 4. File format

Match existing Wrily / Claude Code skill convention documented in `docs/writing-skills.md` and the shipped `wrily/skills/*/SKILL.md` files:

**Required structure**

```markdown
---
name: skill-name
description: One-line description used for discovery and matching
---

# Skill Title

(Markdown body — instructions, workflows, output contracts)
```

**Rules**

- **`name`:** Must match the directory name `<name>` and satisfy `^[A-Za-z0-9_-]+$` (same as `isValidSharedSkillName` in `src/skills/names.ts`). Reject names containing `/`, `..`, or other traversal before path join.
- **`description`:** Required in frontmatter; used in prompt text listing available lazy-load skills (not for auto-inject, which is unconditional).
- **`metadata`:** Optional YAML mapping (e.g. `author`, `version`); ignored by loader, preserved in injected content.
- **Body:** Opaque markdown passed verbatim to the model; no templating or variable substitution in v1.
- **Frontmatter parsing:** Split on first `---` / closing `---` pair (CommonMark YAML frontmatter). Malformed frontmatter → treat entire file as body, log warning to stderr.

**Optional directories** under `<name>/` (e.g. `templates/`, `references/`) are not auto-walked; skills reference them explicitly in markdown.

### 5. Auto-inject vs lazy `skill_load`

| Aspect | Auto-inject (3.1) | Lazy `skill_load` (3.2) |
|--------|-------------------|-------------------------|
| **When** | Once, before first provider call | On each model tool invocation |
| **Skills** | Fixed four-name set only | Any valid name under workdir |
| **Fallback** | Workdir → bundled `include_str!` | Workdir only |
| **Prompt effect** | Concatenated into system prompt (order: list above) | Appended via tool result in conversation |
| **NDJSON** | `skill_loaded` per skill | `tool_call` / `tool_result` pair |
| **Typical use** | Core review pipeline always available | Repo specialists, `*-context` skills, opt-in org skills not in auto-inject set |

Repo `*-context` skills are **not** auto-injected; existing prompt templates instruct the model to load them via `skill_load` (or `read_file` on the same path). Team-mode specialist discovery (Phase 5+) lists workdir skills by scanning `{workdir}/.claude/skills/*/SKILL.md` descriptions, not `~/.claude/skills/`.

### 6. Path safety

All paths canonicalized under `--workdir`:

- Reject if resolved path is outside workdir → `error: path outside workdir`
- Reject invalid skill names before join
- Use native file read (preferred over shell `cat`; invariant #6)

## Consequences

### Positive

- **Workdir isolation** is satisfied: no reads from `$HOME`, plugins, or MCP.
- **Parity with Wrily docs**: same `.claude/skills/<name>/SKILL.md` layout consumer repos already use.
- **Offline / CI reliability**: core review skills always available via bundled fallback even when the consumer repo defines no skills.
- **Clear split** for implementers: `SkillLoader` (startup, system prompt) vs `skill_load` tool (model-driven, tool_result).

### Negative / migration

- **`bridgeSkillsStep` destination change** required before production cutover; org skills silently missing if still copied only to `~/.claude/skills/`.
- **User-global skills** (`~/.claude/skills/`) no longer apply unless the user copies them into the repo or Wrily adds an explicit pre-run sync (out of scope v1).
- **Bundled skills can drift** from `wrily/skills/` unless CI checks `include_str!` sources on change (recommended follow-up).

### Implementation checklist (Phase 3)

- [ ] `SkillLoader::resolve(name) -> ResolvedSkill { content, source }` with workdir-then-bundled for auto-inject set
- [ ] `skill_load` tool: workdir-only, wrapped output, soft errors
- [ ] Build script or `build.rs` sync of `../../skills/{name}/` into crate for `include_str!`
- [ ] Unit tests: workdir override shadows bundled; invalid name; missing lazy skill; path traversal rejected
- [ ] TS: change `bridgeSkillsStep` dest to `{repoPath}/.claude/skills` (Phase 9 or earlier RigRunner integration)

## References

- Spec: `solo://proj/11/scratchpad/rig-harness-replace--1`
- Plan: `solo://proj/11/scratchpad/rig-harness-implemen--2` — Phase 3 tasks 3.1 (SkillLoader auto-inject), 3.2 (`skill_load` tool)
- `docs/writing-skills.md` — skill types, layout, frontmatter
- `wrily/skills/{caveman-review,agent-team-review,code-review,confidence-rating}/SKILL.md` — canonical content for bundled fallbacks
- `src/workflow/steps.ts` — `bridgeSkillsStep` (current home-dir destination)
- `src/skills/names.ts` — `isValidSharedSkillName`
- Shared architectural invariants #5 (soft tool errors), #8 (no MCP), #10 (workdir isolation)
