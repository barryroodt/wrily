import { z } from 'zod';
import type { RuntimeEnv } from './types.js';
import { hasAnyProviderAuth } from './providers.js';

const rawEnvSchema = z.object({
  // Allow empty string (common in .env files) — parseEnv() checks that at
  // least one auth source is non-empty after parsing.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  PR_NUMBER: z.string().regex(/^[1-9]\d*$/, 'PR_NUMBER must be a positive integer'),
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/, 'GITHUB_REPOSITORY must be "owner/repo"'),
  BASE_BRANCH: z.string().min(1),
  COMMIT_SHA: z.string().min(1),
  SHARED_REPO: z.string().optional().default(''),
  SHARED_TOKEN: z.string().optional().default(''),
  WRILY_BOT_LOGIN: z.string().default('wrily'),
  REVIEW_ROUND_INDEX: z.string().regex(/^\d+$/).default('0'),
  SCOPE_OVERRIDE: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || v === 'full' || v === 'delta', {
      message: "SCOPE_OVERRIDE must be one of '', 'full', or 'delta'",
    }),
  MODE: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || v === 'auto' || v === 'single' || v === 'team', {
      message: "MODE must be one of '', 'auto', 'single', or 'team'",
    }),
  MODEL: z.string().optional().default(''),
  MAX_TOKENS: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || /^[1-9]\d*$/.test(v), {
      message: 'MAX_TOKENS must be empty or a positive integer',
    }),
  WRILY_GANTRY_BIN: z.string().optional(),
  WRILY_ALLOW_UNKNOWN_MODEL: z.string().optional().default(''),
  DRY_RUN: z.enum(['true', 'false']).default('false'),
  PR_AUTHOR_LOGIN: z.string().default(''),
  WRILY_TRIGGER_SOURCE: z.string().default('push'),
  GITHUB_ACTOR: z.string().default(''),
  REPLY_FEEDBACK: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || v === 'on' || v === 'off', {
      message: "REPLY_FEEDBACK must be one of '', 'on', or 'off'",
    }),
  SUPABASE_URL: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || /^https?:\/\/.+/.test(v), {
      message: 'SUPABASE_URL must be a valid URL',
    }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
});

export function parseEnv(raw: Record<string, string | undefined>): RuntimeEnv {
  const parsed = rawEnvSchema.parse(raw);

  if (!hasAnyProviderAuth(raw)) {
    throw new Error(
      'No provider API key configured. Set one of ANTHROPIC_API_KEY, ' +
        'CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.',
    );
  }

  const supabaseUrl = parsed.SUPABASE_URL;
  const supabaseKey = parsed.SUPABASE_SERVICE_ROLE_KEY;
  if (!!supabaseUrl !== !!supabaseKey) {
    throw new Error(
      supabaseUrl
        ? 'SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is missing. Set both or neither.'
        : 'SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is missing. Set both or neither.',
    );
  }
  const supabase = supabaseUrl && supabaseKey
    ? { url: supabaseUrl, serviceRoleKey: supabaseKey }
    : null;

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    openaiApiKey: parsed.OPENAI_API_KEY ?? null,
    geminiApiKey: parsed.GEMINI_API_KEY ?? null,
    openrouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    githubToken: parsed.GITHUB_TOKEN,
    prNumber: Number.parseInt(parsed.PR_NUMBER, 10),
    githubRepository: parsed.GITHUB_REPOSITORY,
    baseBranch: parsed.BASE_BRANCH,
    commitSha: parsed.COMMIT_SHA,
    sharedRepo: parsed.SHARED_REPO,
    sharedToken: parsed.SHARED_TOKEN,
    wrilyBotLogin: parsed.WRILY_BOT_LOGIN,
    reviewRoundIndex: Number.parseInt(parsed.REVIEW_ROUND_INDEX, 10),
    scopeOverride: parsed.SCOPE_OVERRIDE as 'full' | 'delta' | '',
    modeOverride: parsed.MODE as '' | 'auto' | 'single' | 'team',
    modelOverride: parsed.MODEL,
    maxTokens: parsed.MAX_TOKENS ? Number.parseInt(parsed.MAX_TOKENS, 10) : undefined,
    wrilyGantryBin: parsed.WRILY_GANTRY_BIN || undefined,
    allowUnknownModel:
      parsed.WRILY_ALLOW_UNKNOWN_MODEL === '1' || parsed.WRILY_ALLOW_UNKNOWN_MODEL === 'true',
    dryRun: parsed.DRY_RUN === 'true',
    prAuthorLogin: parsed.PR_AUTHOR_LOGIN,
    triggerSource: parsed.WRILY_TRIGGER_SOURCE,
    actor: parsed.GITHUB_ACTOR,
    replyFeedbackOverride: parsed.REPLY_FEEDBACK as '' | 'on' | 'off',
    supabase,
  };
}
