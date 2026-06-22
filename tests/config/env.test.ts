import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

describe('parseEnv', () => {
  const minimal = {
    GITHUB_TOKEN: 'gho_xxx',
    PR_NUMBER: '42',
    GITHUB_REPOSITORY: 'org/repo',
    BASE_BRANCH: 'main',
    COMMIT_SHA: 'abc1234',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
  };

  it('parses minimal valid env with an Anthropic API key', () => {
    const env = parseEnv(minimal);
    expect(env.anthropicApiKey).toBe('sk-ant-xxx');
    expect(env.prNumber).toBe(42);
    expect(env.dryRun).toBe(false);
    expect(env.sharedRepo).toBe('');
    expect(env.wrilyBotLogin).toBe('wrily');
    expect(env.reviewRoundIndex).toBe(0);
  });

  it('respects REVIEW_ROUND_INDEX override', () => {
    const env = parseEnv({ ...minimal, REVIEW_ROUND_INDEX: '3' });
    expect(env.reviewRoundIndex).toBe(3);
  });

  it('respects WRILY_BOT_LOGIN override', () => {
    const env = parseEnv({ ...minimal, WRILY_BOT_LOGIN: 'custom-bot' });
    expect(env.wrilyBotLogin).toBe('custom-bot');
  });

  it('accepts any retained provider key as the sole auth source', () => {
    for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) {
      const env = parseEnv({ ...minimal, ANTHROPIC_API_KEY: undefined, [key]: 'k-value' });
      expect(env.anthropicApiKey).toBeNull();
      expect(env.prNumber).toBe(42);
    }
  });

  it('accepts CLAUDE_CODE_OAUTH_TOKEN as the sole anthropic auth source', () => {
    expect(() =>
      parseEnv({ ...minimal, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok' }),
    ).not.toThrow();
  });

  it('exposes retained provider keys and nulls absent ones', () => {
    const env = parseEnv({ ...minimal, OPENAI_API_KEY: 'sk-openai' });
    expect(env.anthropicApiKey).toBe('sk-ant-xxx');
    expect(env.openaiApiKey).toBe('sk-openai');
    expect(env.geminiApiKey).toBeNull();
  });

  it('mirrors OPENROUTER_API_KEY and accepts it as the sole auth source', () => {
    const env = parseEnv({ ...minimal, ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: 'sk-or-xxx' });
    expect(env.openrouterApiKey).toBe('sk-or-xxx');
    expect(env.anthropicApiKey).toBeNull();
  });

  it('throws when no recognized provider key is configured, listing the known keys', () => {
    expect(() => parseEnv({ ...minimal, ANTHROPIC_API_KEY: undefined })).toThrow(/provider API key/i);
    // Message is derived from PROVIDER_API_KEY_ENV_VARS — guard against re-hardcoding.
    expect(() => parseEnv({ ...minimal, ANTHROPIC_API_KEY: undefined })).toThrow(/OPENROUTER_API_KEY/);
  });

  it('throws when GITHUB_TOKEN is missing', () => {
    expect(() => parseEnv({ ...minimal, GITHUB_TOKEN: undefined })).toThrow(/GITHUB_TOKEN/);
  });

  it('coerces PR_NUMBER to number', () => {
    const env = parseEnv({ ...minimal, PR_NUMBER: '123' });
    expect(env.prNumber).toBe(123);
    expect(typeof env.prNumber).toBe('number');
  });

  it('respects DRY_RUN=true', () => {
    expect(parseEnv({ ...minimal, DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(parseEnv({ ...minimal, DRY_RUN: 'false' }).dryRun).toBe(false);
    expect(parseEnv({ ...minimal, DRY_RUN: undefined }).dryRun).toBe(false);
  });

  it('respects SHARED_REPO override', () => {
    const env = parseEnv({ ...minimal, SHARED_REPO: 'custom/shared' });
    expect(env.sharedRepo).toBe('custom/shared');
  });

  it('defaults sharedToken to "" and reads SHARED_TOKEN when provided', () => {
    const defaulted = parseEnv(minimal);
    expect(defaulted.sharedToken).toBe('');

    const populated = parseEnv({ ...minimal, SHARED_TOKEN: 'gho_shared_xxx' });
    expect(populated.sharedToken).toBe('gho_shared_xxx');
  });

  it('throws when DRY_RUN has an invalid value', () => {
    expect(() => parseEnv({ ...minimal, DRY_RUN: 'TRUE' })).toThrow(/DRY_RUN/);
    expect(() => parseEnv({ ...minimal, DRY_RUN: '1' })).toThrow(/DRY_RUN/);
  });

  it('reads SCOPE_OVERRIDE: defaults to "", accepts full/delta, rejects unknown', () => {
    expect(parseEnv(minimal).scopeOverride).toBe('');
    expect(parseEnv({ ...minimal, SCOPE_OVERRIDE: '' }).scopeOverride).toBe('');
    expect(parseEnv({ ...minimal, SCOPE_OVERRIDE: 'full' }).scopeOverride).toBe('full');
    expect(parseEnv({ ...minimal, SCOPE_OVERRIDE: 'delta' }).scopeOverride).toBe('delta');
    expect(() => parseEnv({ ...minimal, SCOPE_OVERRIDE: 'partial' })).toThrow(/SCOPE_OVERRIDE/);
  });

  it('reads MODE: defaults to "", accepts auto/single/team, rejects unknown', () => {
    expect(parseEnv(minimal).modeOverride).toBe('');
    expect(parseEnv({ ...minimal, MODE: '' }).modeOverride).toBe('');
    expect(parseEnv({ ...minimal, MODE: 'auto' }).modeOverride).toBe('auto');
    expect(parseEnv({ ...minimal, MODE: 'single' }).modeOverride).toBe('single');
    expect(parseEnv({ ...minimal, MODE: 'team' }).modeOverride).toBe('team');
    expect(() => parseEnv({ ...minimal, MODE: 'bogus' })).toThrow(/MODE/);
  });

  it('reads MODEL: defaults to "" and passes through arbitrary model identifiers', () => {
    expect(parseEnv(minimal).modelOverride).toBe('');
    expect(parseEnv({ ...minimal, MODEL: 'sonnet' }).modelOverride).toBe('sonnet');
    expect(parseEnv({ ...minimal, MODEL: 'claude-opus-4-5-20250929' }).modelOverride).toBe(
      'claude-opus-4-5-20250929',
    );
  });

  it('reads MAX_TOKENS: defaults to undefined, parses positive integers, rejects zero/negatives/non-integers', () => {
    expect(parseEnv(minimal).maxTokens).toBeUndefined();
    expect(parseEnv({ ...minimal, MAX_TOKENS: '' }).maxTokens).toBeUndefined();
    expect(parseEnv({ ...minimal, MAX_TOKENS: '200000' }).maxTokens).toBe(200000);
    expect(parseEnv({ ...minimal, MAX_TOKENS: '1' }).maxTokens).toBe(1);
    expect(() => parseEnv({ ...minimal, MAX_TOKENS: '0' })).toThrow(/MAX_TOKENS/);
    expect(() => parseEnv({ ...minimal, MAX_TOKENS: '-5' })).toThrow(/MAX_TOKENS/);
    expect(() => parseEnv({ ...minimal, MAX_TOKENS: '12.5' })).toThrow(/MAX_TOKENS/);
    expect(() => parseEnv({ ...minimal, MAX_TOKENS: 'abc' })).toThrow(/MAX_TOKENS/);
  });

  it('reads WRILY_GANTRY_BIN: defaults to undefined and surfaces the path when set', () => {
    expect(parseEnv(minimal).wrilyGantryBin).toBeUndefined();
    expect(parseEnv({ ...minimal, WRILY_GANTRY_BIN: '' }).wrilyGantryBin).toBeUndefined();
    expect(parseEnv({ ...minimal, WRILY_GANTRY_BIN: '/usr/local/bin/gantry' }).wrilyGantryBin).toBe(
      '/usr/local/bin/gantry',
    );
  });

  it('reads WRILY_ALLOW_UNKNOWN_MODEL: defaults to false, true for "1" or "true"', () => {
    expect(parseEnv(minimal).allowUnknownModel).toBe(false);
    expect(parseEnv({ ...minimal, WRILY_ALLOW_UNKNOWN_MODEL: '1' }).allowUnknownModel).toBe(true);
    expect(parseEnv({ ...minimal, WRILY_ALLOW_UNKNOWN_MODEL: '0' }).allowUnknownModel).toBe(false);
    expect(parseEnv({ ...minimal, WRILY_ALLOW_UNKNOWN_MODEL: 'true' }).allowUnknownModel).toBe(true);
  });

  it('populates prAuthorLogin/triggerSource/actor when present and defaults when absent', () => {
    const populated = parseEnv({
      ...minimal,
      PR_AUTHOR_LOGIN: 'alice',
      WRILY_TRIGGER_SOURCE: 'manual',
      GITHUB_ACTOR: 'bob',
    });
    expect(populated.prAuthorLogin).toBe('alice');
    expect(populated.triggerSource).toBe('manual');
    expect(populated.actor).toBe('bob');

    const defaulted = parseEnv(minimal);
    expect(defaulted.prAuthorLogin).toBe('');
    expect(defaulted.triggerSource).toBe('push');
    expect(defaulted.actor).toBe('');
  });

  it('reads REPLY_FEEDBACK: defaults to "", accepts on/off, rejects unknown', () => {
    expect(parseEnv({ ...minimal, REPLY_FEEDBACK: 'on' }).replyFeedbackOverride).toBe('on');
    expect(parseEnv({ ...minimal, REPLY_FEEDBACK: 'off' }).replyFeedbackOverride).toBe('off');
    expect(parseEnv(minimal).replyFeedbackOverride).toBe('');
    expect(() => parseEnv({ ...minimal, REPLY_FEEDBACK: 'maybe' })).toThrow();
  });

  describe('supabase env', () => {
    it('returns env.supabase = null when both vars absent', () => {
      const env = parseEnv(minimal);
      expect(env.supabase).toBeNull();
    });

    it('returns env.supabase populated when both vars set', () => {
      const env = parseEnv({
        ...minimal,
        SUPABASE_URL: 'https://abc.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service-role.key',
      });
      expect(env.supabase).toEqual({
        url: 'https://abc.supabase.co',
        serviceRoleKey: 'eyJ.service-role.key',
      });
    });

    it('throws when only SUPABASE_URL is set', () => {
      expect(() =>
        parseEnv({ ...minimal, SUPABASE_URL: 'https://abc.supabase.co' }),
      ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    });

    it('throws when only SUPABASE_SERVICE_ROLE_KEY is set', () => {
      expect(() =>
        parseEnv({ ...minimal, SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key' }),
      ).toThrow(/SUPABASE_URL/);
    });

    it('rejects malformed SUPABASE_URL', () => {
      expect(() =>
        parseEnv({
          ...minimal,
          SUPABASE_URL: 'not-a-url',
          SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key',
        }),
      ).toThrow();
    });
  });
});
