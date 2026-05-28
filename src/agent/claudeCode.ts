import { spawn } from 'node:child_process';
import type { AgentRunOptions, AgentResult, AgentRunner, AgentTokenUsage } from './runner.js';

type UsageBlock = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ResultEvent = {
  type: 'result';
  result?: string;
  total_cost_usd?: number;
  usage: UsageBlock;
};

function isResultEvent(o: unknown): o is ResultEvent {
  if (typeof o !== 'object' || o === null) return false;
  const obj = o as Record<string, unknown>;
  if (obj.type !== 'result') return false;
  return typeof obj.usage === 'object' && obj.usage !== null;
}

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type AssistantEvent = {
  type: 'assistant';
  parent_tool_use_id?: string | null;
  message?: {
    content?: ContentBlock[];
  };
};

function isAssistantEvent(o: unknown): o is AssistantEvent {
  if (typeof o !== 'object' || o === null) return false;
  return (o as Record<string, unknown>).type === 'assistant';
}

const JSON_FENCE_HINT = /```json/i;

function parseNdjsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

function getLastResultText(events: unknown[]): string {
  let last = '';
  for (const obj of events) {
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type !== 'result') continue;
    if (typeof rec.result === 'string' && rec.result.length > 0) {
      last = rec.result;
    }
  }
  return last;
}

function concatAssistantBlocks(
  events: unknown[],
  filter: (event: AssistantEvent) => boolean,
  includeThinking: boolean,
): string {
  const parts: string[] = [];
  for (const obj of events) {
    if (!isAssistantEvent(obj) || !filter(obj)) continue;
    for (const block of obj.message?.content ?? []) {
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
      if (includeThinking && block.type === 'thinking' && typeof block.thinking === 'string') {
        parts.push(block.thinking);
      }
    }
  }
  return parts.join('');
}

function concatStreamTextDeltas(events: unknown[]): string {
  const parts: string[] = [];
  for (const obj of events) {
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type !== 'stream_event') continue;
    const event = rec.event;
    if (typeof event !== 'object' || event === null) continue;
    const delta = (event as Record<string, unknown>).delta;
    if (typeof delta !== 'object' || delta === null) continue;
    const deltaRec = delta as Record<string, unknown>;
    if (deltaRec.type === 'text_delta' && typeof deltaRec.text === 'string') {
      parts.push(deltaRec.text);
    }
  }
  return parts.join('');
}

function pickBestReply(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate.length > 0 && JSON_FENCE_HINT.test(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (candidate.length > 0) return candidate;
  }
  return '';
}

export function parseStreamJsonUsage(stdout: string): AgentTokenUsage | null {
  const lines = stdout.split(/\r?\n/);
  let last: AgentTokenUsage | null = null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isResultEvent(obj)) continue;
    last = {
      inputTokens: obj.usage.input_tokens ?? 0,
      outputTokens: obj.usage.output_tokens ?? 0,
      cacheReadTokens: obj.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: obj.usage.cache_creation_input_tokens ?? 0,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
    };
  }
  return last;
}

/**
 * Reassemble the human-readable assistant reply from a stream-json
 * transcript. `--output-format=stream-json` emits one NDJSON event per
 * line; the model's textual output is split across one or more `assistant`
 * events, each carrying a `message.content[]` array with `text` blocks.
 * Downstream parsers (e.g. `extractFindings`) want that concatenated text,
 * not the raw event stream.
 *
 * Team-mode runs may also place the final answer in the terminal `result`
 * event, stream `text_delta` chunks, or extended-thinking blocks. Prefer
 * lead-agent output (`parent_tool_use_id == null`) over nested teammate
 * chatter, and prefer any candidate that already contains a ```json fence.
 */
export function reassembleAssistantText(stdout: string): string {
  const events = parseNdjsonLines(stdout);
  const resultText = getLastResultText(events);
  const leadWithThinking = concatAssistantBlocks(
    events,
    (event) => event.parent_tool_use_id == null,
    true,
  );
  const leadTextOnly = concatAssistantBlocks(
    events,
    (event) => event.parent_tool_use_id == null,
    false,
  );
  const allWithThinking = concatAssistantBlocks(events, () => true, true);
  const streamText = concatStreamTextDeltas(events);

  return pickBestReply(
    [resultText, leadWithThinking, leadTextOnly, allWithThinking, streamText],
  );
}

// Team-mode opus on substantial PRs runs ~10-20 min: 4-5 subagent claude calls
// in sequence + unification. Single-mode is typically <5 min. Override via
// WRILY_AGENT_TIMEOUT_MS env var when a specific run needs more headroom.
const DEFAULT_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(process.env.WRILY_AGENT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30 * 60 * 1000;
})();

/**
 * Thrown by ClaudeCodeRunner when the child claude CLI process is killed
 * because it exceeded the configured timeout. Distinguishes a forced SIGTERM
 * exit from an organic non-zero exit so the outer workflow can post a
 * timeout-specific failure comment.
 */
export class AgentTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`claude CLI timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Thrown by ClaudeCodeRunner when the child claude CLI process exits non-zero
 * AND stdout/stderr contains a budget-exceeded heuristic match. Distinguishes
 * the configured `--max-budget-usd` ceiling from a generic crash so the outer
 * workflow can post a budget-specific failure comment.
 */
export class AgentBudgetExceededError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('claude CLI budget exceeded');
    this.name = 'AgentBudgetExceededError';
  }
}

// Heuristic — Claude CLI does not currently emit a stable machine-readable
// signal for budget exhaustion. Match the human-readable wording observed in
// practice on stdout/stderr.
const BUDGET_RE = /budget (exceeded|cap reached)|max[_ \-]?budget/i;

export class ClaudeCodeRunner implements AgentRunner {
  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const args = [
      '-p', opts.prompt,
      '--model', opts.model,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (opts.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    return new Promise<AgentResult>((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd: opts.workingDir,
        env: { ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (c) => stdoutChunks.push(c));
      child.stderr.on('data', (c) => stderrChunks.push(c));

      let timedOut = false;
      let kill9: ReturnType<typeof setTimeout> | undefined;
      const clearKillTimers = () => {
        clearTimeout(killer);
        if (kill9) {
          clearTimeout(kill9);
          kill9 = undefined;
        }
      };
      const killer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        kill9 = setTimeout(() => child.kill('SIGKILL'), 30_000);
      }, timeoutMs);

      child.once('error', (err) => {
        clearKillTimers();
        reject(err);
      });
      child.once('close', (code) => {
        clearKillTimers();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const durationMs = Date.now() - start;

        if (timedOut) {
          reject(new AgentTimeoutError(timeoutMs, stdout, stderr));
          return;
        }

        if (code !== 0 && (BUDGET_RE.test(stdout) || BUDGET_RE.test(stderr))) {
          reject(new AgentBudgetExceededError(stdout, stderr));
          return;
        }

        // stream-json emits NDJSON events on stdout; downstream consumers
        // (extractFindings, debug dumpers) expect the model's textual reply.
        // Reassemble it from assistant/result/stream events. If reassembly
        // produces nothing (e.g. process died early), fall back to raw stdout
        // so failure modes still have something to look at.
        const assistantText = reassembleAssistantText(stdout);
        const effectiveStdout = assistantText.length > 0 ? assistantText : stdout;
        resolve({
          stdout: effectiveStdout, stderr, exitCode: code ?? -1, durationMs,
          tokenUsage: parseStreamJsonUsage(stdout),
        });
      });
    });
  }
}
