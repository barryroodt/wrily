/**
 * Model reference resolution.
 *
 * The `provider/model` slug (e.g. `anthropic/claude-opus-4-8`, `openai/gpt-4o`,
 * `google/gemini-2.5-pro`) is the single canonical form Wrily uses everywhere
 * it references a model — config defaults, env overrides, persistence, logs,
 * docs. `resolveModel` normalizes *any* accepted input into that slug and
 * validates it against the static model manifest (`models.ts`), so every
 * downstream layer can assume it is holding a real, canonical slug.
 *
 * The manifest replaces the former dependency on pi's `ModelRegistry`: aliases
 * and validation are now sourced from `MODEL_MANIFEST`, not a 900-model
 * registry.
 */

import {
  MODEL_MANIFEST,
  OPEN_CATALOG_PROVIDERS,
  modelByAlias,
  modelBySlug,
} from './models.js';

/** Canonical default model slug used when no model is configured. */
export const DEFAULT_MODEL_SLUG = 'anthropic/claude-opus-4-8';

/** A manifest entry, narrowed to what resolution needs. */
export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/**
 * Minimal manifest surface needed to resolve and validate a model. The default
 * implementation ({@link MANIFEST_LOOKUP}) wraps `models.ts`; tests can supply a
 * tiny fake to exercise ambiguity / miss branches without the real manifest.
 */
export interface ModelLookup {
  /** Canonical slug for a bare alias (case-insensitive), or undefined. */
  resolveAlias(alias: string): string | undefined;
  /** The matched ref when `provider/modelId` is a known canonical slug. */
  find(provider: string, modelId: string): ModelRef | undefined;
  /** All known canonical refs (bare-id disambiguation + error listing). */
  getAll(): readonly ModelRef[];
}

/** Thrown when a model reference matches no manifest model (or is ambiguous). */
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

/** Canonical refs for the shipped manifest, split once at module load. */
const MANIFEST_REFS: readonly ModelRef[] = MODEL_MANIFEST.map((e) => {
  const slashIndex = e.slug.indexOf('/');
  return { provider: e.slug.slice(0, slashIndex), id: e.slug.slice(slashIndex + 1) };
});

/** Default lookup, backed by the static manifest in `models.ts`. */
export const MANIFEST_LOOKUP: ModelLookup = {
  resolveAlias: (alias) => modelByAlias(alias)?.slug,
  find: (provider, modelId) =>
    modelBySlug(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined,
  getAll: () => MANIFEST_REFS,
};

/**
 * Normalize any accepted model reference to a canonical, manifest-validated
 * `provider/model` slug.
 *
 * Accepts, in order of precedence:
 * - empty / null / undefined → {@link DEFAULT_MODEL_SLUG}
 * - a bare family alias (`opus`, `sonnet`, `haiku`, `gemini`; case-insensitive)
 * - a `provider/model` slug (validated via `lookup.find`)
 * - a bare model id with no provider, accepted only when exactly one provider
 *   in the manifest exposes that id (ambiguous ids are rejected)
 *
 * Unknown-model escape hatch: when `allowUnknown` is set (threaded by the
 * caller from `RuntimeEnv.allowUnknownModel`, i.e. `WRILY_ALLOW_UNKNOWN_MODEL=1`),
 * a reference that matches no manifest model passes through unchanged with a
 * loud warning instead of throwing — such runs have no cost rates and callers
 * bill them at 0. `allowUnknown` is threaded from the composition root (default
 * `false`); the resolver never reads `process.env` itself.
 *
 * @throws {UnknownModelError} when the reference resolves to no manifest model
 *   (or to an ambiguous bare id) and the escape hatch is not set.
 */
export function resolveModel(
  reference: string | null | undefined,
  lookup: ModelLookup = MANIFEST_LOOKUP,
  opts: { allowUnknown?: boolean } = {},
): string {
  const raw = (reference ?? '').trim();
  // Empty input resolves to the default slug, which is then validated against
  // the manifest below like any other slug (so a manifest that dropped the
  // default fails loudly rather than returning a dead slug).
  const ref0 = raw.length === 0 ? DEFAULT_MODEL_SLUG : raw;
  const ref = lookup.resolveAlias(ref0) ?? ref0;

  let resolved: string | undefined;
  const slashIndex = ref.indexOf('/');
  if (slashIndex !== -1) {
    // Split on the FIRST slash: provider names never contain slashes, while
    // some model ids do (e.g. openrouter's `meta-llama/...`).
    const provider = ref.slice(0, slashIndex);
    const id = ref.slice(slashIndex + 1);
    const found = provider && id ? lookup.find(provider, id) : undefined;
    resolved = found ? toSlug(found) : undefined;
    // Open-catalog providers (OpenRouter) front a large, dynamic vendor catalog
    // that can't be enumerated in the manifest. Accept any well-formed slug
    // verbatim — gantry/the gateway validates the model id. These carry no
    // manifest rates, so usage bills at 0 (see OPEN_CATALOG_PROVIDERS).
    if (!resolved && provider && id && OPEN_CATALOG_PROVIDERS.has(provider)) {
      resolved = `${provider}/${id}`;
    }
  } else {
    // Bare id, no provider: accept only an unambiguous single match.
    const matches = lookup.getAll().filter((m) => m.id === ref);
    resolved = matches.length === 1 ? toSlug(matches[0]!) : undefined;
  }
  if (resolved) return resolved;

  // No manifest match. Either admit it via the escape hatch (unchanged + warn,
  // billed at 0) or reject loudly.
  const allowUnknown = opts.allowUnknown ?? false;
  if (allowUnknown) {
    console.warn(
      `[modelResolver] WRILY_ALLOW_UNKNOWN_MODEL set — passing unknown model ` +
        `"${ref}" through unvalidated; it has no cost rates and will be billed at 0.`,
    );
    return ref;
  }
  throw new UnknownModelError(raw, lookup.getAll().map(toSlug));
}
