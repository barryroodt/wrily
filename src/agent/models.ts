/**
 * Static model manifest.
 *
 * One row per canonical `provider/model` slug that Wrily knows how to run,
 * for the three retained providers (`anthropic`, `openai`, `google`). Each row
 * carries the bare-name aliases that normalize to it and the per-MTok USD cost
 * rates used to compute spend at persistence/reporting time.
 *
 * This manifest is the single source of truth for:
 *   - which slugs `resolveModel` accepts and validates against (no pi
 *     `ModelRegistry` dependency);
 *   - the alias → canonical mapping (the old `ALIASES` map lives here now);
 *   - cost rates (`wrily costs` / persistence multiply token counts by these).
 *
 * Canonical provider slug for Gemini is `google/<model>` (NOT `gemini/`); the
 * Google API key env var stays `GEMINI_API_KEY`.
 *
 * Rates are USD per 1,000,000 tokens. // CALIBRATE before merge — these are
 * best-known public list prices at authoring time; confirm against current
 * provider pricing before the cutover lands (see plan "Open calibrations" #2).
 */

/** Per-MTok USD rates (cost per 1,000,000 tokens). */
export interface ModelRates {
  /** Uncached input (prompt) tokens. */
  readonly input: number;
  /** Output (completion) tokens. */
  readonly output: number;
  /** Cache-read (cache-hit input) tokens. */
  readonly cacheRead: number;
  /** Cache-write (cache-creation input) tokens. */
  readonly cacheWrite: number;
}

/** A single canonical model row in the manifest. */
export interface ModelManifestEntry {
  /** Canonical `provider/model` slug. The one true form used everywhere. */
  readonly slug: string;
  /** Bare-name aliases (case-insensitive) that normalize to {@link slug}. */
  readonly aliases: readonly string[];
  /** Per-MTok USD cost rates. */
  readonly rates: ModelRates;
}

/**
 * The manifest. Default model is `anthropic/claude-opus-4-8` (see
 * `DEFAULT_MODEL_SLUG` in `modelResolver.ts`).
 *
 * // CALIBRATE before merge: rate values below are best-known public list
 * prices and MUST be reconciled against current provider pricing.
 */
export const MODEL_MANIFEST: readonly ModelManifestEntry[] = [
  {
    slug: 'anthropic/claude-opus-4-8',
    aliases: ['opus'],
    // Anthropic Claude Opus 4.x list pricing.
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    slug: 'anthropic/claude-sonnet-4-6',
    aliases: ['sonnet'],
    // Anthropic Claude Sonnet 4.x list pricing.
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    slug: 'anthropic/claude-haiku-4-5',
    aliases: ['haiku'],
    // Anthropic Claude Haiku 4.x list pricing.
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  {
    slug: 'openai/gpt-4o',
    aliases: [],
    // OpenAI GPT-4o list pricing. No cache-write surcharge; cached input is
    // billed at the cacheRead rate.
    rates: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  },
  {
    slug: 'google/gemini-2.5-pro',
    aliases: ['gemini'],
    // Google Gemini 2.5 Pro list pricing (<=200k-token prompt tier). Google
    // bills cache storage per hour rather than a per-token write; cacheWrite
    // is approximated at the input rate here.
    rates: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
  },
];

/** slug → entry. Built once at module load. */
const BY_SLUG: Readonly<Record<string, ModelManifestEntry>> = Object.fromEntries(
  MODEL_MANIFEST.map((e) => [e.slug, e]),
);

/** lowercased alias → entry. Built once at module load. */
const BY_ALIAS: Readonly<Record<string, ModelManifestEntry>> = Object.fromEntries(
  MODEL_MANIFEST.flatMap((e) => e.aliases.map((a) => [a.toLowerCase(), e] as const)),
);

/** Look up a manifest row by exact canonical slug. */
export function modelBySlug(slug: string): ModelManifestEntry | undefined {
  return BY_SLUG[slug];
}

/** Look up a manifest row by bare alias (case-insensitive). */
export function modelByAlias(alias: string): ModelManifestEntry | undefined {
  return BY_ALIAS[alias.toLowerCase()];
}

/**
 * Per-MTok cost rates for a canonical slug, or `undefined` when the slug is not
 * in the manifest (e.g. an unknown model admitted via
 * `WRILY_ALLOW_UNKNOWN_MODEL`). Callers treat absent rates as zero cost.
 */
export function ratesForSlug(slug: string): ModelRates | undefined {
  return BY_SLUG[slug]?.rates;
}
