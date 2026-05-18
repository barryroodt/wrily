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
});
