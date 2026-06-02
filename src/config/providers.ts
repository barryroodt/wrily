/**
 * Provider → API-key environment variable(s) for the providers Wrily supports
 * out of the box.
 *
 * Single source of truth shared by:
 * - {@link file://./../agent/pi.ts PiRunner}, which sets these as pi runtime keys
 *   from the injected run env (honoring `AgentRunOptions.env`); and
 * - `config/env.ts`, whose auth gate requires at least one of these to be set.
 *
 * Provider ids and env var names mirror pi-ai's built-in env map
 * (`packages/ai/src/env-api-keys.ts`) for the supported subset. pi also reads
 * these from `process.env` on its own, so this list governs Wrily's explicit
 * support surface and validation, not pi's full provider matrix.
 *
 * Amazon Bedrock is intentionally absent: it authenticates via ambient AWS
 * credentials (profile / IAM / `AWS_*`), not a single API-key env var.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
};

/** Every recognized provider API-key env var name, deduplicated. */
export const PROVIDER_API_KEY_ENV_VARS: readonly string[] = [
  ...new Set(Object.values(PROVIDER_API_KEY_ENV).flat()),
];

/**
 * True when at least one recognized provider API-key env var is present and
 * non-empty in `env`. Bedrock-only (ambient AWS) auth is not detectable here.
 */
export function hasAnyProviderKey(env: Record<string, string | undefined>): boolean {
  return PROVIDER_API_KEY_ENV_VARS.some((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length > 0;
  });
}
