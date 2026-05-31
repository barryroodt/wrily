/**
 * USD cost computation for agent runs.
 *
 * Per the rig-harness spec, the Rust sidecar is provider-pricing-agnostic — it
 * emits only raw token counts. Pricing lives here on the TypeScript side so the
 * binary never needs a price table. `computeCostUsd` maps a model name to a
 * per-million-token price and returns the run's USD cost.
 */

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read tokens (defaults to inputPer1M when omitted). */
  cacheReadPer1M?: number;
  /** USD per 1M cache-write tokens (defaults to inputPer1M when omitted). */
  cacheWritePer1M?: number;
};

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/**
 * Longest-prefix-wins price table. Ordering matters: more specific prefixes
 * (e.g. `claude-3-5-haiku`) must precede broader ones (`claude-haiku`).
 */
const PRICE_TABLE: ReadonlyArray<readonly [string, ModelPrice]> = [
  // Anthropic — cache write ≈ 1.25× input, cache read ≈ 0.1× input.
  ['claude-3-5-haiku', { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 }],
  ['claude-haiku', { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 }],
  ['claude-3-5-sonnet', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-sonnet', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-opus', { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 }],
  // OpenAI.
  ['gpt-4o-mini', { inputPer1M: 0.15, outputPer1M: 0.6 }],
  ['gpt-4o', { inputPer1M: 2.5, outputPer1M: 10 }],
  ['gpt-5', { inputPer1M: 1.25, outputPer1M: 10 }],
  ['o3', { inputPer1M: 2, outputPer1M: 8 }],
  ['o1', { inputPer1M: 15, outputPer1M: 60 }],
  // Gemini.
  ['gemini-2', { inputPer1M: 0.15, outputPer1M: 0.6 }],
  ['gemini-1.5', { inputPer1M: 0.075, outputPer1M: 0.3 }],
  // Cursor Composer.
  ['composer-2.5', { inputPer1M: 0.5, outputPer1M: 2 }],
  ['cursor-composer-2.5', { inputPer1M: 0.5, outputPer1M: 2 }],
];

/** Look up the price entry for a model name (longest matching prefix). */
export function priceForModel(model: string): ModelPrice | undefined {
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [prefix, price] of PRICE_TABLE) {
    if (model.startsWith(prefix) && (best === undefined || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best?.price;
}

/**
 * Compute the USD cost of a run. Returns `undefined` for an unknown model so the
 * caller can distinguish "no price table entry" from "$0.00".
 */
export function computeCostUsd(model: string, tokens: TokenCounts): number | undefined {
  const price = priceForModel(model);
  if (!price) return undefined;

  const cacheReadRate = price.cacheReadPer1M ?? price.inputPer1M;
  const cacheWriteRate = price.cacheWritePer1M ?? price.inputPer1M;

  const input = (tokens.inputTokens / 1_000_000) * price.inputPer1M;
  const output = (tokens.outputTokens / 1_000_000) * price.outputPer1M;
  const cacheRead = ((tokens.cacheReadTokens ?? 0) / 1_000_000) * cacheReadRate;
  const cacheWrite = ((tokens.cacheWriteTokens ?? 0) / 1_000_000) * cacheWriteRate;

  return input + output + cacheRead + cacheWrite;
}
