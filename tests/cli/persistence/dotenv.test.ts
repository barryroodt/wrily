import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readDotEnv, appendDotEnv, hasKey } from '../../../src/cli/persistence/dotenv.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('dotenv helpers', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrily-dotenv-'));
    file = join(dir, '.env');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('readDotEnv returns empty object when file missing', () => {
    expect(readDotEnv(file)).toEqual({});
  });

  it('readDotEnv parses KEY=value, skips blanks + comments', () => {
    writeFileSync(file, '# comment\nFOO=bar\n\nBAZ="quoted"\n');
    expect(readDotEnv(file)).toEqual({ FOO: 'bar', BAZ: 'quoted' });
  });

  it('hasKey returns true only when the key exists', () => {
    writeFileSync(file, 'FOO=bar\n');
    expect(hasKey(file, 'FOO')).toBe(true);
    expect(hasKey(file, 'BAR')).toBe(false);
  });

  it('appendDotEnv appends + creates trailing newline', () => {
    writeFileSync(file, 'EXISTING=1');
    appendDotEnv(file, { NEW: 'val' });
    const txt = readFileSync(file, 'utf8');
    expect(txt).toMatch(/EXISTING=1\nNEW=val\n$/);
  });

  it('appendDotEnv refuses to overwrite an existing key', () => {
    writeFileSync(file, 'FOO=bar\n');
    expect(() => appendDotEnv(file, { FOO: 'baz' })).toThrow(/FOO/);
  });

  it('appendDotEnv creates the file when missing', () => {
    expect(existsSync(file)).toBe(false);
    appendDotEnv(file, { FIRST: '1' });
    expect(readFileSync(file, 'utf8')).toBe('FIRST=1\n');
  });

  it.skipIf(process.platform === 'win32')(
    'appendDotEnv creates the file with 0600 perms',
    () => {
      appendDotEnv(file, { SECRET: 'eyJ.key' });
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'appendDotEnv tightens perms on an existing 0644 file',
    () => {
      writeFileSync(file, 'EXISTING=1\n');
      chmodSync(file, 0o644);
      appendDotEnv(file, { NEW: 'val' });
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );
});
