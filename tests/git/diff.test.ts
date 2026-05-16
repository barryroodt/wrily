import { describe, it, expect } from 'vitest';
import {
  computeDiffRange,
  applyIgnorePatterns,
  countTeamThresholdScope,
  intersectFileLists,
  computeDiffFiles,
} from '../../src/git/diff.js';

describe('computeDiffRange', () => {
  it('returns full review range for full type', () => {
    expect(computeDiffRange({ reviewType: 'full', baseBranch: 'main', commitSha: 'abc' }))
      .toBe('origin/main...HEAD');
  });

  it('returns delta range for delta type with watermark', () => {
    expect(computeDiffRange({
      reviewType: 'delta', baseBranch: 'main', commitSha: 'def', lastReviewedSha: 'abc',
    })).toBe('abc...HEAD');
  });

  it('falls back to full range when delta has no watermark', () => {
    expect(computeDiffRange({
      reviewType: 'delta', baseBranch: 'main', commitSha: 'def', lastReviewedSha: null,
    })).toBe('origin/main...HEAD');
  });
});

describe('applyIgnorePatterns', () => {
  it('filters paths matching globs', () => {
    const result = applyIgnorePatterns(['a.lock', 'src/x.ts', 'vendor/y.go'], ['*.lock', 'vendor/**']);
    expect(result).toEqual(['src/x.ts']);
  });

  it('returns all paths when no patterns', () => {
    expect(applyIgnorePatterns(['a.ts', 'b.ts'], [])).toEqual(['a.ts', 'b.ts']);
  });
});

describe('countTeamThresholdScope', () => {
  const files = ['src/api/x.ts', 'src/api/y.ts', 'src/db/z.ts', 'README.md'];

  it('counts files when unit=files', () => {
    expect(countTeamThresholdScope(files, 'files')).toBe(4);
  });

  it('counts distinct parent dirs when unit=folders', () => {
    expect(countTeamThresholdScope(files, 'folders')).toBe(3);
  });

  it('treats top-level files as folder "."', () => {
    expect(countTeamThresholdScope(['a.md', 'b.md'], 'folders')).toBe(1);
  });

  it('returns 0 for empty file list (both units)', () => {
    expect(countTeamThresholdScope([], 'files')).toBe(0);
    expect(countTeamThresholdScope([], 'folders')).toBe(0);
  });
});

describe('intersectFileLists', () => {
  it('returns the sorted intersection of two lists', () => {
    expect(intersectFileLists(['b', 'a', 'c'], ['c', 'd', 'a'])).toEqual(['a', 'c']);
  });

  it('returns empty when no overlap', () => {
    expect(intersectFileLists(['a', 'b'], ['c', 'd'])).toEqual([]);
  });

  it('deduplicates within the intersection', () => {
    expect(intersectFileLists(['a', 'a', 'b'], ['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty when either list is empty', () => {
    expect(intersectFileLists([], ['a'])).toEqual([]);
    expect(intersectFileLists(['a'], [])).toEqual([]);
  });
});

describe('computeDiffFiles', () => {
  const captureCalls = (responses: Record<string, string>) => {
    const calls: string[] = [];
    const runGit = (cmd: string) => {
      calls.push(cmd);
      if (!(cmd in responses)) throw new Error(`unexpected git invocation: ${cmd}`);
      return responses[cmd]!;
    };
    return { calls, runGit };
  };

  it('full mode: single git diff against diffRange', () => {
    const { calls, runGit } = captureCalls({
      'git diff --name-only origin/main...HEAD': 'src/a.ts\nsrc/b.ts\n',
    });
    const result = computeDiffFiles({
      reviewType: 'full',
      baseBranch: 'main',
      commitSha: 'abc',
      lastReviewedSha: null,
      diffRange: 'origin/main...HEAD',
      hasRepoPath: true,
      runGit,
    });
    expect(result).toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls).toEqual(['git diff --name-only origin/main...HEAD']);
  });

  it('delta mode with watermark + repoPath: intersects PR diff with delta diff', () => {
    const { calls, runGit } = captureCalls({
      'git diff --name-only origin/main...HEAD': 'src/a.ts\nsrc/b.ts\nsrc/c.ts\n',
      'git diff --name-only oldsha...HEAD': 'src/b.ts\nsrc/c.ts\nvendor/merged-from-base.ts\n',
    });
    const result = computeDiffFiles({
      reviewType: 'delta',
      baseBranch: 'main',
      commitSha: 'abc',
      lastReviewedSha: 'oldsha',
      diffRange: 'oldsha..abc',
      hasRepoPath: true,
      runGit,
    });
    // vendor/merged-from-base.ts only in delta diff (merged from base) — excluded.
    expect(result).toEqual(['src/b.ts', 'src/c.ts']);
    expect(calls).toEqual([
      'git diff --name-only origin/main...HEAD',
      'git diff --name-only oldsha...HEAD',
    ]);
  });

  it('delta mode without repoPath: falls back to single diffRange invocation', () => {
    const { calls, runGit } = captureCalls({
      'git diff --name-only oldsha...HEAD': 'src/a.ts\n',
    });
    const result = computeDiffFiles({
      reviewType: 'delta',
      baseBranch: 'main',
      commitSha: 'abc',
      lastReviewedSha: 'oldsha',
      diffRange: 'oldsha...HEAD',
      hasRepoPath: false,
      runGit,
    });
    expect(result).toEqual(['src/a.ts']);
    expect(calls).toEqual(['git diff --name-only oldsha...HEAD']);
  });

  it('delta mode with no watermark: falls back to single diffRange invocation', () => {
    const { calls, runGit } = captureCalls({
      'git diff --name-only origin/main...HEAD': 'src/a.ts\n',
    });
    const result = computeDiffFiles({
      reviewType: 'delta',
      baseBranch: 'main',
      commitSha: 'abc',
      lastReviewedSha: null,
      diffRange: 'origin/main...HEAD',
      hasRepoPath: true,
      runGit,
    });
    expect(result).toEqual(['src/a.ts']);
    expect(calls).toEqual(['git diff --name-only origin/main...HEAD']);
  });

  it('returns [] when runGit throws', () => {
    const runGit = () => { throw new Error('git not found'); };
    const result = computeDiffFiles({
      reviewType: 'full',
      baseBranch: 'main',
      commitSha: 'abc',
      lastReviewedSha: null,
      diffRange: 'main..abc',
      hasRepoPath: false,
      runGit,
    });
    expect(result).toEqual([]);
  });
});
