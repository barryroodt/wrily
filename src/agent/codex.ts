import type { AgentRunOptions, AgentResult, AgentRunner } from './runner.js';

export class CodexRunner implements AgentRunner {
  async run(_opts: AgentRunOptions): Promise<AgentResult> {
    throw new Error('CodexRunner not yet implemented (out of scope)');
  }
}
