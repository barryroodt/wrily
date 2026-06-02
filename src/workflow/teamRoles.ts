import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Team-mode reviewer roles. Each maps to a role-prompt markdown file in
 * `skills/agent-team-review/templates/`. `output-format` is intentionally not a
 * role here — it is a shared output appendix the role files reference, not a
 * reviewer of its own.
 */
export type TeamRole =
  | 'correctness'
  | 'conventions'
  | 'spec-compliance'
  | 'go-specialist'
  | 'typescript-specialist'
  | 'contracts';

/**
 * Resolve the directory holding the role-prompt templates.
 *
 * Default: relative to this module (works in `src/` under vitest and in built
 * `dist/`, where `skills/` sits at the package root). Override with
 * `WRILY_SKILLS_DIR` — the container copies skills to `~/.claude/skills`, which
 * is not under `dist/`, so the Docker image sets this env var.
 */
function templatesDir(): string {
  const override = process.env.WRILY_SKILLS_DIR;
  const base =
    override && override.length > 0
      ? override
      : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
  return join(base, 'agent-team-review', 'templates');
}

/** Read a role's system-prompt markdown. Throws if the template is missing. */
export function loadRolePrompt(role: TeamRole): string {
  return readFileSync(join(templatesDir(), `${role}.md`), 'utf8');
}

function topLevelDir(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function isTypeScriptFile(path: string): boolean {
  if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mts') || path.endsWith('.cts')) {
    return true;
  }
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === 'package.json' || /^tsconfig.*\.json$/.test(base);
}

/**
 * Deterministically compose the reviewer roster from the changed files.
 *
 * Always includes correctness, conventions, and spec-compliance. Adds the
 * go / typescript specialists when matching files are present, and contracts
 * when the change spans more than one top-level directory (cross-boundary
 * surface). Deterministic by design — reproducible and one fewer LLM call than
 * an LLM-composed roster; an LLM composer is a future drop-in.
 */
export function composeTeam(diffFiles: readonly string[]): TeamRole[] {
  const roles: TeamRole[] = ['correctness', 'conventions', 'spec-compliance'];

  if (diffFiles.some((f) => f.endsWith('.go'))) {
    roles.push('go-specialist');
  }
  if (diffFiles.some(isTypeScriptFile)) {
    roles.push('typescript-specialist');
  }

  const dirs = new Set(diffFiles.map(topLevelDir));
  if (dirs.size > 1) {
    roles.push('contracts');
  }

  return roles;
}
