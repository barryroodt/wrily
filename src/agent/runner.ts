export type AgentRunOptions = {
  prompt: string;
  model: string;
  maxBudgetUsd?: number | null;
  workingDir: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type AgentTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

export type AgentResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  tokenUsage: AgentTokenUsage | null;
};

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentResult>;
}
