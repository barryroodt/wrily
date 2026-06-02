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

/**
 * Fake runner that returns a distinct response per call, in order. Used by
 * team-mode tests where one workflow run issues N reviewer calls + 1 unify call.
 * Throws if called more times than responses were provided, surfacing an
 * unexpected extra call rather than silently reusing a response.
 */
export class SequenceFakeAgentRunner implements AgentRunner {
  public readonly calls: AgentRunOptions[] = [];
  private index = 0;

  constructor(private readonly responses: ReadonlyArray<AgentResult | Error>) {}

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    this.calls.push(opts);
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) {
      throw new Error(
        `SequenceFakeAgentRunner: no response for call #${this.index} (only ${this.responses.length} provided)`,
      );
    }
    if (response instanceof Error) throw response;
    return response;
  }
}
