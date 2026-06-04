/**
 * Model reference resolution.
 *
 * The `provider/model` slug (e.g. `anthropic/claude-opus-4-8`, `openai/gpt-4o`)
 * is the single canonical form Wrily uses everywhere it references a model —
 * config defaults, env overrides, persistence, logs, docs. `resolveModel`
 * normalizes *any* accepted input into that slug and validates it against the
 * pi model registry, so every downstream layer can assume it is holding a real,
 * canonical slug.
 *
 * pi ships `findExactModelReferenceMatch` but does not re-export it from its
 * package root (the exports map only exposes `.` and `./hooks`), so the ~40-line
 * matcher is inlined here against the registry's structural surface.
 */

/** Canonical default model slug used when no model is configured. */
export const DEFAULT_MODEL_SLUG = 'anthropic/claude-opus-4-8';

/**
 * Thin convenience aliases. The slug is the canonical form; these bare family
 * names are accepted only as sugar and are normalized to a slug immediately.
 * Targets are the newest model per family in the pi v0.78 registry (verified in
 * the task-150 spike). Adding aliases here is the one place bare names live.
 */
const ALIASES: Readonly<Record<string, string>> = {
  opus: 'anthropic/claude-opus-4-8',
  sonnet: 'anthropic/claude-sonnet-4-6',
  haiku: 'anthropic/claude-haiku-4-5',
};

/** A registry entry, narrowed to what resolution needs. */
export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/**
 * Minimal registry surface needed to resolve and validate a model. pi's
 * `ModelRegistry` is structurally assignable to this (its `find`/`getAll`
 * return `Model` objects, which carry `provider` and `id`), and tests can
 * supply a tiny fake without constructing the full 900+ model registry.
 */
export interface ModelLookup {
  find(provider: string, modelId: string): ModelRef | undefined;
  getAll(): readonly ModelRef[];
}

/** Thrown when a model reference matches no registry model (or is ambiguous). */
export class UnknownModelError extends Error {
  constructor(
    public readonly reference: string,
    public readonly available: readonly string[],
  ) {
    const sample = available.slice(0, 12).join(', ');
    const more = available.length > 12 ? `, … (${available.length} total)` : '';
    super(
      `Unknown model "${reference}". Use a provider/model slug, ` +
        `e.g. anthropic/claude-opus-4-8 or openai/gpt-4o. Available: ${sample}${more}`,
    );
    this.name = 'UnknownModelError';
  }
}

function toSlug(m: ModelRef): string {
  return `${m.provider}/${m.id}`;
}

/**
 * Normalize any accepted model reference to a canonical, registry-validated
 * `provider/model` slug.
 *
 * Accepts, in order of precedence:
 * - empty / null / undefined → {@link DEFAULT_MODEL_SLUG}
 * - a bare family alias (`opus`, `sonnet`, `haiku`; case-insensitive)
 * - a `provider/model` slug (validated via `registry.find`)
 * - a bare model id with no provider, accepted only when exactly one provider
 *   in the registry exposes that id (ambiguous ids are rejected)
 *
 * @throws {UnknownModelError} when the reference resolves to no registry model
 *   or to an ambiguous bare id.
 */
export function resolveModel(
  reference: string | null | undefined,
  registry: ModelLookup,
): string {
  const raw = (reference ?? '').trim();
  // Aliases and the empty-default are pure rewrites into slug form; everything
  // is then validated against the registry below so nothing escapes unchecked.
  const ref =
    raw.length === 0 ? DEFAULT_MODEL_SLUG : (ALIASES[raw.toLowerCase()] ?? raw);

  const slashIndex = ref.indexOf('/');
  if (slashIndex !== -1) {
    // Split on the FIRST slash: provider names never contain slashes, while
    // some model ids do (e.g. openrouter's `meta-llama/...`).
    const provider = ref.slice(0, slashIndex);
    const id = ref.slice(slashIndex + 1);
    const found = provider && id ? registry.find(provider, id) : undefined;
    if (found) return toSlug(found);
    throw new UnknownModelError(raw, registry.getAll().map(toSlug));
  }

  // Bare id, no provider: accept only an unambiguous single match.
  const matches = registry.getAll().filter((m) => m.id === ref);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) return toSlug(only);
  throw new UnknownModelError(raw, registry.getAll().map(toSlug));
}
