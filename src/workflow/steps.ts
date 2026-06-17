import { createStep } from '@mastra/core/workflows';
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { WorkflowState } from './state.js';
import type { ReviewType } from '../config/types.js';
import { applyEnvOverrides, parseWrilyYml } from '../config/wrilyYml.js';
import { fetchPriorFeedbackDigest } from '../post/digest.js';
import { extractFindings } from '../post/extract.js';
import { routeFindings } from '../post/route.js';
import { renderReviewPrompt, renderUnifyFile } from '../prompt/render.js';
import { buildCloneUrl } from '../git/clone.js';
import { stageSkills } from '../skills/loader.js';
import { isValidSharedSkillName } from '../skills/names.js';
import { computeDiffRange, countTeamThresholdScope, applyIgnorePatterns, computeDiffFiles } from '../git/diff.js';
import { resolveAddressedThreads } from '../post/resolveThreads.js';
import { postReview, replyInThread } from '../post/github.js';
import { renderReviewBody } from '../post/body.js';
import type { AgentRunner, AgentResult } from '../agent/runner.js';
import type { Octokit } from '@octokit/rest';
import { isPersistenceEnabled, recordReviewRun } from '../persist/supabase.js';
import type { ReviewRunRecord, SubagentRecord } from '../persist/types.js';
import { markUsagePersisted } from '../persist/state.js';
import { buildReviewPromptContext, buildUnifyFileContext } from './reviewContext.js';
import { ratesForSlug, type ModelRates } from '../agent/models.js';
// DEFAULT_TIMEOUT_MS relocates from pi.ts to gantry.ts per the spec (Decision in
// "Component-level changes / src/agent"). gantry.ts is a sibling cutover todo;
// this import resolves once it lands. [cross-todo dep — see commit note]
import { DEFAULT_TIMEOUT_MS } from '../agent/gantry.js';

export const workflowStateSchema = z.custom<WorkflowState>(() => true);

export type WorkflowDeps = {
  agentRunner: AgentRunner;
  octokit: Pick<Octokit, 'rest'>;
  graphqlClient: { graphql: (query: string, vars?: Record<string, unknown>) => Promise<any> };
};

const GIT_TIMEOUT_MS = 120_000;

/**
 * Wrily's four invariant review-guard skills. The gantry profile injects this
 * exact set; they are copied from wrily's own install tree and a user skill may
 * never shadow one of these names.
 */
const INVARIANT_SKILLS = ['agent-team-review', 'code-review', 'confidence-rating', 'caveman-review'] as const;

/**
 * Token-budget defaults by review mode (Decision 3 — placeholders to calibrate
 * against supabase token history before merge). Used when `.wrily.yml`
 * `max_tokens` is unset.
 */
const DEFAULT_MAX_TOKENS_SINGLE = 2_000_000;
const DEFAULT_MAX_TOKENS_TEAM = 8_000_000;

/**
 * Resolve wrily's in-tree `skills/` directory (the trusted invariant set).
 * Prod sets `WRILY_SKILLS_DIR` (the Docker image copies `skills/` there);
 * locally it sits two levels up from this module (`src/workflow/` → repo root).
 */
function wrilyInstallSkillsDir(): string {
  const override = process.env.WRILY_SKILLS_DIR;
  return override && override.length > 0
    ? override
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

/** USD cost for a token vector at the given per-MTok rates (0 when unknown). */
function costUsd(
  rates: ModelRates | undefined,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  if (!rates) return 0;
  return (
    input * rates.input +
    output * rates.output +
    cacheRead * rates.cacheRead +
    cacheWrite * rates.cacheWrite
  ) / 1_000_000;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseTriggerSource(raw: string): 'github_app' | 'local_cli' {
  return raw === 'local_cli' ? 'local_cli' : 'github_app';
}

function deriveRunStatus(state: WorkflowState): 'success' | 'budget_exceeded' | 'timeout' | 'failed' {
  // persistUsageStep runs immediately after routeFindings (before the
  // GitHub post). At this point fallbackUsed is not yet known — treat the
  // run as successful if the agent produced results. Post-step issues
  // (fallback, 422s, etc.) are tracked separately in workflow logs.
  if (!state.agentResults || state.agentResults.length === 0) return 'failed';
  return 'success';
}

function redactSecrets(message: string, secrets: string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  return redacted.replace(/https:\/\/x-access-token:[^@\s]+@github\.com/g, 'https://x-access-token:[REDACTED]@github.com');
}

function sanitizedError(err: unknown, secrets: string[]): Error {
  const message = err instanceof Error ? err.message : String(err);
  const clean = new Error(redactSecrets(message, secrets));
  if (err instanceof Error) clean.name = err.name;
  return clean;
}

function runGit(args: string[], opts: { cwd?: string; secrets?: string[] } = {}): Buffer {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (err) {
    throw sanitizedError(err, opts.secrets ?? []);
  }
}

function runGitText(args: string[], opts: { cwd?: string; secrets?: string[] } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (err) {
    throw sanitizedError(err, opts.secrets ?? []);
  }
}

function runGitCommandText(cmd: string, cwd: string): string {
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] !== 'git') throw new Error(`unsupported git command: ${cmd}`);
  return runGitText(parts.slice(1), { cwd });
}

