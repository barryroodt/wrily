import { describe, it, expect } from 'vitest';
import { FakeAgentRunner } from '../../src/agent/fake.js';

describe('FakeAgentRunner', () => {
  it('returns the canned result on run()', async () => {
    const runner = new FakeAgentRunner({
      stdout: 'canned',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
    });
    const out = await runner.run({ prompt: 'x', model: 'opus', workingDir: '/tmp', env: {} });
    expect(out.stdout).toBe('canned');
    expect(out.exitCode).toBe(0);
  });

  it('records the prompt that was passed', async () => {
    const runner = new FakeAgentRunner({ stdout: '', stderr: '', exitCode: 0, durationMs: 0, tokenUsage: null });
    await runner.run({ prompt: 'hello', model: 'opus', workingDir: '/tmp', env: {} });
    expect(runner.calls[0]?.prompt).toBe('hello');
  });

  it('throws when configured to', async () => {
    const runner = new FakeAgentRunner(new Error('boom'));
    await expect(
      runner.run({ prompt: 'x', model: 'opus', workingDir: '/tmp', env: {} }),
    ).rejects.toThrow('boom');
  });
});
