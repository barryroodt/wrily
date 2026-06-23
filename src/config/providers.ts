/**
 * Provider → API-key environment variable(s) for the providers Wrily supports.
 *
 * Single source of truth for `config/env.ts`, whose auth gate requires at least
 * one of these to be set. Wrily covers gantry's hosted providers — `anthropic`
 * (`ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` for local OAuth-token
 * auth), `openai`, and `google` (Gemini, authenticated via `GEMINI_API_KEY`) —
 * plus `openrouter`, an OpenAI-wire gateway fronting many vendors behind one key
 * (`OPENROUTER_API_KEY`). The canonical model slug form is `google/<model>`;
 * OpenRouter slugs are vendor-qualified, e.g. `openrouter/anthropic/claude-3.5-sonnet`.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/** Every recognized provider API-key env var name. */
const PROVIDER_API_KEY_ENV_VARS: readonly string[] = Object.values(PROVIDER_API_KEY_ENV).flat();

/**
 * True when at least one env var listed in {@link PROVIDER_API_KEY_ENV} is
 * present and non-empty in `env`. Backs the env auth gate.
 */
export function hasAnyProviderAuth(env: Record<string, string | undefined>): boolean {
  return PROVIDER_API_KEY_ENV_VARS.some((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length > 0;
  });
}
