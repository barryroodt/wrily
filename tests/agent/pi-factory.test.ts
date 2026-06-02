import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { defaultPiSessionFactory } from '../../src/agent/pi.js';
import type { AgentRunOptions } from '../../src/agent/runner.js';
import { loadRolePrompt } from '../../src/workflow/teamRoles.js';

// Exercises the REAL pi wiring (createAgentSession + in-memory auth/registry/
// session/settings + resource loader) without a network call: a dummy provider
// key lets the session construct; prompt() is never invoked. Guards the live
// integration that the fake-based PiRunner tests cannot cover.
const cwd = mkdtempSync(join(tmpdir(), 'pi-factory-test-'));

function opts(over: Partial<AgentRunOptions>): AgentRunOptions {
  return {
    prompt: 'noop',
    model: 'opus',
    workingDir: cwd,
    env: { ANTHROPIC_API_KEY: 'dummy-key' },
    ...over,
  };
}

// The handle types `session` as the narrow PiSession; the concrete object is a
// full AgentSession. Cast to read the richer surface the wiring assertions need.
function asAgentSession(session: { dispose(): void }): AgentSession {
  return session as unknown as AgentSession;
}

describe('defaultPiSessionFactory (real pi wiring, no network)', () => {
  it('resolves an alias to its canonical slug and exposes only the read-only tools', async () => {
    const { session, model } = await defaultPiSessionFactory(opts({ model: 'opus' }));
    try {
      expect(model).toBe('anthropic/claude-opus-4-8');
      expect(asAgentSession(session).getActiveToolNames().sort()).toEqual([
        'bash',
        'find',
        'grep',
        'ls',
        'read',
      ]);
    } finally {
      session.dispose();
    }
  });

  it('honors a non-anthropic provider/model slug (provider-agnostic)', async () => {
    const { session, model } = await defaultPiSessionFactory(
      opts({ model: 'openai/gpt-4o', env: { OPENAI_API_KEY: 'dummy-key' } }),
    );
    try {
      expect(model).toBe('openai/gpt-4o');
    } finally {
      session.dispose();
    }
  });

  it('layers the team role persona into the system prompt (appendSystemPrompt resolves)', async () => {
    const role = loadRolePrompt('correctness');
    const { session } = await defaultPiSessionFactory(opts({ systemPrompt: role }));
    try {
      expect(asAgentSession(session).systemPrompt).toContain('Correctness Reviewer');
    } finally {
      session.dispose();
    }
  });

  it('adds no role persona in single mode (no systemPrompt)', async () => {
    const { session } = await defaultPiSessionFactory(opts({}));
    try {
      expect(asAgentSession(session).systemPrompt).not.toContain('Correctness Reviewer');
    } finally {
      session.dispose();
    }
  });
});
