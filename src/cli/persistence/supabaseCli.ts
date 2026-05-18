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
  /**
   * When true, the child inherits the parent's stdio. Use this for
   * interactive subcommands like `supabase login` that need a real TTY to
   * detect terminal capabilities and drive prompts / browser handoff.
   * Defaults to false — stdout/stderr are captured so callers can parse
   * `--output json` payloads.
   */
  interactive?: boolean;
  /**
   * Flag names whose immediately-following value should be replaced with
   * `<redacted>` before the args are interpolated into an error message.
   * Use for sensitive flags like `--db-password` that the supabase CLI
   * insists on receiving via argv. The value is still passed to the child
   * process unchanged — only error-message exposure is suppressed.
   */
  redactFlags?: string[];
};

function redactArgsForError(args: string[], redactFlags: string[]): string {
  if (redactFlags.length === 0) return args.join(' ');
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (redactFlags.includes(out[i]!)) out[i + 1] = '<redacted>';
  }
  return out.join(' ');
}

export function runSupabase(args: string[], opts: SupabaseRunOptions = {}): Promise<SupabaseRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const interactive = opts.interactive === true;
    const child = spawn('supabase', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    if (!interactive) {
      child.stdout!.on('data', (c) => outChunks.push(c));
      child.stderr!.on('data', (c) => errChunks.push(c));
    }
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      const stdout = interactive ? '' : Buffer.concat(outChunks).toString('utf8');
      const stderr = interactive ? '' : Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        const safeArgs = redactArgsForError(args, opts.redactFlags ?? []);
        rejectPromise(new Error(`supabase ${safeArgs} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    if (!interactive) {
      if (opts.input) {
        child.stdin!.end(opts.input);
      } else {
        child.stdin!.end();
      }
    }
  });
}
