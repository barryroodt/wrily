import { describe, it, expect } from 'vitest';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  resolveModel,
  UnknownModelError,
  DEFAULT_MODEL_SLUG,
  type ModelLookup,
  type ModelRef,
} from '../../src/agent/modelResolver.js';

const FAKE_MODELS: ModelRef[] = [
  { provider: 'anthropic', id: 'claude-opus-4-8' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  { provider: 'anthropic', id: 'claude-haiku-4-5' },
  { provider: 'openai', id: 'gpt-4o' },
  // Same bare id under two providers → ambiguous when referenced without a provider.
  { provider: 'openai', id: 'shared-id' },
  { provider: 'anthropic', id: 'shared-id' },
];

const lookup: ModelLookup = {
  find: (p, id) => FAKE_MODELS.find((m) => m.provider === p && m.id === id),
  getAll: () => FAKE_MODELS,
};

describe('resolveModel', () => {
  it('normalizes the bare family aliases to canonical slugs', () => {
    expect(resolveModel('opus', lookup)).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('sonnet', lookup)).toBe('anthropic/claude-sonnet-4-6');
    expect(resolveModel('haiku', lookup)).toBe('anthropic/claude-haiku-4-5');
  });

  it('treats aliases case-insensitively', () => {
    expect(resolveModel('OPUS', lookup)).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('Sonnet', lookup)).toBe('anthropic/claude-sonnet-4-6');
  });

  it('passes a valid provider/model slug through unchanged', () => {
    expect(resolveModel('openai/gpt-4o', lookup)).toBe('openai/gpt-4o');
    expect(resolveModel('anthropic/claude-opus-4-8', lookup)).toBe('anthropic/claude-opus-4-8');
  });

  it('falls back to the default slug for empty/null/undefined/whitespace', () => {
    expect(resolveModel('', lookup)).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel('   ', lookup)).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel(null, lookup)).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel(undefined, lookup)).toBe(DEFAULT_MODEL_SLUG);
    expect(DEFAULT_MODEL_SLUG).toBe('anthropic/claude-opus-4-8');
  });

  it('resolves an unambiguous bare id to its slug', () => {
    expect(resolveModel('gpt-4o', lookup)).toBe('openai/gpt-4o');
  });

  it('rejects an ambiguous bare id shared across providers', () => {
    expect(() => resolveModel('shared-id', lookup)).toThrow(UnknownModelError);
  });

  it('throws on an unknown slug and an unknown bare id', () => {
    expect(() => resolveModel('anthropic/does-not-exist', lookup)).toThrow(UnknownModelError);
    expect(() => resolveModel('mystery-model-9000', lookup)).toThrow(UnknownModelError);
  });

  it('always returns a provider/model slug', () => {
    for (const ref of ['opus', 'sonnet', 'haiku', 'openai/gpt-4o', 'gpt-4o', '']) {
      expect(resolveModel(ref, lookup)).toMatch(/^[^/]+\/.+$/);
    }
  });

  it('UnknownModelError carries the reference and the available list', () => {
    try {
      resolveModel('nope/nope', lookup);
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

// Integration: validate the alias targets and default against the *real* pi
// registry, so this fails loudly if a future pi bump drops one of these ids.
describe('resolveModel against the real pi registry', () => {
  const registry = ModelRegistry.inMemory(AuthStorage.create());

  it('resolves the default and every alias to a real model', () => {
    expect(resolveModel('', registry)).toBe(DEFAULT_MODEL_SLUG);
    expect(resolveModel('opus', registry)).toBe('anthropic/claude-opus-4-8');
    expect(resolveModel('sonnet', registry)).toBe('anthropic/claude-sonnet-4-6');
    expect(resolveModel('haiku', registry)).toBe('anthropic/claude-haiku-4-5');
  });

  it('passes real provider slugs through and rejects unknowns', () => {
    expect(resolveModel('openai/gpt-4o', registry)).toBe('openai/gpt-4o');
    expect(() => resolveModel('anthropic/claude-imaginary-9', registry)).toThrow(UnknownModelError);
  });
});
