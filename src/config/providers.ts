/**
 * Provider → API-key environment variable(s) for the providers Wrily supports.
 *
 * Single source of truth for `config/env.ts`, whose auth gate requires at least
 * one of these to be set. Wrily narrows to gantry's three supported providers:
 * `anthropic`, `openai`, and `google` (Gemini, authenticated via
 * `GEMINI_API_KEY`). The canonical model slug form is `google/<model>`.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
};

/** Every recognized provider API-key env var name. */
const PROVIDER_API_KEY_ENV_VARS: readonly string[] = Object.values(PROVIDER_API_KEY_ENV).flat();

/**
 * True when at least one recognized provider API-key env var — one of
 * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` — is present and
 * non-empty in `env`. Backs the env auth gate.
 */
export function hasAnyProviderAuth(env: Record<string, string | undefined>): boolean {
  return PROVIDER_API_KEY_ENV_VARS.some((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length > 0;
  });
}
