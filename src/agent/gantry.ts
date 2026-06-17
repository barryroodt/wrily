import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentResult,
  AgentRunner,
  AgentRunOptions,
  AgentTokenUsage,
  ErrorEvent,
  ResultEvent,
} from './runner.js';
import { resolveModel } from './modelResolver.js';
import { costForTokens, ratesForSlug } from './models.js';
import {
  AgentBudgetExceededError,
  AgentTimeoutError,
  AgentRateLimitedError,
} from './errors.js';

/**
 * Per-`run()` timeout. Kept BELOW the CI job ceiling (workflows set
 * `timeout-minutes: 30`) so a hung session aborts and raises
 * AgentTimeoutError — letting the workflow post a timeout failure comment —
 * before GitHub hard-kills the container. Post-cutover a team review is ONE
 * gantry subprocess (reviewers + unify in a single run under a single
 * `--timeout-ms`), so the worst case is ~12m — not two sequential ~24m phases.
 * `run()` keeps this deadline authoritative across rate-limit retries (each
 * retry's `--timeout-ms` is the REMAINING budget, never a fresh `timeoutMs`).
 * Override via the `WRILY_AGENT_TIMEOUT_MS` env var, or per call via
 * `AgentRunOptions.timeoutMs`.
 */
export const DEFAULT_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(process.env.WRILY_AGENT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 12 * 60 * 1000;
})();

/** Gantry's NDJSON `start` event must carry this schema version (warn on drift). */
const SCHEMA_VERSION = '1.1';

/**
 * Grace added on top of the run's own `timeoutMs` before the watchdog force-kills
 * a wedged child. Gantry enforces `--timeout-ms` itself and exits `timeout`; the
 * watchdog only fires when the child never closes its stream at all.
 */
const WATCHDOG_GRACE_MS = 30_000;

/** Delay between SIGTERM and the SIGKILL backstop when reaping a wedged child. */
const SIGKILL_DELAY_MS = 5_000;

/** stdout assistant-text buffer cap; per-run, across all roles. */
const ASSISTANT_TEXT_CAP_CHARS = 1024 * 1024;

/** Captured stderr cap. */
const STDERR_CAP_CHARS = 256 * 1024;

/** Max whole-run attempts when gantry exits `rate_limited` (exit 5). */
const MAX_RATE_LIMIT_ATTEMPTS = 3;

/** Backoff used between rate-limit retries when the error event omits a hint. */
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** Static observability hooks; sync and fire-and-forget in v1. */
export interface GantryHooks {
  onEvent?(event: AgentEvent): void;
}

