import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeSkills, removeSkill } from '../../src/skills/loader.js';

describe('bridgeSkills', () => {
  let src: string;
  let dest: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    src = join(root, 'src');
    dest = join(root, 'dest');
    mkdirSync(src);
    mkdirSync(join(src, 'caveman-review'));
    writeFileSync(join(src, 'caveman-review', 'SKILL.md'), '# caveman');
  });

  afterEach(() => {
    rmSync(join(src, '..'), { recursive: true, force: true });
  });

  it('copies skills from src to dest', async () => {
    await bridgeSkills(src, dest);
    expect(existsSync(join(dest, 'caveman-review', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'caveman-review', 'SKILL.md'), 'utf8')).toBe('# caveman');
  });

  it('preserves existing dest files (cp -n equivalent)', async () => {
    mkdirSync(dest);
    mkdirSync(join(dest, 'caveman-review'));
    writeFileSync(join(dest, 'caveman-review', 'SKILL.md'), '# preserved');
    await bridgeSkills(src, dest);
    expect(readFileSync(join(dest, 'caveman-review', 'SKILL.md'), 'utf8')).toBe('# preserved');
  });
});

describe('removeSkill', () => {
  it('removes a skill directory if present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-rm-'));
    mkdirSync(join(root, 'caveman-review'));
    writeFileSync(join(root, 'caveman-review', 'SKILL.md'), 'x');

    await removeSkill(root, 'caveman-review');
    expect(existsSync(join(root, 'caveman-review'))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op if the skill does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-rm2-'));
    await expect(removeSkill(root, 'nonexistent')).resolves.toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
