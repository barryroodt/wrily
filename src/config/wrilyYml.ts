import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WrilyConfig, RuntimeEnv, ReviewMode } from './types.js';
import { isValidSharedSkillName } from '../skills/names.js';

const schema = z.object({
  model: z.string().default('anthropic/claude-opus-4-8'),
  mode: z.enum(['auto', 'single', 'team']).default('auto'),
  team_threshold: z.number().int().positive().default(5),
  team_threshold_unit: z
    .preprocess((v) => {
      if (v === undefined || v === null) return 'files';
      if (v === 'files' || v === 'folders') return v;
      console.warn(
        `WARNING: unrecognized team_threshold_unit='${String(v)}' in .wrily.yml (expected 'files' or 'folders'). Defaulting to files.`,
      );
      return 'files';
    }, z.enum(['files', 'folders']))
    .default('files'),
  max_tokens: z.number().int().positive().nullable().default(null),
  ignore: z.array(z.string()).default([]),
  shared_skills: z.array(
    z.string().refine(isValidSharedSkillName, {
      message: 'shared_skills entries must contain only letters, numbers, underscore, and hyphen',
    }),
  ).default([]),
  request_changes: z.boolean().default(false),
  style: z.enum(['terse', 'verbose']).default('terse'),
  sensitivity: z.enum(['minor', 'important', 'critical']).default('important'),
  reply_feedback: z.enum(['on', 'off']).default('on'),
});

export function parseWrilyYml(yamlContent: string): WrilyConfig {
  const raw = parseYaml(yamlContent) ?? {};
  return schema.parse(raw);
}

/**
 * Per-mode token-budget ceilings (Decision 3). Applied as the `--max-tokens`
 * cap when `.wrily.yml` `max_tokens` is unset. gantry counts
 * `input + output + cache_write` against this and EXCLUDES `cache_read`, so a
 * long agentic review (where cache hits dominate re-reads) bills far less
 * against the cap than its raw context size suggests.
 *
 * These are abort backstops, not targets: a review that never reaches the cap
 * costs nothing extra, while too low a cap truncates a legitimate large review
 * (gantry exits `budget`). Sized above the timeout-bounded worst case — a
 * single `DEFAULT_TIMEOUT_MS` (12-minute) review accrues well under 1M billable
 * tokens, so 2M leaves ~2x headroom; a team review runs 3 specialist lanes +
 * unify in one gantry process (~4x the work) → 8M. Re-tune from persisted
 * `review_runs.max_tokens` / token-usage p99 once history accumulates.
 */
export const DEFAULT_MAX_TOKENS_SINGLE = 2_000_000;
export const DEFAULT_MAX_TOKENS_TEAM = 8_000_000;

export function defaultMaxTokens(mode: ReviewMode): number {
  return mode === 'team' ? DEFAULT_MAX_TOKENS_TEAM : DEFAULT_MAX_TOKENS_SINGLE;
}

/**
 * Layer env-var overrides on top of a parsed `.wrily.yml`.
 *
 * Precedence: env > .wrily.yml > built-in default.
 *
 * - `modeOverride` / `modelOverride` use `||` so an empty-string sentinel falls
 *   through to the cfg value.
 * - `maxTokens` uses `??` so `undefined` (no `MAX_TOKENS`) falls through to the
 *   cfg value; any parsed positive integer wins.
 */
export function applyEnvOverrides(cfg: WrilyConfig, env: RuntimeEnv): WrilyConfig {
  return {
    ...cfg,
    mode: env.modeOverride || cfg.mode,
    model: env.modelOverride || cfg.model,
    max_tokens: env.maxTokens ?? cfg.max_tokens,
    reply_feedback: env.replyFeedbackOverride || cfg.reply_feedback,
  };
}
