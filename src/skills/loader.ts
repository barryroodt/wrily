import { mkdir, cp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function bridgeSkills(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
}

export async function removeSkill(skillsDir: string, skillName: string): Promise<void> {
  const target = join(skillsDir, skillName);
  try {
    await stat(target);
  } catch {
    return;
  }
  await rm(target, { recursive: true, force: true });
}
