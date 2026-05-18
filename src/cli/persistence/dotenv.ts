import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

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

export function appendDotEnv(path: string, entries: Record<string, string>): void {
  const existing = readDotEnv(path);
  for (const k of Object.keys(entries)) {
    if (k in existing) throw new Error(`Refusing to overwrite existing .env key: ${k}`);
  }
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (!existsSync(path)) {
    writeFileSync(path, lines, 'utf8');
    return;
  }
  const current = readFileSync(path, 'utf8');
  const needsNewline = current.length > 0 && !current.endsWith('\n');
  appendFileSync(path, (needsNewline ? '\n' : '') + lines, 'utf8');
}
