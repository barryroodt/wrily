import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentBudgetExceededError,
  AgentTimeoutError,
} from './claudeCode.js';
import type { AgentResult, AgentRunOptions, AgentRunner, AgentTokenUsage } from './runner.js';

type WrilyEvent =
  | { event: 'start'; ts: number; model: string; provider: string; mode: string; workdir: string }
  | { event: 'skill_loaded'; ts: number; name: string; source: 'auto' | 'lazy' | 'workdir' | 'bundled'; bytes: number }
  | { event: 'agent_turn'; ts: number; role: string; turn: number; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number }
  | { event: 'tool_call'; ts: number; role: string; turn: number; tool: string; args: string }
  | { event: 'tool_result'; ts: number; role: string; turn: number; tool: string; bytes: number; truncated: boolean; error?: string }
  | { event: 'subagent_spawn'; ts: number; name: string; template: string; scope: string }
  | { event: 'subagent_done'; ts: number; name: string; turns: number; input_tokens: number; output_tokens: number }
  | { event: 'assistant_text'; ts: number; role: string; text: string }
  | { event: 'budget_exceeded'; ts: number; limit: number; total: number }
  | { event: 'error'; ts: number; kind: 'config' | 'provider' | 'team_collapse' | 'internal'; message: string }
  | { event: 'result'; ts: number; exit: 'ok' | 'budget' | 'timeout' | 'error' | 'config'; total_input: number; total_output: number; total_cache_read: number; total_cache_write: number; duration_ms: number };

const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_TIMEOUT_MS = 600_000;

function parseNdjson(stdout: string): WrilyEvent[] {
  const events: WrilyEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as WrilyEvent);
    } catch {
      // tolerate malformed lines
    }
  }
  return events;
}

function collectAssistantText(events: WrilyEvent[]): string {
  return events
    .filter((e): e is Extract<WrilyEvent, { event: 'assistant_text' }> => e.event === 'assistant_text')
    .map((e) => e.text)
    .join('\n');
}

function tokenUsageFromTerminal(
  terminal: Extract<WrilyEvent, { event: 'result' }>,
): AgentTokenUsage {
  return {
    inputTokens: terminal.total_input,
    outputTokens: terminal.total_output,
    cacheReadTokens: terminal.total_cache_read,
    cacheWriteTokens: terminal.total_cache_write,
  };
}

export type RigRunnerConfig = {
  binaryPath?: string;
  mode?: 'single' | 'team';
  provider?: string;
  maxTokens?: number;
};

export class RigRunner implements AgentRunner {
  private readonly binaryPath: string;
  private readonly mode: 'single' | 'team';
  private readonly provider?: string;
  private readonly maxTokens: number;

  constructor(config: RigRunnerConfig = {}) {
    this.binaryPath = config.binaryPath ?? 'wrily-rig';
    this.mode = config.mode ?? 'single';
    this.provider = config.provider;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'wrily-rig-'));
    const promptFile = join(tmpDir, 'prompt.txt');
    await writeFile(promptFile, opts.prompt, 'utf8');

    try {
      return await this.runBinary(opts, promptFile);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async runBinary(opts: AgentRunOptions, promptFile: string): Promise<AgentResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = [
      '--mode', this.mode,
      '--model', opts.model,
      '--workdir', opts.workingDir,
      '--prompt-file', promptFile,
      '--max-tokens', String(this.maxTokens),
      '--timeout-ms', String(timeoutMs),
    ];
    if (this.provider) {
      args.push('--provider', this.provider);
    }

    const child = spawn(this.binaryPath, args, {
      cwd: opts.workingDir,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    let stderrText = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });

    const stdout = stdoutChunks.join('');
    const events = parseNdjson(stdout);
    let terminal: Extract<WrilyEvent, { event: 'result' }> | undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.event === 'result') {
        terminal = e;
        break;
      }
    }
    const assistantText = collectAssistantText(events);

    if (terminal?.exit === 'budget') {
      throw new AgentBudgetExceededError(stdout, stderrText);
    }
    if (terminal?.exit === 'timeout') {
      throw new AgentTimeoutError(timeoutMs, stdout, stderrText);
    }
    if (exitCode !== 0 || !terminal || terminal.exit !== 'ok') {
      throw new Error(`wrily-rig exited with code ${exitCode}: ${stderrText}\n${stdout}`);
    }

    return {
      stdout: assistantText,
      stderr: stderrText,
      exitCode: 0,
      durationMs: terminal.duration_ms,
      tokenUsage: tokenUsageFromTerminal(terminal),
    };
  }
}