/** Construction-time (per-process) dependencies; all per-run inputs ride `AgentRunOptions`. */
export interface GantryRunnerDeps {
  /** Gantry binary path (`env.wrilyGantryBin ?? 'gantry'`). */
  binary: string;
  /** Wrily-owned `profiles/review/` directory, forwarded to `--profile`. */
  profileDir: string;
  /**
   * Unknown-model escape hatch, mirrored from `RuntimeEnv.allowUnknownModel`
   * (`WRILY_ALLOW_UNKNOWN_MODEL=1`). Threaded here at the composition root so
   * `resolveModel` never reaches into `process.env` itself. Defaults to `false`.
   */
  allowUnknownModel?: boolean;
  hooks?: GantryHooks;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function truncateForLog(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Assemble the gantry argv. Required flags first (the as-shipped v0.1.0 contract),
 * then the conditional overrides: `--unify-file` only in team mode and only when a
 * rendered path was supplied, `--skills-dir` when staged, one `--inject-skill` per
 * user skill (appended after the profile's invariant set).
 */
function buildArgv(
  profileDir: string,
  req: AgentRunOptions,
  model: string,
  promptFile: string,
  timeoutMs: number,
): string[] {
  const argv: string[] = [
    '--profile',
    profileDir,
    '--mode',
    req.mode,
    '--model',
    model,
    '--workdir',
    req.workingDir,
    '--prompt-file',
    promptFile,
    '--max-tokens',
    String(req.maxTokens),
    '--timeout-ms',
    String(timeoutMs),
  ];
  if (req.unifyPromptPath && req.mode === 'team') {
    argv.push('--unify-file', req.unifyPromptPath);
  }
  if (req.skillsDir) {
    argv.push('--skills-dir', req.skillsDir);
  }
  for (const name of req.extraSkills ?? []) {
    argv.push('--inject-skill', name);
  }
  return argv;
}

/**
 * AgentRunner backed by the gantry standalone harness, consumed as a subprocess
 * and parsed from its NDJSON event stream (schema 1.1). Replaces the in-process
 * pi runner. Constructed once at the composition root with static deps; holds no
 * per-run state across calls.
 */
export class GantryRunner implements AgentRunner {
  constructor(private readonly deps: GantryRunnerDeps) {}

  async run(req: AgentRunOptions): Promise<AgentResult> {
    // 1. Resolve the model FIRST — raw aliases (`opus`) never reach the child.
    const model = resolveModel(req.model, undefined, {
      allowUnknown: this.deps.allowUnknownModel ?? false,
    });
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 2. Write the prompt to a staging dir OUTSIDE the (hostile) workdir.
    const promptDir = await mkdtemp(join(tmpdir(), 'wrily-gantry-'));
    const promptFile = join(promptDir, 'prompt.md');
    await writeFile(promptFile, req.prompt, 'utf8');

    try {
      // exit 5 (`rate_limited`) is recoverable: bounded backoff-retry of the
      // whole run, honoring the error event's `retry_after_ms` and capping the
      // total added wait by the remaining timeout budget. The `deadline` is
      // authoritative: each attempt's cap is the REMAINING budget, never a fresh
      // `timeoutMs`, so N retries can't stack into N×timeoutMs of wall time.
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 1; ; attempt++) {
        const perAttempt = Math.min(timeoutMs, deadline - Date.now());
        // Deadline already spent (a prior attempt + backoff consumed it): bail
        // as a timeout rather than spawn a child with a non-positive cap.
        if (perAttempt <= 0) throw new AgentTimeoutError(timeoutMs, '', '');
        try {
          // perAttempt feeds BOTH gantry's `--timeout-ms` and the watchdog.
          return await this.spawnAndParse(req, model, promptFile, perAttempt);
        } catch (err) {
          if (!(err instanceof AgentRateLimitedError)) throw err;
          if (attempt >= MAX_RATE_LIMIT_ATTEMPTS) throw err;
          const waitMs =
            err.retryAfterMs > 0 ? err.retryAfterMs : DEFAULT_RETRY_BACKOFF_MS * attempt;
          const remaining = deadline - Date.now();
          if (remaining <= 0 || waitMs > remaining) throw err;
          await delay(waitMs);
        }
      }
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  }

  /** One spawn + NDJSON parse cycle. Resolves on `ok`; throws the mapped error otherwise. */
  private spawnAndParse(
    req: AgentRunOptions,
    model: string,
    promptFile: string,
    timeoutMs: number,
  ): Promise<AgentResult> {
    const { binary, profileDir, hooks } = this.deps;
    const argv = buildArgv(profileDir, req, model, promptFile, timeoutMs);
    const { promise, resolve, reject } = Promise.withResolvers<AgentResult>();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, argv, { env: req.env });
    } catch (err) {
      reject(err as Error);
      return promise;
    }

    // Parser state for this attempt.
    const events: AgentEvent[] = [];
    const segments: Array<{ role: string; text: string }> = [];
    let assistantChars = 0;
    let assistantCapped = false;
    let stderrBuf = '';
    let stderrCapped = false;
    let resultEvent: ResultEvent | undefined;
    let lastError: ErrorEvent | undefined;
    let sawStart = false;

    // Settlement / lifecycle state.
    let settled = false;
    let exitCode: number | null = null;
    let streamClosed = false;
    let procClosed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let terminating = false;

    const onSigterm = (): void => {
      // 8. Forward a SIGTERM received by this process to the child.
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already gone */
      }
    };

    function terminateChild(): void {
      if (terminating) return;
      terminating = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* child already gone */
        }
      }, SIGKILL_DELAY_MS);
      killTimer.unref();
    }

    function cleanup(): void {
      clearTimeout(watchdog);
      process.removeListener('SIGTERM', onSigterm);
      // killTimer is left to fire (unref'd) so a wedged child is still reaped.
    }

    function settle(emit: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      emit();
    }

    function roleText(role: string): string {
      return segments
        .filter((s) => s.role === role)
        .map((s) => s.text)
        .join('');
    }
    /** All buffered assistant text, emission order — used for error-path `stdout`. */
    function allAssistantText(): string {
      return segments.map((s) => s.text).join('');
    }
    /** Final review text: coordinator (team) → single → all (fallback). */
    function finalAssistantText(): string {
      return roleText('coordinator') || roleText('single') || allAssistantText();
    }

    function appendAssistant(role: string, text: string): void {
      if (assistantCapped) return;
      let chunk = text;
      const room = ASSISTANT_TEXT_CAP_CHARS - assistantChars;
      if (chunk.length > room) {
        chunk = chunk.slice(0, room);
        assistantCapped = true;
        console.warn(
          `gantry: assistant_text buffer hit ${ASSISTANT_TEXT_CAP_CHARS}-char cap; further text dropped`,
        );
      }
      if (chunk.length > 0) {
        segments.push({ role, text: chunk });
        assistantChars += chunk.length;
      }
    }

    function buildOk(result: ResultEvent): AgentResult {
      const rates = ratesForSlug(model);
      const tokenUsage: AgentTokenUsage = {
        inputTokens: result.total_input,
        outputTokens: result.total_output,
        cacheReadTokens: result.total_cache_read,
        cacheWriteTokens: result.total_cache_write,
        costUsd: costForTokens(rates, {
          input: result.total_input,
          output: result.total_output,
          cacheRead: result.total_cache_read,
          cacheWrite: result.total_cache_write,
        }),
      };
      return {
        stdout: finalAssistantText(),
        stderr: stderrBuf,
        exitCode: 0,
        durationMs: result.duration_ms,
        tokenUsage,
        model,
        events,
      };
    }

    function stderrTail(): string {
      const tail = stderrBuf.trim();
      return tail ? `; stderr: ${tail.slice(-2000)}` : '';
    }

    // 6. Map the terminal `result.exit` via the full table.
    function mapResultExit(result: ResultEvent): void {
      switch (result.exit) {
        case 'ok':
          settle(() => resolve(buildOk(result)));
          return;
        case 'budget':
          settle(() => reject(new AgentBudgetExceededError(allAssistantText(), stderrBuf)));
          return;
        case 'timeout':
          settle(() => reject(new AgentTimeoutError(timeoutMs, allAssistantText(), stderrBuf)));
          return;
        case 'config':
          settle(() =>
            reject(new Error(`gantry config: ${lastError?.message ?? 'configuration error'}`)),
          );
          return;
        case 'rate_limited':
          settle(() =>
            reject(
              new AgentRateLimitedError(
                lastError?.retry_after_ms ?? 0,
                allAssistantText(),
                stderrBuf,
              ),
            ),
          );
          return;
        case 'error':
        default:
          settle(() => reject(new Error(`gantry: ${lastError?.message ?? 'run failed'}`)));
          return;
      }
    }

    // 7. EOF without a `result` event: synthesize from the process exit code via
    //    the SAME table (4→config, 5→rate_limited are not mislabelled).
    function synthesizeFromExit(code: number | null): void {
      switch (code) {
        case 2:
          settle(() => reject(new AgentBudgetExceededError(allAssistantText(), stderrBuf)));
          return;
        case 3:
          settle(() => reject(new AgentTimeoutError(timeoutMs, allAssistantText(), stderrBuf)));
          return;
        case 4:
          settle(() =>
            reject(
              new Error(
                `gantry config: ${lastError?.message ?? 'configuration error (no result event)'}`,
              ),
            ),
          );
          return;
        case 5:
          settle(() =>
            reject(
              new AgentRateLimitedError(
                lastError?.retry_after_ms ?? 0,
                allAssistantText(),
                stderrBuf,
              ),
            ),
          );
          return;
        default:
          settle(() =>
            reject(
              new Error(`gantry: exited ${code ?? 'unknown'} without a result event${stderrTail()}`),
            ),
          );
          return;
      }
    }

    function decide(): void {
      if (settled || !streamClosed || !procClosed) return;
      if (resultEvent) mapResultExit(resultEvent);
      else synthesizeFromExit(exitCode);
    }

    function handleLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        console.warn(`gantry: skipping malformed NDJSON line: ${truncateForLog(trimmed)}`);
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { event?: unknown }).event !== 'string'
      ) {
        console.warn(
          `gantry: skipping NDJSON line without an event field: ${truncateForLog(trimmed)}`,
        );
        return;
      }
      const ev = parsed as AgentEvent;
      events.push(ev);
      try {
        hooks?.onEvent?.(ev);
      } catch {
        /* observability hooks are fire-and-forget */
      }

      switch (ev.event) {
        case 'start':
          if (!sawStart) {
            sawStart = true;
            if (ev.schema_version !== SCHEMA_VERSION) {
              console.warn(
                `gantry: unexpected schema_version "${ev.schema_version}" (expected "${SCHEMA_VERSION}"); parsing best-effort`,
              );
            }
          }
          break;
        case 'assistant_text':
          appendAssistant(ev.role, ev.text);
          break;
        case 'error':
          lastError = ev;
          break;
        case 'result':
          resultEvent = ev;
          break;
        default:
          break;
      }
    }

    // 4. Watchdog: only fires for a genuinely wedged child (stream never closes).
    //    On trip → SIGTERM, SIGKILL after 5s → AgentTimeoutError.
    const watchdog = setTimeout(() => {
      terminateChild();
      settle(() => reject(new AgentTimeoutError(timeoutMs, allAssistantText(), stderrBuf)));
    }, timeoutMs + WATCHDOG_GRACE_MS);

    process.on('SIGTERM', onSigterm);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderrCapped) return;
      const room = STDERR_CAP_CHARS - stderrBuf.length;
      if (chunk.length >= room) {
        stderrBuf += chunk.slice(0, room);
        stderrCapped = true;
      } else {
        stderrBuf += chunk;
      }
    });

    // 5. Parse stdout line-by-line as NDJSON.
    const rl = createInterface({ input: child.stdout });
    rl.on('line', handleLine);
    rl.on('close', () => {
      streamClosed = true;
      decide();
    });

    child.on('error', (err) => {
      // spawn failure (e.g. binary missing) or a pipe error — not retryable.
      settle(() => reject(err));
    });
    child.on('close', (code) => {
      exitCode = code;
      procClosed = true;
      decide();
    });

    return promise;
  }
}
