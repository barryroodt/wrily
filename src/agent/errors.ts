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
