import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSteps, type WorkflowDeps } from '../../src/workflow/steps.js';
import type { WorkflowState } from '../../src/workflow/state.js';

// stageSkillsStep assembles a fresh per-run mkdtemp staging dir that gantry is
// pointed at via --skills-dir: the four invariant review guards copied from
// wrily's own (trusted) install tree, plus name-validated user skills from the
// shared-repo clone. The PR checkout is treated as hostile, so a user skill that
// collides with an invariant name MUST be rejected — .wrily.yml can never shadow
// the review guards. These tests pin that step logic; no gantry binary involved.

const INVARIANTS = ['agent-team-review', 'code-review', 'confidence-rating', 'caveman-review'];

// stageSkillsStep touches none of these deps — trivial stand-ins suffice.
const deps = {
  agentRunner: {
    run: async () => {
      throw new Error('agentRunner is not exercised by stageSkillsStep');
    },
  },
  octokit: { rest: {} },
  graphqlClient: { graphql: async () => ({}) },
} as unknown as WorkflowDeps;

const stageSkillsStep = makeSteps(deps).stageSkillsStep;

function makeSkillDir(root: string, name: string, body = `# ${name}`): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), body);
}

function cfg(shared_skills: string[]): WorkflowState['cfg'] {
  return {
    model: 'opus',
    mode: 'team',
    team_threshold: 5,
    team_threshold_unit: 'files',
    max_tokens: null,
    ignore: [],
    shared_skills,
    request_changes: false,
    style: 'terse',
    sensitivity: 'minor',
    reply_feedback: 'off',
  };
}

let root: string;
let installRoot: string;
let sharedRoot: string;
let prevSkillsDir: string | undefined;
const stagingDirs: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wrily-skills-test-'));
  installRoot = join(root, 'install-skills');
  sharedRoot = join(root, 'shared');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(join(sharedRoot, 'skills'), { recursive: true });
  for (const name of INVARIANTS) makeSkillDir(installRoot, name);
  // Point wrilyInstallSkillsDir() at our controlled install tree so the test is
  // hermetic (doesn't break when the real skills/ tree changes).
  prevSkillsDir = process.env.WRILY_SKILLS_DIR;
  process.env.WRILY_SKILLS_DIR = installRoot;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (prevSkillsDir === undefined) delete process.env.WRILY_SKILLS_DIR;
  else process.env.WRILY_SKILLS_DIR = prevSkillsDir;
  for (const d of stagingDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runStage(state: Partial<WorkflowState>): Promise<WorkflowState> {
  const out = (await stageSkillsStep.execute({ inputData: state } as never)) as WorkflowState;
  if (out.skillsStagingDir) stagingDirs.push(out.skillsStagingDir);
  return out;
}

describe('stageSkillsStep', () => {
  it('stages the four invariant skills from the install tree into a fresh dir', async () => {
    const out = await runStage({ cfg: cfg([]), sharedPath: null });

    expect(out.skillsStagingDir).toBeTruthy();
    // Staged into a *separate* dir, never the install tree or the checkout.
    expect(out.skillsStagingDir).not.toBe(installRoot);

    for (const name of INVARIANTS) {
      expect(existsSync(join(out.skillsStagingDir!, name, 'SKILL.md'))).toBe(true);
    }
    // Exactly the invariant set — no stray entries when there are no user skills.
    expect(readdirSync(out.skillsStagingDir!).sort()).toEqual([...INVARIANTS].sort());
    // loadedSkills is the USER-skill list (--inject-skill); empty here.
    expect(out.loadedSkills).toEqual([]);
  });

  it('rejects a user skill whose name collides with an invariant skill', async () => {
    // Attacker-controlled shared repo ships a shadow of an invariant guard plus a
    // legit custom skill.
    makeSkillDir(join(sharedRoot, 'skills'), 'code-review', '# EVIL shadow guard');
    makeSkillDir(join(sharedRoot, 'skills'), 'house-style');

    const out = await runStage({
      cfg: cfg(['code-review', 'house-style']),
      sharedPath: sharedRoot,
    });

    // Collision rejected: the shadow never reaches the --inject-skill list.
    expect(out.loadedSkills).toEqual(['house-style']);
    expect(out.loadedSkills).not.toContain('code-review');

    // The staged code-review is the trusted INVARIANT copy, not the user shadow.
    expect(readFileSync(join(out.skillsStagingDir!, 'code-review', 'SKILL.md'), 'utf8')).toBe(
      '# code-review',
    );
    // The non-colliding user skill is staged alongside the invariants.
    expect(existsSync(join(out.skillsStagingDir!, 'house-style', 'SKILL.md'))).toBe(true);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('collides with an invariant skill'),
    );
  });

  it('uses a fresh staging dir per run', async () => {
    const a = await runStage({ cfg: cfg([]), sharedPath: null });
    const b = await runStage({ cfg: cfg([]), sharedPath: null });

    expect(a.skillsStagingDir).not.toBe(b.skillsStagingDir);
    expect(existsSync(a.skillsStagingDir!)).toBe(true);
    expect(existsSync(b.skillsStagingDir!)).toBe(true);
  });
});
