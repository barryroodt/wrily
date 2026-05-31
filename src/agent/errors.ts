/**
 * Thrown when an agent run exceeds the configured timeout. Distinguishes a
 * forced kill from an organic non-zero exit so the outer workflow can post a
 * timeout-specific failure comment.
 */
export class AgentTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`Agent timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Thrown when an agent run hits its budget ceiling. Distinguishes budget
 * exhaustion from a generic crash so the outer workflow can post a
 * budget-specific failure comment.
 */
export class AgentBudgetExceededError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('Agent budget exceeded');
    this.name = 'AgentBudgetExceededError';
  }
}

/**
 * Thrown when the sidecar reports a configuration error (missing API key,
 * unroutable model, bad workdir/prompt) — surfaced as `error{kind:"config"}`
 * and/or process exit code 4. Distinguished from a generic crash so the outer
 * workflow can post a config-specific failure comment instead of retrying.
 */
export class ConfigError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    message = 'Agent configuration error',
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
