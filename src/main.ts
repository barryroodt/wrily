import { Octokit } from '@octokit/rest';
import { graphql as octoGraphql } from '@octokit/graphql';
import { parseEnv } from './config/env.js';
import { parseWrilyYml, applyEnvOverrides } from './config/wrilyYml.js';
import { selectRunner } from './agent/factory.js';
import { buildReviewWorkflow, type WorkflowState } from './workflow/index.js';
import { maybePostFailure } from './post/failureFallback.js';
import { persistFailureRun } from './persist/failure.js';
import { wasUsagePersisted } from './persist/state.js';
import type { RuntimeEnv, WrilyConfig } from './config/types.js';

/**
 * Guards against double-posting the failure comment when a signal handler and
 * the workflow's normal failure path race. Whichever path sets it first wins;
 * the other returns early.
 */
let postingFailure = false;

/**
 * Post a failure comment, persist a failure row when one hasn't already been
 * recorded by the success-path persistUsageStep, and log the error.
 * Shared by the workflow result-branch, the workflow catch, and the signal
 * handler so all three converge on the same failure contract.
 */
async function recordFailure(
  env: RuntimeEnv,
  cfg: WrilyConfig,
  octokit: Octokit,
  err: unknown,
): Promise<void> {
  const normalized = err instanceof Error ? err : new Error(String(err));
  await maybePostFailure(env, octokit, normalized);
  if (!wasUsagePersisted()) {
    await persistFailureRun(env, cfg, normalized);
  }
  logError(normalized);
}

/**
 * On SIGTERM (CI job timeout) / SIGINT (Ctrl-C), best-effort: post a failure
 * comment so the PR shows *why* the review died instead of silently going stale,
 * then exit with the conventional signal code (128 + signum).
 *
 * The agent timeout (12m, set below the 30m job ceiling) should normally fire
 * first and surface `AgentTimeoutError` through the workflow's regular failure
 * path; this handler is the defensive net for the edge case where it does not
 * (e.g. the workflow hangs outside an agent call). `process.once` prevents
 * re-entrancy if the signal is delivered twice.
 */
async function handleTermination(
  signal: NodeJS.Signals,
  env: RuntimeEnv,
  cfg: WrilyConfig,
  octokit: Octokit,
): Promise<void> {
  if (postingFailure) return;
  postingFailure = true;
  console.error(`Received ${signal}; recording failure before exit.`);
  try {
    await recordFailure(
      env,
      cfg,
      octokit,
      new Error(`process terminated by ${signal} before workflow completed`),
    );
  } catch (postErr) {
    logError(postErr);
  }
  // 128 + signum: SIGINT=2, SIGTERM=15.
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

function logError(err: unknown): void {
  console.error(JSON.stringify({
    level: 'error',
    ts: new Date().toISOString(),
    err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
  }));
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>);

  // Start from defaults only. The consumer repo is cloned inside the workflow,
  // so `.wrily.yml` must be loaded from that cloned repo after cloneRepoStep.
  const cfg = applyEnvOverrides(parseWrilyYml(''), env);

  const octokit = new Octokit({ auth: env.githubToken });
  const auth = `token ${env.githubToken}`;
  const graphqlFn = octoGraphql.defaults({ headers: { authorization: auth } });
  const graphqlClient = {
    graphql: (query: string, vars?: Record<string, unknown>) => graphqlFn(query, vars),
  };
  const agentRunner = selectRunner(cfg.model);

  const workflow = buildReviewWorkflow({ agentRunner, octokit, graphqlClient });

  process.once('SIGTERM', () => {
    void handleTermination('SIGTERM', env, cfg, octokit);
  });
  process.once('SIGINT', () => {
    void handleTermination('SIGINT', env, cfg, octokit);
  });

  const initial: WorkflowState = { env, cfg };
  const run = await workflow.createRun();

  try {
    const result = await run.start({ inputData: initial });

    if (result.status !== 'success') {
      if (postingFailure) return;
      postingFailure = true;
      const err =
        result.status === 'failed' ? result.error : new Error(`workflow ${result.status}`);
      await recordFailure(env, cfg, octokit, err);
      process.exit(1);
    }

    if (postingFailure) return;
    console.log('Wrily review complete.');
  } catch (err) {
    // run.start() shouldn't reject for WorkflowResult shape but guard anyway.
    if (postingFailure) return;
    postingFailure = true;
    await recordFailure(env, cfg, octokit, err);
    process.exit(1);
  }
}

main().catch((err) => {
  logError(err);
  process.exit(1);
});
