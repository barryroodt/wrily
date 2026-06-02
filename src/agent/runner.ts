export type AgentRunOptions = {
  prompt: string;
  model: string;
  maxBudgetUsd?: number | null;
  workingDir: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /**
   * Optional system prompt layered on top of the agent's base prompt. Used by
   * team mode to give each reviewer session its role persona; omitted in single
   * mode (review instructions arrive via `prompt`).
   */
  systemPrompt?: string;
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
  /**
   * Canonical `provider/model` slug the run actually used (resolved from the
   * requested reference). Threaded to persistence so cost aggregation keys on a
   * single canonical form. Absent only for fakes that don't set it.
   */
  model?: string;
};

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentResult>;
}
