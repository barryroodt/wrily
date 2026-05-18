import { spawn, execFileSync } from 'node:child_process';

export class SupabaseCliMissingError extends Error {
  constructor() {
    super('supabase CLI not found on PATH. Install with `brew install supabase/tap/supabase` or `npm i -g supabase`.');
    this.name = 'SupabaseCliMissingError';
  }
}

export function requireSupabaseBinary(): void {
  try {
    execFileSync('/bin/bash', ['-c', 'command -v supabase'], { stdio: 'ignore' });
  } catch {
    throw new SupabaseCliMissingError();
  }
}

export type SupabaseRunResult = { stdout: string; stderr: string; exitCode: number };

export type SupabaseRunOptions = {
  cwd?: string;
  input?: string;
  /**
   * Extra env vars merged into the child process. Use this to pass secrets
   * (e.g. SUPABASE_DB_PASSWORD) without exposing them on the argv, which is
   * visible to other users via `ps` and would otherwise leak into error
   * messages built from `args.join(' ')`.
   */
  env?: Record<string, string>;
};

export function runSupabase(args: string[], opts: SupabaseRunOptions = {}): Promise<SupabaseRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('supabase', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        rejectPromise(new Error(`supabase ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    if (opts.input) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}
