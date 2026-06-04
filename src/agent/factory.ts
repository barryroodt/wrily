import type { AgentRunner } from './runner.js';
import { PiRunner } from './pi.js';

/**
 * Select the agent runner for a model reference. Wrily is provider-agnostic:
 * a single in-process pi runner serves every provider/model, and pi validates
 * the model (and its auth) at run time, so the reference is not inspected here.
 */
export function selectRunner(_model: string): AgentRunner {
  return new PiRunner();
}
