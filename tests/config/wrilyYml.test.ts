import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWrilyYml, applyEnvOverrides } from '../../src/config/wrilyYml.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';

const read = (name: string) => readFileSync(`tests/fixtures/wrily-yml/${name}.yml`, 'utf8');

describe('parseWrilyYml', () => {
  it('applies defaults to a minimal/empty config', () => {
    const cfg = parseWrilyYml(read('minimal'));
    expect(cfg.model).toBe('opus');
    expect(cfg.mode).toBe('auto');
    expect(cfg.team_threshold).toBe(5);
    expect(cfg.team_threshold_unit).toBe('files');
    expect(cfg.max_budget_usd).toBeNull();
    expect(cfg.ignore).toEqual([]);
    expect(cfg.shared_skills).toEqual([]);
    expect(cfg.request_changes).toBe(false);
    expect(cfg.style).toBe('terse');
    expect(cfg.sensitivity).toBe('important');
    expect(cfg.reply_feedback).toBe('on');
  });

  it('parses a fully-populated config', () => {
    const cfg = parseWrilyYml(read('full'));
    expect(cfg.model).toBe('opus');
    expect(cfg.mode).toBe('team');
    expect(cfg.team_threshold).toBe(3);
    expect(cfg.team_threshold_unit).toBe('folders');
    expect(cfg.max_budget_usd).toBe(15);
    expect(cfg.ignore).toEqual(['*.lock', 'vendor/**']);
    expect(cfg.shared_skills).toEqual(['rust-pro']);
    expect(cfg.style).toBe('verbose');
    expect(cfg.sensitivity).toBe('critical');
    expect(cfg.reply_feedback).toBe('on');
  });

  it('throws on an invalid mode value', () => {
    expect(() => parseWrilyYml(read('invalid'))).toThrow(/mode/);
  });

  it('throws on shared skill names that can escape the skills directory', () => {
    expect(() => parseWrilyYml('shared_skills: [".."]')).toThrow(/shared_skills/);
    expect(() => parseWrilyYml('shared_skills: ["nested/path"]')).toThrow(/shared_skills/);
  });

  it('handles missing file content (empty string)', () => {
    const cfg = parseWrilyYml('');
    expect(cfg.mode).toBe('auto');
  });

  it('warns and falls back to "files" when team_threshold_unit is unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseWrilyYml(read('unknown-unit'));
    expect(cfg.team_threshold_unit).toBe('files');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/team_threshold_unit/));
    warn.mockRestore();
  });
});

describe('applyEnvOverrides', () => {
  const baseCfg: WrilyConfig = {
    model: 'opus',
    mode: 'auto',
    team_threshold: 5,
    team_threshold_unit: 'files',
    max_budget_usd: 10,
    ignore: [],
    shared_skills: [],
    request_changes: false,
    style: 'terse',
    sensitivity: 'important',
    reply_feedback: 'on',
  };

  const baseEnv = (over: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
    authMethod: 'oauth',
    anthropicApiKey: null,
    claudeCodeOauthToken: 'sk-ant-oat01-xxx',
    githubToken: 'gho_xxx',
    prNumber: 1,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'abc1234',
    sharedRepo: 'your-org/shared-wrily-skills',
    sharedToken: '',
    wrilyBotLogin: 'wrily',
    reviewRoundIndex: 0,
    scopeOverride: '',
    modeOverride: '', replyFeedbackOverride: '',
    modelOverride: '',
    maxBudgetOverride: null,
    dryRun: false,
    prAuthorLogin: '',
    triggerSource: 'push',
    actor: '',
    ...over,
  });

  it('returns cfg unchanged when all env overrides are empty/null', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv());
    expect(result.mode).toBe('auto');
    expect(result.model).toBe('opus');
    expect(result.max_budget_usd).toBe(10);
  });

  it('mode override flips cfg.mode (auto → team)', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ modeOverride: 'team' }));
    expect(result.mode).toBe('team');
  });

  it('model override flips cfg.model', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ modelOverride: 'sonnet' }));
    expect(result.model).toBe('sonnet');
  });

  it('honors maxBudgetOverride: 0 (not treated as falsy)', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ maxBudgetOverride: 0 }));
    expect(result.max_budget_usd).toBe(0);
  });

  it('maxBudgetOverride null keeps cfg.max_budget_usd', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ maxBudgetOverride: null }));
    expect(result.max_budget_usd).toBe(10);
  });

  it('maxBudgetOverride positive overrides cfg.max_budget_usd', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ maxBudgetOverride: 42.5 }));
    expect(result.max_budget_usd).toBe(42.5);
  });

  it('preserves unrelated cfg fields', () => {
    const result = applyEnvOverrides(baseCfg, baseEnv({ modeOverride: 'team' }));
    expect(result.team_threshold).toBe(5);
    expect(result.style).toBe('terse');
    expect(result.sensitivity).toBe('important');
    expect(result.reply_feedback).toBe('on');
  });
});
