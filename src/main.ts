import { Octokit } from '@octokit/rest';
import { graphql as octoGraphql } from '@octokit/graphql';
import { parseEnv } from './config/env.js';
import { parseWrilyYml, applyEnvOverrides } from './config/wrilyYml.js';
import { selectRunner } from './agent/factory.js';
import { buildReviewWorkflow, type WorkflowState } from './workflow/index.js';
import { maybePostFailure } from './post/failureFallback.js';
import { persistFailureRun } from './persist/failure.js';
import { wasUsagePersisted } from './persist/state.js';

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

  const initial: WorkflowState = { env, cfg };
  const run = await workflow.createRun();

  try {
    const result = await run.start({ inputData: initial });

    if (result.status !== 'success') {
      const err = result.status === 'failed' ? result.error : new Error(`workflow ${result.status}`);
      const normalized = err instanceof Error ? err : new Error(String(err));
      await maybePostFailure(env, octokit, normalized);
      // Skip if the success-path persistUsageStep already wrote a row
      // (e.g. failure was in post step, after cost capture).
      if (!wasUsagePersisted()) {
        await persistFailureRun(env, cfg, normalized);
      }
      logError(err);
      process.exit(1);
    }

    console.log('Wrily review complete.');
  } catch (err) {
    // run.start() shouldn't reject for WorkflowResult shape but guard anyway.
    const normalized = err instanceof Error ? err : new Error(String(err));
    await maybePostFailure(env, octokit, normalized);
    if (!wasUsagePersisted()) {
      await persistFailureRun(env, cfg, normalized);
    }
    logError(err);
    process.exit(1);
  }
}

main().catch((err) => {
  logError(err);
  process.exit(1);
});
