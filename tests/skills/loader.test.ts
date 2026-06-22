import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSkills, removeSkill } from '../../src/skills/loader.js';

describe('stageSkills', () => {
  let root: string;
  let srcA: string;
  let srcB: string;
  let staging: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-'));
    srcA = join(root, 'src-a', 'caveman-review');
    srcB = join(root, 'src-b', 'code-review');
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, 'SKILL.md'), '# caveman');
    writeFileSync(join(srcB, 'SKILL.md'), '# code-review');
    staging = join(root, 'staging');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies each source skill dir into the staging dir by basename', async () => {
    await stageSkills([srcA, srcB], staging);
    expect(readFileSync(join(staging, 'caveman-review', 'SKILL.md'), 'utf8')).toBe('# caveman');
    expect(readFileSync(join(staging, 'code-review', 'SKILL.md'), 'utf8')).toBe('# code-review');
  });

  it('creates the staging dir if it does not exist', async () => {
    expect(existsSync(staging)).toBe(false);
    await stageSkills([srcA], staging);
    expect(existsSync(join(staging, 'caveman-review', 'SKILL.md'))).toBe(true);
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
