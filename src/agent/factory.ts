import type { AgentRunner } from './runner.js';
import { ClaudeCodeRunner } from './claudeCode.js';
import { CodexRunner } from './codex.js';

export function selectRunner(model: string): AgentRunner {
  const lower = model.toLowerCase();
  if (lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku') || lower.startsWith('claude')) {
    return new ClaudeCodeRunner();
  }
  if (lower.startsWith('gpt') || lower.includes('codex')) {
    return new CodexRunner();
  }
  throw new Error(`Unknown model "${model}" — cannot select agent runner.`);
}
