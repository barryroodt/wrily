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
 * Token-budget defaults by review mode (Decision 3). Applied downstream when
 * `.wrily.yml` `max_tokens` is unset.
 *
 * CALIBRATE before merge: these are placeholders — size against supabase token
 * history. gantry's `--max-tokens` counts `input + output + cache_write` and
 * excludes `cache_read`, so calibrate against exactly that accounting.
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
