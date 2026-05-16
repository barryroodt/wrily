import { describe, it, expect } from 'vitest';
import { buildCloneUrl, cloneOptionsFor } from '../../src/git/clone.js';

describe('buildCloneUrl', () => {
  it('includes token via x-access-token', () => {
    expect(buildCloneUrl('org/repo', 'gho_xxx'))
      .toBe('https://x-access-token:gho_xxx@github.com/org/repo.git');
  });
});

describe('cloneOptionsFor', () => {
  it('returns shallow clone options', () => {
    const opts = cloneOptionsFor({ depth: 50, branch: 'main' });
    expect(opts).toContain('--depth=50');
    expect(opts).toContain('--branch=main');
  });
});
