import type { AgentRunOptions, AgentResult, AgentRunner } from './runner.js';

export class FakeAgentRunner implements AgentRunner {
  public readonly calls: AgentRunOptions[] = [];

  constructor(private readonly response: AgentResult | Error) {}

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.calls.push(opts);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}
