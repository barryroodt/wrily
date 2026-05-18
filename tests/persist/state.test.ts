import { describe, it, expect, beforeEach } from 'vitest';
import { markUsagePersisted, wasUsagePersisted, _resetUsagePersistedForTest } from '../../src/persist/state.js';

describe('usage-persisted flag', () => {
  beforeEach(() => _resetUsagePersistedForTest());

  it('defaults to false', () => {
    expect(wasUsagePersisted()).toBe(false);
  });

  it('flips to true after markUsagePersisted', () => {
    markUsagePersisted();
    expect(wasUsagePersisted()).toBe(true);
  });

  it('reset helper returns to false (test hook)', () => {
    markUsagePersisted();
    _resetUsagePersistedForTest();
    expect(wasUsagePersisted()).toBe(false);
  });
});
