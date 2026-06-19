import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveModel,
  UnknownModelError,
  DEFAULT_MODEL_SLUG,
  MANIFEST_LOOKUP,
  type ModelLookup,
} from '../../src/agent/modelResolver.js';
import {
  MODEL_MANIFEST,
  modelBySlug,
  ratesForSlug,
} from '../../src/agent/models.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WRILY_ALLOW_UNKNOWN_MODEL;
});

describe('resolveModel (manifest-backed)', () => {
  it('normalizes the bare family aliases to canonical slugs', () => {
    expect(resolveModel('opus')).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('sonnet')).toBe('anthropic/claude-sonnet-4-6');
    expect(resolveModel('haiku')).toBe('anthropic/claude-haiku-4-5');
    expect(resolveModel('gemini')).toBe('google/gemini-2.5-pro');
  });

  it('treats aliases case-insensitively', () => {
    expect(resolveModel('OPUS')).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('Sonnet')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('passes a valid provider/model slug through unchanged', () => {
    expect(resolveModel('openai/gpt-4o')).toBe('openai/gpt-4o');
    expect(resolveModel('anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
  });

  it('falls back to the default slug for empty/null/undefined/whitespace', () => {
    expect(resolveModel('')).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel('   ')).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel(null)).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL_SLUG);
    expect(DEFAULT_MODEL_SLUG).toBe('anthropic/claude-opus-4-8');
  });

  it('resolves an unambiguous bare id to its slug', () => {
    expect(resolveModel('gpt-4o')).toBe('openai/gpt-4o');
  });

  it('throws on an unknown slug and an unknown bare id (no escape hatch)', () => {
    expect(() => resolveModel('anthropic/does-not-exist')).toThrow(UnknownModelError);
    expect(() => resolveModel('mystery-model-9000')).toThrow(UnknownModelError);
  });

  it('always returns a provider/model slug', () => {
    for (const ref of ['opus', 'sonnet', 'haiku', 'gemini', 'openai/gpt-4o', 'gpt-4o', '']) {
      expect(resolveModel(ref)).toMatch(/^[^/]+\/.+$/);
    }
  });

  it('UnknownModelError carries the reference and the available list', () => {
    try {
      resolveModel('nope/nope');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelError);
      const e = err as UnknownModelError;
      expect(e.reference).toBe('nope/nope');
      expect(e.available).toContain('openai/gpt-4o');
      expect(e.message).toMatch(/provider\/model slug/);
    }
  });
});

// Ambiguity is a real branch but the shipped manifest has no bare id shared
// across providers, so exercise it with a tiny fake lookup.
describe('resolveModel ambiguity', () => {
  const FAKE: ModelLookup = {
    resolveAlias: () => undefined,
    find: (p, id) =>
      [
        { provider: 'openai', id: 'shared-id' },
        { provider: 'anthropic', id: 'shared-id' },
      ].find((m) => m.provider === p && m.id === id),
    getAll: () => [
      { provider: 'openai', id: 'shared-id' },
      { provider: 'anthropic', id: 'shared-id' },
    ],
  };

  it('rejects an ambiguous bare id shared across providers', () => {
    expect(() => resolveModel('shared-id', FAKE)).toThrow(UnknownModelError);
  });

  it('resolves the same id once disambiguated by provider', () => {
    expect(resolveModel('openai/shared-id', FAKE)).toBe('openai/shared-id');
  });
});

describe('WRILY_ALLOW_UNKNOWN_MODEL escape hatch', () => {
  it('passes an unknown slug through unchanged and warns (param)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveModel('acme/experimental-7', MANIFEST_LOOKUP, { allowUnknown: true })).toBe(
      'acme/experimental-7',
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/WRILY_ALLOW_UNKNOWN_MODEL/);
  });

  it('ignores process.env (the resolver never reads it post-cutover)', () => {
    process.env.WRILY_ALLOW_UNKNOWN_MODEL = '1';
    expect(() => resolveModel('acme/experimental-7')).toThrow(UnknownModelError);
    delete process.env.WRILY_ALLOW_UNKNOWN_MODEL;
  });

  it('an explicit allowUnknown:false throws even if the env var is set', () => {
    process.env.WRILY_ALLOW_UNKNOWN_MODEL = '1';
    expect(() =>
      resolveModel('acme/experimental-7', MANIFEST_LOOKUP, { allowUnknown: false }),
    ).toThrow(UnknownModelError);
    delete process.env.WRILY_ALLOW_UNKNOWN_MODEL;
  });
});

describe('models.ts manifest', () => {
  it('returns per-MTok rates for a known slug', () => {
    const rates = ratesForSlug(DEFAULT_MODEL_SLUG);
    expect(rates).toBeDefined();
    expect(rates!.input).toBeGreaterThan(0);
    expect(rates!.output).toBeGreaterThan(0);
    expect(rates).toMatchObject({
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    });
  });

  it('has no rates for an unknown slug', () => {
    expect(ratesForSlug('acme/experimental-7')).toBeUndefined();
  });

  it('the default slug is present in the manifest', () => {
    expect(modelBySlug(DEFAULT_MODEL_SLUG)).toBeDefined();
  });

  it('every alias target is itself a canonical slug in the manifest', () => {
    for (const entry of MODEL_MANIFEST) {
      expect(modelBySlug(entry.slug)).toBe(entry);
      for (const alias of entry.aliases) {
        expect(resolveModel(alias)).toBe(entry.slug);
      }
    }
  });

  it('only retains the three supported providers', () => {
    const providers = new Set(MODEL_MANIFEST.map((e) => e.slug.split('/')[0]));
    expect([...providers].sort()).toEqual(['anthropic', 'google', 'openai']);
  });
});
