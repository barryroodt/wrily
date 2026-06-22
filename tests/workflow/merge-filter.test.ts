import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { buildReviewWorkflow } from '../../src/workflow/index.js';
import { FakeAgentRunner } from '../../src/agent/fake.js';
import type { WorkflowState } from '../../src/workflow/state.js';
import type { RuntimeEnv, WrilyConfig } from '../../src/config/types.js';

const FAKE_REPLY = `\`\`\`json
{ "summary": "ok", "findings": [], "strengths": [] }
\`\`\``;

function digestPageWith(reviewBody: string | null) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [] },
        reviews: { nodes: reviewBody ? [{ body: reviewBody }] : [] },
      },
    },
  };
}

function baseEnv(over: Partial<RuntimeEnv>): RuntimeEnv {
  return {
    anthropicApiKey: null,
    githubToken: 'gho_x',
    prNumber: 1,
    githubRepository: 'org/repo',
    baseBranch: 'main',
    commitSha: 'HEAD',
    sharedRepo: 'your-org/shared-wrily-skills',
    sharedToken: '',
    wrilyBotLogin: 'wrily',
    reviewRoundIndex: 0,
    scopeOverride: '',
    modeOverride: '', replyFeedbackOverride: '',
    modelOverride: '',
    allowUnknownModel: false,
    dryRun: true,
    prAuthorLogin: 'human-dev',
    triggerSource: 'push',
    actor: 'human-dev',
    ...over,
  };
}

function baseCfg(): WrilyConfig {
  return {
    model: 'opus',
    mode: 'single',
    team_threshold: 100,
    team_threshold_unit: 'files',
    max_tokens: null,
    ignore: [],
    shared_skills: [],
    request_changes: false,
    style: 'terse',
    sensitivity: 'minor',
    reply_feedback: 'on',
  };
}

async function runWorkflow(initial: WorkflowState, digestPage: unknown) {
  const agentRunner = new FakeAgentRunner({
    stdout: FAKE_REPLY, stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null,
  });
  const fakeOctokit = { rest: {} as any };
  const fakeGraphql = { graphql: async () => digestPage };
  const workflow = buildReviewWorkflow({ agentRunner, octokit: fakeOctokit, graphqlClient: fakeGraphql });
  const run = await workflow.createRun();
  const result = await run.start({ inputData: initial });
  if (result.status !== 'success') {
    throw new Error(`workflow failed: ${(result as any).error?.message ?? 'unknown'}`);
  }
  return result.result as unknown as WorkflowState;
}

/**
 * Build a tmp git repo modelling:
 *   - base (origin/main) is "main" branch at commit M0
 *   - feature branch off M0:
 *       F1: add src/a.ts, src/b.ts  ← "first review" point (watermark = F1)
 *       F2: edit src/b.ts, add src/c.ts
 *   - main moves forward to M1: adds vendor/from-base.ts (merged into feature)
 *   - feature merges main → F3 (brings vendor/from-base.ts into feature HEAD)
 *
 * Expected delta files (F1..HEAD): src/b.ts, src/c.ts, vendor/from-base.ts
 * Expected PR files (origin/main...HEAD): src/a.ts, src/b.ts, src/c.ts
 * Intersection (merge-filter): src/a.ts? no — a.ts not in delta. So intersection
 * is src/b.ts, src/c.ts. vendor/from-base.ts excluded (merged in from base).
 */
function buildFixture(): { repoPath: string; watermark: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'wrily-merge-filter-'));
  const git = (cmd: string) => execSync(cmd, { cwd: repoPath, stdio: 'pipe' });
  const write = (rel: string, body: string) => {
    const full = join(repoPath, rel);
    const dir = full.substring(0, full.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, body, 'utf8');
  };

  git('git init -q -b main');
  git('git config user.email t@t.com');
  git('git config user.name t');
  git('git commit -q --allow-empty -m "M0"');

  // Branch off and create F1 (watermark point)
  git('git checkout -q -b feature');
  write('src/a.ts', 'a v1\n');
  write('src/b.ts', 'b v1\n');
  git('git add -A');
  git('git commit -q -m "F1"');
  const watermark = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

  // F2: edit b, add c
  write('src/b.ts', 'b v2\n');
  write('src/c.ts', 'c v1\n');
  git('git add -A');
  git('git commit -q -m "F2"');

  // Move main forward — add vendor/from-base.ts
  git('git checkout -q main');
  write('vendor/from-base.ts', 'from base\n');
  git('git add -A');
  git('git commit -q -m "M1"');

  // Merge main into feature (brings vendor/from-base.ts into feature HEAD)
  git('git checkout -q feature');
  git('git merge -q --no-edit main');

  // Set up origin/main to mirror main (so `origin/main...HEAD` works).
  git('git update-ref refs/remotes/origin/main main');

  return { repoPath, watermark };
}

describe('workflow / delta merge-filter', () => {
  let fixture: { repoPath: string; watermark: string };

  beforeAll(() => {
    fixture = buildFixture();
  });

  afterAll(() => {
    if (fixture?.repoPath) rmSync(fixture.repoPath, { recursive: true, force: true });
  });

  it('excludes files merged in from base since the last review', async () => {
    const commitSha = execSync('git rev-parse HEAD', { cwd: fixture.repoPath, encoding: 'utf8' }).trim();
    const final = await runWorkflow(
      {
        env: baseEnv({ commitSha, baseBranch: 'main' }),
        cfg: baseCfg(),
        repoPath: fixture.repoPath,
        // diffFiles intentionally unset → resolveReviewStep computes via git
      },
      digestPageWith(`<!-- auto-reviewer: commit=${fixture.watermark}, status=clean -->`),
    );

    expect(final.reviewType).toBe('delta');
    expect(final.lastReviewedSha).toBe(fixture.watermark);
    // vendor/from-base.ts is in delta diff (merged in) but NOT in the PR
    // diff (origin/main...HEAD), so the merge-filter must drop it.
    expect(final.diffFiles).toEqual(['src/b.ts', 'src/c.ts']);
    expect(final.renderedPrompt).toContain(`git diff ${fixture.watermark}...HEAD -- src/b.ts src/c.ts`);
    expect(final.renderedPrompt).not.toContain(`git diff ${fixture.watermark}...HEAD -- vendor/from-base.ts`);
  });
});
