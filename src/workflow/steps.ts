import { createStep } from '@mastra/core/workflows';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { WorkflowState } from './state.js';
import type { ReviewType } from '../config/types.js';
import { applyEnvOverrides, parseWrilyYml } from '../config/wrilyYml.js';
import { fetchPriorFeedbackDigest } from '../post/digest.js';
import { extractFindings } from '../post/extract.js';
import { routeFindings } from '../post/route.js';
import { renderReviewPrompt } from '../prompt/render.js';
import { buildCloneUrl } from '../git/clone.js';
import { bridgeSkills } from '../skills/loader.js';
import { isValidSharedSkillName } from '../skills/names.js';
import {
  styleInstruction,
  sensitivityInstruction,
  deltaCleanInstruction,
  resolveThreadsInstruction,
  confidenceInstruction,
  priorFeedbackInstruction,
  triggerContextInstruction,
} from '../prompt/instructions.js';
import { computeDiffRange, countTeamThresholdScope, applyIgnorePatterns, computeDiffFiles } from '../git/diff.js';
import { resolveAddressedThreads } from '../post/resolveThreads.js';
import { postReview, replyInThread } from '../post/github.js';
import { renderReviewBody } from '../post/body.js';
import type { AgentRunner } from '../agent/runner.js';
import type { Octokit } from '@octokit/rest';

export const workflowStateSchema = z.custom<WorkflowState>(() => true);

export type WorkflowDeps = {
  agentRunner: AgentRunner;
  octokit: Pick<Octokit, 'rest'>;
  graphqlClient: { graphql: (query: string, vars?: Record<string, unknown>) => Promise<any> };
};

const GIT_TIMEOUT_MS = 120_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const bridgeSkillsStep = createStep({
    id: 'bridgeSkills',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const wanted = state.cfg.shared_skills ?? [];
      if (!state.sharedPath || wanted.length === 0) {
        console.log('[bridgeSkills] no shared skills to bridge');
        return { ...state, loadedSkills: [] };
      }
      const destRoot = join(homedir(), '.claude', 'skills');
      const loaded: string[] = [];
      for (const name of wanted) {
        if (!isValidSharedSkillName(name)) {
          console.warn(`[bridgeSkills] invalid shared skill name "${name}" — skipping`);
          continue;
        }
        const src = join(state.sharedPath, 'skills', name);
        if (!existsSync(src)) {
          console.warn(`[bridgeSkills] source missing for "${name}" at ${src} — skipping`);
          continue;
        }
        const dest = join(destRoot, name);
        try {
          await bridgeSkills(src, dest);
          loaded.push(name);
        } catch (err) {
          console.warn(`[bridgeSkills] failed to copy "${name}": ${(err as Error).message}`);
        }
      }
      return { ...state, loadedSkills: loaded };
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
        const tmpDir = mkdtempSync(join(tmpdir(), 'wrily-'));
        const digestPath = join(tmpDir, 'prior-feedback.json');
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
      const diffFiles = state.diffFiles ?? [];
      const diffPathFilter = diffFiles.length > 0 ? ` -- ${diffFiles.join(' ')}` : '';
      const diffCommandInstruction = state.reviewType === 'delta'
        ? [
          'This is a DELTA review — only review changes the author made since the last reviewed commit.',
          '',
          '```bash',
          `git diff ${state.diffRange}${diffPathFilter}`,
          '```',
        ].join('\n')
        : [
          'Get the full diff of this PR:',
          '',
          '```bash',
          `git diff ${state.diffRange}`,
          '```',
        ].join('\n');
      const renderedPrompt = renderReviewPrompt({
        prNumber: state.env.prNumber,
        githubRepository: state.env.githubRepository,
        diffRange: state.diffRange!,
        diffCommandInstruction,
        ignorePatterns: state.cfg.ignore.length ? state.cfg.ignore.join(', ') : '(none configured)',
        sharedContextInstruction: '',
        styleInstruction: styleInstruction(state.cfg.style),
        sensitivityInstruction: sensitivityInstruction(state.cfg.sensitivity),
        deltaCleanInstruction: deltaCleanInstruction(state.reviewType!),
        resolveThreadsInstruction: resolveThreadsInstruction(
          state.cfg.reply_feedback,
          state.priorFeedbackDigestPath ?? '',
        ),
        confidenceInstruction: confidenceInstruction(state.reviewRoundIndex ?? state.env.reviewRoundIndex),
        priorFeedbackInstruction: priorFeedbackInstruction(
          state.cfg.reply_feedback,
          state.priorFeedbackDigestPath ?? '',
        ),
        triggerContextInstruction: triggerContextInstruction(state.env.triggerSource, state.env.actor),
        reviewTypeNote: state.reviewType === 'delta' ? 'Delta review.' : 'Full review.',
        reviewMode: state.reviewMode!,
      });
      return { ...state, renderedPrompt };
    },
  });

  const agentCallStep = createStep({
    id: 'agentCall',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const result = await deps.agentRunner.run({
        prompt: state.renderedPrompt!,
        model: state.cfg.model,
        maxBudgetUsd: state.cfg.max_budget_usd ?? (state.reviewMode === 'team' ? 15 : 5),
        workingDir: state.repoPath ?? '/tmp/repo',
        env: process.env,
      });
      // Debug: persist raw model output when env requests it (set
      // WRILY_DEBUG_AGENT_OUTPUT=<path> to enable). Skipped silently otherwise.
      const debugPath = process.env.WRILY_DEBUG_AGENT_OUTPUT;
      if (debugPath) {
        try {
          const { writeFileSync: w } = await import('node:fs');
          w(debugPath, `=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}\n`, 'utf8');
          console.log(`[agentCall] raw output written to ${debugPath} (stdout=${result.stdout.length}B, stderr=${result.stderr.length}B, exit=${result.exitCode}, durationMs=${result.durationMs})`);
        } catch (err) {
          console.warn(`[agentCall] failed to write debug output to ${debugPath}: ${(err as Error).message}`);
        }
      }
      return { ...state, agentResults: [result] };
    },
  });

  const extractFindingsStep = createStep({
    id: 'extractFindings',
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      const reviews = (state.agentResults ?? []).map((r) =>
        extractFindings(r.stdout, { reviewType: state.reviewType }),
      );
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

      const baseArgs = { owner, repo, prNumber: state.env.prNumber, commitSha: state.env.commitSha };

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

  return {
    cloneRepoStep,
    loadConfigStep,
    cloneSharedStep,
    bridgeSkillsStep,
    fetchDigestStep,
    resolveReviewStep,
    renderPromptStep,
    agentCallStep,
    extractFindingsStep,
    routeFindingsStep,
    resolveAddressedThreadsStep,
    postToGitHubStep,
  };
}
