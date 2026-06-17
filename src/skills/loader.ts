import { mkdir, cp, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Copy each source skill directory into a per-run staging dir, keeping its
 * basename as the skill name. The staging dir is a fresh `mkdtemp`, so no
 * overwrite/collision flags are needed at the FS level; name-collision policy
 * (user skill vs. invariant) lives in the workflow step that calls this.
 */
export async function stageSkills(sources: string[], stagingDir: string): Promise<void> {
  await mkdir(stagingDir, { recursive: true });
  for (const src of sources) {
    await cp(src, join(stagingDir, basename(src)), { recursive: true });
  }
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