/**
 * Persist raw agent output(s) for debugging when WRILY_DEBUG_AGENT_OUTPUT names
 * a file path. No-op (and never throws) otherwise.
 */
function writeDebugOutput(results: AgentResult[]): void {
  const debugPath = process.env.WRILY_DEBUG_AGENT_OUTPUT;
  if (!debugPath) return;
  try {
    const body = results
      .map(
        (r, i) =>
          `=== AGENT ${i} (model=${r.model ?? 'unknown'}) ===\n=== STDOUT ===\n${r.stdout}\n\n=== STDERR ===\n${r.stderr}\n`,
      )
      .join('\n');
    writeFileSync(debugPath, body, 'utf8');
    const summary = results
      .map((r, i) => `#${i}: stdout=${r.stdout.length}B exit=${r.exitCode} durationMs=${r.durationMs}`)
      .join('; ');
    console.log(`[agentCall] raw output written to ${debugPath} (${results.length} result(s); ${summary})`);
  } catch (err) {
    console.warn(`[agentCall] failed to write debug output to ${debugPath}: ${(err as Error).message}`);
  }
}

export function makeSteps(deps: WorkflowDeps) {
  const cloneRepoStep = createStep({
    id: 'cloneRepo',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      // Guard: tests pre-seed repoPath to bypass git invocations.
      if (state.repoPath) {
        return state;
      }
      const { githubToken, githubRepository, prNumber, baseBranch, commitSha } = state.env;
      const root = mkdtempSync(join(tmpdir(), `wrily-pr-${prNumber}-`));
      const repoDir = join(root, 'repo');
      const url = buildCloneUrl(githubRepository, githubToken);
      const secrets = [githubToken, url];
      try {
        runGit(['clone', '--depth=200', url, repoDir], { secrets });
        runGit(['-C', repoDir, 'fetch', '--depth=200', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], { secrets });
        // Prefer SHA pin when present; fall back to PR ref.
        if (commitSha) {
          try {
            runGit(['-C', repoDir, 'checkout', commitSha], { secrets });
          } catch {
            runGit(['-C', repoDir, 'checkout', `pr-${prNumber}`], { secrets });
          }
        } else {
          runGit(['-C', repoDir, 'checkout', `pr-${prNumber}`], { secrets });
        }
        // Base-branch fetch — required so `git diff origin/<base>...HEAD`
        // resolves downstream. Fetch failure alone is non-fatal (the ref may
        // have been seeded by the initial clone), but the post-condition
        // below is: `origin/<baseBranch>` MUST resolve before proceeding.
        try {
          runGit(
            ['-C', repoDir, 'fetch', '--depth=200', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`],
            { secrets },
          );
        } catch (err) {
          console.warn(`[cloneRepo] base-branch fetch attempt failed: ${(err as Error).message}`);
        }
        try {
          runGit(['-C', repoDir, 'rev-parse', '--verify', `origin/${baseBranch}`], { secrets });
        } catch {
          throw new Error(
            `cloneRepo: origin/${baseBranch} ref is not resolvable after clone+fetch for ${githubRepository}#${prNumber}. ` +
              `Downstream 'git diff origin/${baseBranch}...HEAD' would fail silently and the review would produce no diff. ` +
              `Verify the base branch name and that the GitHub App installation has Contents: Read access.`,
          );
        }
      } catch (err) {
        throw new Error(`cloneRepo failed for ${githubRepository}#${prNumber}: ${(err as Error).message}`);
      }
      return { ...state, repoPath: repoDir };
    },
  });

  const loadConfigStep = createStep({
    id: 'loadConfig',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      // Precedence:
      //   1. `.wrily.yml` in `state.repoPath` (cloned consumer repo) wins.
      //   2. When absent, caller-supplied `state.cfg` passes through unchanged.
      //
      // Production: `state.cfg` starts at workflow defaults (main.ts), so the
      // file controls everything. Tests that pre-seed `state.cfg` AND set
      // `repoPath` to a directory containing `.wrily.yml` will see the file
      // win — drop the file or unset `repoPath` to avoid this.
      const cfgPath = join(state.repoPath ?? process.cwd(), '.wrily.yml');
      if (!existsSync(cfgPath)) {
        return state;
      }
      const raw = readFileSync(cfgPath, 'utf8');
      const cfg = applyEnvOverrides(parseWrilyYml(raw), state.env);
      return { ...state, cfg };
    },
  });

  const cloneSharedStep = createStep({
    id: 'cloneShared',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      // Guard: explicit pre-seed (test injection) — respect and skip.
      if (state.sharedPath !== undefined) {
        return state;
      }
      const { sharedToken, sharedRepo } = state.env;
      if (!sharedRepo) {
        console.log('[cloneShared] skipping — no SHARED_REPO set');
        return { ...state, sharedPath: null };
      }
      if (!sharedToken) {
        console.log('[cloneShared] skipping — no SHARED_TOKEN set');
        return { ...state, sharedPath: null };
      }
      try {
        const root = mkdtempSync(join(tmpdir(), 'wrily-shared-'));
        const sharedDir = join(root, 'shared');
        const url = buildCloneUrl(sharedRepo, sharedToken);
        runGit(['clone', '--depth=1', url, sharedDir], { secrets: [sharedToken, url] });
        return { ...state, sharedPath: sharedDir };
      } catch (err) {
        console.warn(`[cloneShared] failed (best-effort, continuing): ${(err as Error).message}`);
        return { ...state, sharedPath: null };
      }
    },
  });

  const stageSkillsStep = createStep({
    id: 'stageSkills',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      // Fresh per-run staging dir. The PR checkout is hostile: trusted skill
      // content is assembled here and handed to gantry via --skills-dir; nothing
      // is ever written into or resolved from the checkout's .claude/.
      const stagingDir = mkdtempSync(join(tmpdir(), 'wrily-skills-'));

      // 1. Invariant review guards from wrily's own install tree — the set the
      //    gantry profile injects.
      const invariantRoot = wrilyInstallSkillsDir();
      const sources: string[] = [];
      for (const name of INVARIANT_SKILLS) {
        const src = join(invariantRoot, name);
        if (!existsSync(src)) {
          console.warn(`[stageSkills] invariant skill "${name}" missing at ${src} — skipping`);
          continue;
        }
        sources.push(src);
      }

      // 2. Name-validated user skills from the shared-repo clone, appended after
      //    the invariant set. A user skill whose name collides with an invariant
      //    skill is rejected (warn + skip): .wrily.yml cannot shadow the guards.
      const invariantNames = new Set<string>(INVARIANT_SKILLS);
      const wanted = state.cfg.shared_skills ?? [];
      const loaded: string[] = [];
      if (state.sharedPath && wanted.length > 0) {
        for (const name of wanted) {
          if (invariantNames.has(name)) {
            console.warn(`[stageSkills] user skill "${name}" collides with an invariant skill — rejecting`);
            continue;
          }
          if (!isValidSharedSkillName(name)) {
            console.warn(`[stageSkills] invalid shared skill name "${name}" — skipping`);
            continue;
          }
          const src = join(state.sharedPath, 'skills', name);
          if (!existsSync(src)) {
            console.warn(`[stageSkills] source missing for "${name}" at ${src} — skipping`);
            continue;
          }
          sources.push(src);
          loaded.push(name);
        }
      } else {
        console.log('[stageSkills] no user skills to stage');
      }

      try {
        await stageSkills(sources, stagingDir);
      } catch (err) {
        console.warn(`[stageSkills] failed to stage skills: ${(err as Error).message}`);
      }

      // loadedSkills carries USER skills only — they ride --inject-skill; the
      // invariant set is injected by the gantry profile itself.
      return { ...state, skillsStagingDir: stagingDir, loadedSkills: loaded };
    },
  });

  const fetchDigestStep = createStep({
    id: 'fetchDigest',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.cfg.reply_feedback === 'off') {
        return { ...state, priorFeedback: null, digestFetchFailed: false };
      }
      try {
        const priorFeedback = await fetchPriorFeedbackDigest(
          {
            githubToken: state.env.githubToken,
            githubRepository: state.env.githubRepository,
            prNumber: state.env.prNumber,
            wrilyBotLogin: state.env.wrilyBotLogin,
            prAuthorLogin: state.env.prAuthorLogin,
          },
          deps.graphqlClient,
        );
        // The digest must be readable by gantry's workdir-confined tools, so it
        // is the one artifact written into the checkout — under <repo>/.wrily/
        // (the OS tmpdir location used before is unreachable by read_file).
        const workdir = state.repoPath ?? mkdtempSync(join(tmpdir(), 'wrily-'));
        const wrilyDir = join(workdir, '.wrily');
        mkdirSync(wrilyDir, { recursive: true });
        const digestPath = join(wrilyDir, 'prior-feedback.json');
        writeFileSync(digestPath, JSON.stringify(priorFeedback, null, 2), 'utf8');
        return { ...state, priorFeedback, digestFetchFailed: false, priorFeedbackDigestPath: digestPath };
      } catch (err) {
        throw new Error(
          `Prior-feedback digest fetch failed (fatal because reply_feedback=on): ${(err as Error).message}`,
        );
      }
    },
  });

  const resolveReviewStep = createStep({
    id: 'resolveReview',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      let reviewType: ReviewType = state.priorFeedback?.watermarkSha ? 'delta' : 'full';
      if (state.env.scopeOverride === 'full') {
        reviewType = 'full';
      } else if (state.env.scopeOverride === 'delta') {
        // Keep watermark-based logic — only forces delta when watermark exists; if no
        // watermark, fall back to full (bash had same fallback semantics).
        if (state.priorFeedback?.watermarkSha) {
          reviewType = 'delta';
        }
      }
      const lastReviewedSha = reviewType === 'delta' ? (state.priorFeedback?.watermarkSha ?? null) : null;
      const diffRange = computeDiffRange({
        reviewType,
        baseBranch: state.env.baseBranch,
        commitSha: state.env.commitSha,
        lastReviewedSha,
      });

      let diffFiles = state.diffFiles;
      if (!diffFiles) {
        const cwd = state.repoPath ?? process.cwd();
        diffFiles = computeDiffFiles({
          reviewType,
          baseBranch: state.env.baseBranch,
          commitSha: state.env.commitSha,
          lastReviewedSha,
          diffRange,
          hasRepoPath: !!state.repoPath,
          runGit: (cmd) => runGitCommandText(cmd, cwd),
        });
      }
      diffFiles = applyIgnorePatterns(diffFiles, state.cfg.ignore);

      let reviewMode: WorkflowState['reviewMode'];
      if (state.cfg.mode === 'auto') {
        const scope = countTeamThresholdScope(diffFiles, state.cfg.team_threshold_unit);
        reviewMode = scope >= state.cfg.team_threshold ? 'team' : 'single';
      } else {
        reviewMode = state.cfg.mode;
      }

      // Compute reviewRoundIndex from prior wrily-review-handoff markers when
      // we have a digest; otherwise leave undefined so renderPrompt falls back
      // to env.reviewRoundIndex. Cap at 5 per confidence-rating rubric.
      let reviewRoundIndex: number | undefined;
      if (state.priorFeedback) {
        const rawRound = (state.priorFeedback.priorReviewsCount ?? 0) + 1;
        reviewRoundIndex = Math.min(rawRound, 5);
      }

      return {
        ...state,
        reviewMode,
        reviewType,
        diffRange,
        lastReviewedSha,
        diffFiles,
        reviewRoundIndex,
      };
    },
  });

  const renderPromptStep = createStep({
    id: 'renderPrompt',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const renderedPrompt = renderReviewPrompt(buildReviewPromptContext(state));
      // Team mode: render the per-run unify prompt into a fresh mkdtemp dir
      // OUTSIDE the hostile PR checkout and hand its path to gantry via
      // --unify-file. Single mode leaves unifyPromptPath undefined — the task
      // prompt itself carries the full output contract.
      let unifyPromptPath: string | undefined;
      if (state.reviewMode === 'team') {
        const unifyDir = mkdtempSync(join(tmpdir(), 'wrily-unify-'));
        unifyPromptPath = join(unifyDir, 'unify.md');
        writeFileSync(unifyPromptPath, renderUnifyFile(buildUnifyFileContext(state)), 'utf8');
      }
      return { ...state, renderedPrompt, unifyPromptPath };
    },
  });

  const agentCallStep = createStep({
    id: 'agentCall',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      // resolveReviewStep narrows reviewMode to single|team; map auto defensively.
      const mode: 'single' | 'team' = state.reviewMode === 'team' ? 'team' : 'single';
      const maxTokens =
        state.cfg.max_tokens ?? (mode === 'team' ? DEFAULT_MAX_TOKENS_TEAM : DEFAULT_MAX_TOKENS_SINGLE);
      // Post-cutover the team lives inside gantry: one run, one result. Per-role
      // telemetry rides result.events; persistUsageStep unpacks it.
      const result = await deps.agentRunner.run({
        prompt: state.renderedPrompt!,
        model: state.cfg.model,
        mode,
        workingDir: state.repoPath!,
        maxTokens,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        skillsDir: state.skillsStagingDir,
        extraSkills: state.loadedSkills,
        unifyPromptPath: state.unifyPromptPath,
        env: process.env,
      });
      const agentResults = [result];
      writeDebugOutput(agentResults);
      return { ...state, agentResults };
    },
  });

  const extractFindingsStep = createStep({
    id: 'extractFindings',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const results = state.agentResults ?? [];
      // The postable review is always the last agent result: the single-mode
      // result, or the team unify pass appended after the reviewers.
      const source = results.at(-1);
      const reviews = source
        ? [extractFindings(source.stdout, { reviewType: state.reviewType })]
        : [];
      const findings = reviews.flatMap((r) => r.findings);
      return { ...state, reviews, findings };
    },
  });

  const routeFindingsStep = createStep({
    id: 'routeFindings',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const result = routeFindings(
        state.findings ?? [],
        state.priorFeedback ?? { watermarkSha: null, threads: [], prComments: [], priorReviewsCount: 0 },
      );
      return { ...state, actions: result.actions, suppressedActions: result.suppressedActions };
    },
  });

  const resolveAddressedThreadsStep = createStep({
    id: 'resolveAddressedThreads',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (!state.priorFeedback || state.priorFeedback.threads.length === 0) {
        return { ...state, resolvedThreadIds: [], resolveThreadsFailed: false };
      }
      try {
        const { resolvedThreadIds } = await resolveAddressedThreads({
          digest: state.priorFeedback,
          findings: state.findings ?? [],
          suppressedActions: state.suppressedActions ?? [],
          graphqlClient: deps.graphqlClient,
        });
        return { ...state, resolvedThreadIds, resolveThreadsFailed: false };
      } catch (err) {
        console.warn(`[resolveAddressedThreads] failed: ${(err as Error).message}`);
        return { ...state, resolvedThreadIds: [], resolveThreadsFailed: true };
      }
    },
  });

  const postToGitHubStep = createStep({
    id: 'postToGitHub',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const body = renderReviewBody(state);

      if (state.env.dryRun) {
        console.log(JSON.stringify({
          level: 'info',
          dryRun: true,
          body,
          actions: state.actions,
          suppressed: state.suppressedActions,
        }, null, 2));
        return { ...state, reviewBodyMarkdown: body, fallbackUsed: false, failedComments: [] };
      }

      const [owner, repo] = state.env.githubRepository.split('/') as [string, string];

      // Watermark dedupe: skip post if a review with the same commit SHA marker
      // already exists.
      //
      // SCOPE_OVERRIDE bypasses dedupe — when the caller explicitly forces a
      // re-review (Worker re-request or `SCOPE_OVERRIDE=full ./wrily`), they
      // want a fresh review posted even when one already exists for this SHA.
      if (state.env.scopeOverride) {
        console.log(`[postToGitHub] SCOPE_OVERRIDE=${state.env.scopeOverride} — bypassing watermark dedupe`);
      } else {
        try {
          const existing = await deps.octokit.rest.pulls.listReviews({
            owner, repo, pull_number: state.env.prNumber, per_page: 100,
          });
          const watermarkRe = new RegExp(`auto-reviewer:\\s*commit=${state.env.commitSha}\\b`);
          const hit = existing.data.find((r: any) => watermarkRe.test(r.body ?? ''));
          if (hit) {
            console.log(`[postToGitHub] watermark dedupe: review ${hit.id} for commit ${state.env.commitSha.slice(0, 7)} already exists — skipping post`);
            return {
              ...state,
              reviewBodyMarkdown: body,
              alreadyPosted: true,
              postedReviewId: hit.id,
              fallbackUsed: false,
              failedComments: [],
            };
          }
        } catch (err) {
          // Listing reviews failed — log + proceed (don't block posting on observability).
          console.warn(`[postToGitHub] dedupe check failed (proceeding): ${(err as Error).message}`);
        }
      }

      // Refresh commit SHA from the PR — the review may have taken minutes
      // and the original commit SHA could be stale (force-push, rebase, etc.).
      // GitHub returns 422 "invalid value" for out-of-date commit_id.
      let commitSha = state.env.commitSha;
      try {
        const { data: pr } = await deps.octokit.rest.pulls.get({ owner, repo, pull_number: state.env.prNumber });
        commitSha = pr.head.sha;
      } catch {
        console.warn(`[postToGitHub] failed to refresh PR head SHA, using original: ${commitSha}`);
      }

      const baseArgs = { owner, repo, prNumber: state.env.prNumber, commitSha };

      const inlineComments = (state.actions ?? []).flatMap((a) =>
        a.action === 'new_comment'
          ? [{ path: a.finding.path, line: a.finding.line, side: a.finding.side, body: a.finding.message }]
          : [],
      );

      const hasCriticalAction = (state.actions ?? []).some((a) => a.finding.severity === 'critical');
      const event = state.cfg.request_changes && hasCriticalAction ? 'REQUEST_CHANGES' : 'COMMENT';

      const reviewResult = await postReview(deps.octokit, {
        ...baseArgs, body, event, comments: inlineComments,
      });

      const threadById = new Map(
        (state.priorFeedback?.threads ?? []).map((t) => [t.thread_id, t]),
      );
      for (const a of state.actions ?? []) {
        if (a.action !== 'reply') continue;
        const thread = threadById.get(a.threadId);
        if (!thread || !thread.first_comment_rest_id) {
          console.warn(`[postToGitHub] reply skipped: thread_id=${a.threadId} missing first_comment_rest_id`);
          continue;
        }
        await replyInThread(deps.octokit, {
          ...baseArgs,
          inReplyToCommentId: thread.first_comment_rest_id,
          body: a.finding.message,
        });
      }

      return {
        ...state,
        reviewBodyMarkdown: body,
        postedReviewId: reviewResult.reviewId ?? undefined,
        fallbackUsed: reviewResult.fallbackUsed,
        failedComments: reviewResult.failedComments,
      };
    },
  });

  const persistUsageStep = createStep({
    id: 'persistUsage',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (!isPersistenceEnabled(state.env)) return state;
      try {
        const status = deriveRunStatus(state);
        const agentResults = state.agentResults ?? [];
        const result = agentResults[0];
        const events = result?.events;

        // gantry runs one model per run; cost attribution keys on its slug.
        const runSlug = result?.model ?? state.cfg.model;
        const rates = ratesForSlug(runSlug);
        const reviewMode: 'single' | 'team' = state.reviewMode === 'team' ? 'team' : 'single';

        // Fields shared by both mapping paths.
        const base = {
          github_repo: state.env.githubRepository,
          pr_number: state.env.prNumber,
          commit_sha: state.env.commitSha,
          trigger_source: collapseTriggerSource(state.env.triggerSource),
          review_round: state.reviewRoundIndex ?? state.env.reviewRoundIndex ?? 0,
          review_mode: reviewMode,
          scope: state.reviewType === 'delta' ? 'delta' : 'full',
          max_tokens: state.cfg.max_tokens ?? null,
          status,
          findings_posted: status === 'success' ? (state.findings ? state.findings.length : 0) : null,
        } as const;

        let run: ReviewRunRecord;
        let subagents: SubagentRecord[];

        if (events && events.length > 0) {
          // Decision 9: one SubagentRecord per subagent_done, plus a synthetic
          // coordinator row computed by subtraction so the per-row sums reconcile
          // exactly with the run record (closure invariant).
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let runDuration = result?.durationMs ?? 0;
          let sumInput = 0;
          let sumOutput = 0;
          let sumCacheRead = 0;
          let sumCacheWrite = 0;
          let coordinatorDuration = 0;
          const rows: SubagentRecord[] = [];

          for (const e of events) {
            switch (e.event) {
              case 'result':
                totalInput = e.total_input;
                totalOutput = e.total_output;
                totalCacheRead = e.total_cache_read;
                totalCacheWrite = e.total_cache_write;
                runDuration = e.duration_ms;
                break;
              case 'subagent_done':
                sumInput += e.input_tokens;
                sumOutput += e.output_tokens;
                sumCacheRead += e.cache_read;
                sumCacheWrite += e.cache_write;
                rows.push({
                  role: e.name,
                  model: runSlug,
                  duration_ms: e.duration_ms,
                  input_tokens: e.input_tokens,
                  output_tokens: e.output_tokens,
                  cache_read_tokens: e.cache_read,
                  cache_write_tokens: e.cache_write,
                  cost_usd: costUsd(rates, e.input_tokens, e.output_tokens, e.cache_read, e.cache_write),
                });
                break;
              case 'agent_turn':
                if (e.role === 'coordinator') coordinatorDuration += e.duration_ms;
                break;
              default:
                break;
            }
          }

          const coordInput = Math.max(0, totalInput - sumInput);
          const coordOutput = Math.max(0, totalOutput - sumOutput);
          const coordCacheRead = Math.max(0, totalCacheRead - sumCacheRead);
          const coordCacheWrite = Math.max(0, totalCacheWrite - sumCacheWrite);
          rows.push({
            role: 'coordinator',
            model: runSlug,
            duration_ms: coordinatorDuration,
            input_tokens: coordInput,
            output_tokens: coordOutput,
            cache_read_tokens: coordCacheRead,
            cache_write_tokens: coordCacheWrite,
            cost_usd: costUsd(rates, coordInput, coordOutput, coordCacheRead, coordCacheWrite),
          });

          subagents = rows;
          run = {
            ...base,
            model: runSlug,
            duration_ms: runDuration,
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cache_read_tokens: totalCacheRead,
            cache_write_tokens: totalCacheWrite,
            cost_usd: costUsd(rates, totalInput, totalOutput, totalCacheRead, totalCacheWrite),
          };
        } else {
          // No events (fake runners): one aggregate row per result, role by mode,
          // costs straight off the result's tokenUsage. Keeps workflow tests real.
          const totals = agentResults.reduce(
            (acc, r) => {
              const u = r.tokenUsage;
              if (!u) return acc;
              acc.input += u.inputTokens;
              acc.output += u.outputTokens;
              acc.cacheRead += u.cacheReadTokens ?? 0;
              acc.cacheWrite += u.cacheWriteTokens ?? 0;
              acc.cost += u.costUsd ?? 0;
              return acc;
            },
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          );
          const totalDuration = agentResults.reduce((sum, r) => sum + r.durationMs, 0);
          subagents = agentResults.map((r) => ({
            role: reviewMode === 'team' ? 'coordinator' : 'single',
            model: r.model ?? state.cfg.model,
            duration_ms: r.durationMs,
            input_tokens: r.tokenUsage?.inputTokens ?? 0,
            output_tokens: r.tokenUsage?.outputTokens ?? 0,
            cache_read_tokens: r.tokenUsage?.cacheReadTokens ?? 0,
            cache_write_tokens: r.tokenUsage?.cacheWriteTokens ?? 0,
            cost_usd: r.tokenUsage?.costUsd ?? 0,
          }));
          run = {
            ...base,
            model: agentResults[0]?.model ?? state.cfg.model,
            duration_ms: totalDuration,
            input_tokens: totals.input,
            output_tokens: totals.output,
            cache_read_tokens: totals.cacheRead,
            cache_write_tokens: totals.cacheWrite,
            cost_usd: totals.cost,
          };
        }

        await recordReviewRun(state.env, run, subagents);
        // Mark so main.ts's failure-path persistence doesn't double-write if a
        // later step (postToGitHub, resolveAddressedThreads) throws.
        markUsagePersisted();
      } catch (err) {
        console.warn(`[persistUsage] failed: ${(err as Error).message}`);
      }
      return state;
    },
  });

  return {
    cloneRepoStep,
    loadConfigStep,
    cloneSharedStep,
    stageSkillsStep,
    fetchDigestStep,
    resolveReviewStep,
    renderPromptStep,
    agentCallStep,
    extractFindingsStep,
    routeFindingsStep,
    resolveAddressedThreadsStep,
    postToGitHubStep,
    persistUsageStep,
  };
}
