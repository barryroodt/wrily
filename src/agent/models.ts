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
 * Rates are USD per 1,000,000 tokens, verified 2026-06-17 against published
 * provider list pricing (Anthropic / OpenAI / Google). Cache rates follow the
 * Anthropic convention: cacheRead = 0.1x input, cacheWrite = 1.25x input
 * (5-minute TTL). Re-verify when a model's tier pricing changes.
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
 * Rate values below were reconciled against current provider list pricing on
 * 2026-06-17.
 */
export const MODEL_MANIFEST: readonly ModelManifestEntry[] = [
  {
    slug: 'anthropic/claude-opus-4-8',
    aliases: ['opus'],
    // Anthropic Claude Opus 4.8 list pricing (verified 2026-06-17): $5/$25 per
    // MTok; cacheRead 0.1x, cacheWrite 1.25x (5-min) input.
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    slug: 'anthropic/claude-sonnet-4-6',
    aliases: ['sonnet'],
    // Anthropic Claude Sonnet 4.6 list pricing (verified 2026-06-17): $3/$15 per MTok.
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    slug: 'anthropic/claude-haiku-4-5',
    aliases: ['haiku'],
    // Anthropic Claude Haiku 4.5 list pricing (verified 2026-06-17): $1/$5 per MTok.
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

/**
 * Providers whose model catalog is open and dynamic rather than enumerated in
 * the static manifest above. OpenRouter is an OpenAI-wire gateway fronting
 * thousands of vendor models behind one key; its ids are vendor-qualified
 * (`openrouter/anthropic/claude-3.5-sonnet`, `openrouter/<vendor>/<model>:free`)
 * and change constantly, so wrily accepts any well-formed slug for these
 * providers and lets gantry/the gateway validate it. They carry no manifest
 * rates, so usage bills at 0 (correct for `:free` models; paid OpenRouter usage
 * is not cost-tracked — see `ratesForSlug`).
 */
export const OPEN_CATALOG_PROVIDERS: ReadonlySet<string> = new Set(['openrouter']);

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

/** A token vector to be costed. Counts are raw token totals, not per-MTok. */
export interface TokenVector {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * USD cost for a token vector at the given per-MTok rates. Returns 0 when
 * `rates` is absent (e.g. an unknown model admitted via
 * `WRILY_ALLOW_UNKNOWN_MODEL` has no manifest rates). Single source of truth
 * for the `tokens × rate / 1e6` formula — reused by the gantry runner and the
 * persistence (usage reconciliation) path.
 */
export function costForTokens(rates: ModelRates | undefined, vec: TokenVector): number {
  if (!rates) return 0;
  return (
    vec.input * rates.input +
    vec.output * rates.output +
    vec.cacheRead * rates.cacheRead +
    vec.cacheWrite * rates.cacheWrite
  ) / 1_000_000;
}
