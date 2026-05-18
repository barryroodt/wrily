import { describe, it, expect, beforeEach } from 'vitest';
import { runSupabase, requireSupabaseBinary } from '../../../src/cli/persistence/supabaseCli.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BIN = resolve(__dirname, '../../fixtures/bin');

const ORIGINAL_PATH = process.env.PATH ?? '';

describe('supabaseCli', () => {
  beforeEach(() => {
    process.env.PATH = `${FIXTURE_BIN}:${ORIGINAL_PATH}`;
    delete process.env.STUB_SUPABASE_EXIT;
    delete process.env.STUB_SUPABASE_STDOUT;
    delete process.env.STUB_SUPABASE_STDERR;
  });

  it('requireSupabaseBinary resolves when binary is on PATH', () => {
    expect(() => requireSupabaseBinary()).not.toThrow();
  });

  it('requireSupabaseBinary throws when missing', () => {
    process.env.PATH = '/nonexistent';
    expect(() => requireSupabaseBinary()).toThrow(/supabase CLI not found/);
  });

  it('runSupabase passes args and returns stdout on success', async () => {
    process.env.STUB_SUPABASE_STDOUT = '{"ok":true}';
    const out = await runSupabase(['projects', 'list', '--output', 'json']);
    expect(out.stdout.trim()).toBe('{"ok":true}');
    expect(out.exitCode).toBe(0);
  });

  it('runSupabase rejects with stderr on non-zero exit', async () => {
    process.env.STUB_SUPABASE_EXIT = '2';
    process.env.STUB_SUPABASE_STDERR = 'auth required';
    await expect(runSupabase(['projects', 'list'])).rejects.toThrow(/auth required/);
  });

  it('runSupabase propagates env overrides to the child process', async () => {
    // The stub echoes whatever STUB_SUPABASE_STDOUT is set to. Our env
    // override should win over any value inherited from process.env.
    process.env.STUB_SUPABASE_STDOUT = 'parent';
    const out = await runSupabase(['projects', 'list'], {
      env: { STUB_SUPABASE_STDOUT: 'overridden' },
    });
    expect(out.stdout.trim()).toBe('overridden');
  });

  it('runSupabase does not leak secret values into thrown error messages when passed via env', async () => {
    process.env.STUB_SUPABASE_EXIT = '1';
    process.env.STUB_SUPABASE_STDERR = 'something failed';
    await expect(
      runSupabase(['link', '--project-ref', 'abc'], {
        env: { SUPABASE_DB_PASSWORD: 'super-secret-password' },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-password'),
      }),
    );
  });

  it('runSupabase redacts values of flags listed in redactFlags from error messages', async () => {
    process.env.STUB_SUPABASE_EXIT = '1';
    process.env.STUB_SUPABASE_STDERR = 'bad';
    await expect(
      runSupabase(['projects', 'create', 'foo', '--db-password', 'sekret-pw-123', '--region', 'us-east-1'], {
        redactFlags: ['--db-password'],
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('--db-password <redacted>'),
      }),
    );
    await expect(
      runSupabase(['projects', 'create', 'foo', '--db-password', 'sekret-pw-123'], {
        redactFlags: ['--db-password'],
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sekret-pw-123'),
      }),
    );
  });
});
