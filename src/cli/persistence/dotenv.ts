import { readFileSync, writeFileSync, existsSync, appendFileSync, chmodSync, statSync } from 'node:fs';

export function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function hasKey(path: string, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(readDotEnv(path), key);
}

/**
 * Restrict perms to user-only read/write. The file holds secrets
 * (SUPABASE_SERVICE_ROLE_KEY bypasses RLS = full DB admin; OAuth/API
 * tokens grant model access). Default umask on most Unix hosts produces
 * 0644 — world-readable, exploitable on shared/multi-user systems.
 * No-op on Windows (chmod is best-effort on win32; perm model differs).
 */
function tightenPerms(path: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) chmodSync(path, 0o600);
  } catch {
    // Best-effort — never fail an append because chmod is unavailable.
  }
}

export function appendDotEnv(path: string, entries: Record<string, string>): void {
  const existing = readDotEnv(path);
  for (const k of Object.keys(entries)) {
    if (k in existing) throw new Error(`Refusing to overwrite existing .env key: ${k}`);
  }
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (!existsSync(path)) {
    writeFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
    tightenPerms(path);
    return;
  }
  const current = readFileSync(path, 'utf8');
  const needsNewline = current.length > 0 && !current.endsWith('\n');
  appendFileSync(path, (needsNewline ? '\n' : '') + lines, 'utf8');
  // Existing file may have been created externally with looser perms.
  tightenPerms(path);
}
