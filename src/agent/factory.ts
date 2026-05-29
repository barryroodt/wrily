import type { AgentRunner } from './runner.js';
import { RigRunner } from './rig.js';

export function selectRunner(_model: string): AgentRunner {
  return new RigRunner();
}
