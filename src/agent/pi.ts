import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentRunner, AgentRunOptions, AgentResult, AgentTokenUsage } from './runner.js';
import { resolveModel } from './modelResolver.js';
import { PROVIDER_API_KEY_ENV } from '../config/providers.js';

/**
 * Team mode fans out N reviewer sessions in parallel plus a unify pass; a
 * substantial review can still run many minutes per session. Single mode is
 * typically faster. Each `run()` gets its own timeout. Override the default via
 * the `WRILY_AGENT_TIMEOUT_MS` env var, or per call via `AgentRunOptions.timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(process.env.WRILY_AGENT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30 * 60 * 1000;
})();

/**
 * Thrown when the in-flight pi session is aborted because it exceeded the
 * configured timeout. Distinguishes a forced abort from an organic failure so
 * the outer workflow can post a timeout-specific failure comment. `name` is
 * matched by `persist/failure.ts` and `instanceof` by `post/failureFallback.ts`.
 */
export class AgentTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`agent run timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Thrown when the in-flight pi session is aborted because accumulated cost
 * exceeded `maxBudgetUsd`. Unlike the old CLI heuristic, this is real
 * enforcement driven by pi-ai's native per-turn `Usage.cost`.
 */
export class AgentBudgetExceededError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('agent run exceeded budget');
    this.name = 'AgentBudgetExceededError';
  }
}

/** The slice of pi's `AgentSession` that {@link PiRunner} depends on. */
export interface PiSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  getLastAssistantText(): string | undefined;
  dispose(): void;
}

/** A ready-to-prompt session plus the canonical slug it was resolved to. */
export interface PiSessionHandle {
  session: PiSession;
  /** Canonical `provider/model` slug the session is bound to. */
  model: string;
}

/**
 * Seam for constructing a pi session from run options. Injected so tests can
 * supply a fake without touching the network or the real registry.
 */
export type PiSessionFactory = (opts: AgentRunOptions) => Promise<PiSessionHandle>;

/** Copy any present provider API keys from the run env into pi runtime auth. */
function applyProviderKeys(auth: AuthStorage, env: Record<string, string | undefined>): void {
  for (const [provider, names] of Object.entries(PROVIDER_API_KEY_ENV)) {
    for (const name of names) {
      const value = env[name];
      if (value) {
        auth.setRuntimeApiKey(provider, value);
        break;
      }
    }
  }
}

/**
 * Real factory: wires a fully in-process, hermetic pi session.
 *
 * Everything is in-memory (no on-disk auth/models/sessions/settings) and the
 * resource loader is locked down (no extensions, skills, context files, prompt
 * templates, or themes) so a review run is deterministic and never silently
 * absorbs the reviewed repo's agent config. The review instructions arrive via
 * the prompt; an optional team role is layered on with `appendSystemPrompt`.
 */
export const defaultPiSessionFactory: PiSessionFactory = async (opts) => {
  const authStorage = AuthStorage.create();
  applyProviderKeys(authStorage, opts.env);

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const slug = resolveModel(opts.model, modelRegistry);
  const slashIndex = slug.indexOf('/');
  const model = modelRegistry.find(slug.slice(0, slashIndex), slug.slice(slashIndex + 1));
  if (!model) {
    // resolveModel validated the slug against this same registry, so a miss here
    // is impossible — guard for a loud failure instead of a confusing one later.
    throw new Error(`Resolved model "${slug}" is missing from the registry.`);
  }

  const settingsManager = SettingsManager.inMemory();
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.workingDir,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(opts.systemPrompt ? { appendSystemPrompt: [opts.systemPrompt] } : {}),
  });
  // A caller-provided resource loader must be reloaded before use:
  // createAgentSession only reloads the default loader it builds itself. Without
  // this, appendSystemPrompt (the team role persona) is never resolved.
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: opts.workingDir,
    agentDir,
    model,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(opts.workingDir),
    settingsManager,
    resourceLoader,
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    excludeTools: ['edit', 'write'],
  });

  return { session, model: slug };
};

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { role?: unknown }).role === 'assistant'
  );
}

/**
 * AgentRunner backed by the pi coding agent, run in-process via
 * `@earendil-works/pi-coding-agent`. Replaces the `claude -p` subprocess runner
 * and makes Wrily provider-agnostic.
 */
export class PiRunner implements AgentRunner {
  constructor(private readonly factory: PiSessionFactory = defaultPiSessionFactory) {}

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const { session, model } = await this.factory(opts);

    // Accumulate usage per assistant turn rather than reading
    // getSessionStats() at the end: the latter recomputes over the *current*
    // message list, which compaction can shrink, undercounting cost/tokens
    // (scratchpad 21, spike Q1). Per-turn accumulation is monotonic.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;
    let sawUsage = false;
    // Fallback for getLastAssistantText(): keep the latest assistant turn's text.
    let lastTurnText = '';

    let timedOut = false;
    let budgetExceeded = false;
    let aborting = false;
    const triggerAbort = (): void => {
      if (aborting) return;
      aborting = true;
      // abort() resolves the in-flight prompt() (StopReason "aborted") rather
      // than rejecting it (spike Q3); fire-and-forget, then act on the flags
      // once prompt() settles below.
      void session.abort();
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type !== 'turn_end') return;
      const message = event.message;
      if (!isAssistantMessage(message)) return;

      const { usage } = message;
      inputTokens += usage.input;
      outputTokens += usage.output;
      cacheReadTokens += usage.cacheRead;
      cacheWriteTokens += usage.cacheWrite;
      costUsd += usage.cost.total;
      sawUsage = true;

      let text = '';
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
      }
      if (text.length > 0) lastTurnText = text;

      if (opts.maxBudgetUsd != null && costUsd > opts.maxBudgetUsd) {
        budgetExceeded = true;
        triggerAbort();
      }
    });

    const killer = setTimeout(() => {
      timedOut = true;
      triggerAbort();
    }, timeoutMs);

    let promptError: unknown;
    try {
      await session.prompt(opts.prompt);
    } catch (err) {
      promptError = err;
    } finally {
      clearTimeout(killer);
      unsubscribe();
    }

    const durationMs = Date.now() - start;
    const finalText = (session.getLastAssistantText() ?? '') || lastTurnText;
    session.dispose();

    if (timedOut) throw new AgentTimeoutError(timeoutMs, finalText, '');
    if (budgetExceeded) throw new AgentBudgetExceededError(finalText, '');
    // A non-abort rejection is a genuine failure (e.g. no API key for the
    // provider, provider error) — surface it.
    if (promptError) throw promptError;

    const tokenUsage: AgentTokenUsage | null = sawUsage
      ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }
      : null;

    return { stdout: finalText, stderr: '', exitCode: 0, durationMs, tokenUsage, model };
  }
}
