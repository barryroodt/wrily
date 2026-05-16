import type { ReviewType, TeamThresholdUnit } from '../config/types.js';

export function computeDiffRange(input: {
  reviewType: ReviewType;
  baseBranch: string;
  commitSha: string;
  lastReviewedSha?: string | null;
}): string {
  if (input.reviewType === 'delta' && input.lastReviewedSha) {
    return `${input.lastReviewedSha}...HEAD`;
  }
  return `origin/${input.baseBranch}...HEAD`;
}

/**
 * Returns the sorted intersection of two file path lists (deduplicated).
 * Used to scope a delta review to files that BOTH:
 *   - exist in the PR diff (`origin/<base>...HEAD`) and
 *   - changed since the last review watermark (`<last>...HEAD`).
 * This excludes files merged in from the base branch since the last review,
 * matching the bash entrypoint's `comm -12` behavior.
 */
export function intersectFileLists(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return Array.from(new Set(b.filter((p) => set.has(p)))).sort();
}

export type RunGit = (cmd: string) => string;

/**
 * Compute the set of files to feed into a review. Pure (modulo `runGit`).
 *
 * - Full mode (or no watermark / no repoPath): single `git diff` between
 *   base and HEAD, splitting on newlines.
 * - Delta mode (watermark + repoPath): intersect the PR-wide diff
 *   (`origin/<base>...HEAD`) with the delta diff (`<last>...HEAD`) so files
 *   merged in from base since the last review are excluded.
 *
 * On any `runGit` error, returns `[]` (matches prior `try/catch → []` behavior).
 */
export function computeDiffFiles(input: {
  reviewType: ReviewType;
  baseBranch: string;
  commitSha: string;
  lastReviewedSha: string | null;
  diffRange: string;
  hasRepoPath: boolean;
  runGit: RunGit;
}): string[] {
  const parseList = (out: string): string[] =>
    out.split('\n').map((s) => s.trim()).filter(Boolean);

  try {
    if (input.reviewType === 'delta' && input.lastReviewedSha && input.hasRepoPath) {
      const prFiles = parseList(
        input.runGit(`git diff --name-only origin/${input.baseBranch}...HEAD`),
      );
      const deltaFiles = parseList(
        input.runGit(`git diff --name-only ${input.lastReviewedSha}...HEAD`),
      );
      return intersectFileLists(prFiles, deltaFiles);
    }
    return parseList(input.runGit(`git diff --name-only ${input.diffRange}`));
  } catch {
    return [];
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

export function applyIgnorePatterns(paths: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return paths;
  const regexes = patterns.map(globToRegex);
  return paths.filter((p) => !regexes.some((r) => r.test(p)));
}

/**
 * Count team-threshold scope.
 * - unit='files'   → distinct file count.
 * - unit='folders' → distinct parent-directory count. Repo-root files contribute synthetic ".".
 */
export function countTeamThresholdScope(
  files: string[],
  unit: TeamThresholdUnit,
): number {
  if (files.length === 0) return 0;
  if (unit === 'files') return new Set(files).size;
  const dirs = new Set<string>();
  for (const f of files) {
    const idx = f.lastIndexOf('/');
    dirs.add(idx === -1 ? '.' : f.slice(0, idx));
  }
  return dirs.size;
}
