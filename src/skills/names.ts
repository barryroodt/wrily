const SHARED_SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function isValidSharedSkillName(name: string): boolean {
  return SHARED_SKILL_NAME_RE.test(name);
}
