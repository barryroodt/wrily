import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WrilyConfig, RuntimeEnv } from './types.js';
import { isValidSharedSkillName } from '../skills/names.js';

const schema = z.object({
  model: z.string().default('opus'),
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
  max_budget_usd: z.number().positive().nullable().default(null),
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
 * Layer env-var overrides on top of a parsed `.wrily.yml`.
 *
 * Precedence: env > .wrily.yml > built-in default.
 *
 * - `modeOverride` / `modelOverride` use `||` so an empty-string sentinel falls
 *   through to the cfg value.
 * - `maxBudgetOverride` uses `??` because `0` is a (degenerate but) valid
 *   non-null budget that must not be treated as falsy.
 */
export function applyEnvOverrides(cfg: WrilyConfig, env: RuntimeEnv): WrilyConfig {
  return {
    ...cfg,
    mode: env.modeOverride || cfg.mode,
    model: env.modelOverride || cfg.model,
    max_budget_usd: env.maxBudgetOverride ?? cfg.max_budget_usd,
    reply_feedback: env.replyFeedbackOverride || cfg.reply_feedback,
  };
}
