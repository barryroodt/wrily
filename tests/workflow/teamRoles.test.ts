import { describe, it, expect } from 'vitest';
import {
  composeTeam,
  loadRolePrompt,
  buildReviewerSystemPrompt,
  type TeamRole,
} from '../../src/workflow/teamRoles.js';

describe('composeTeam', () => {
  it('always includes the base trio in order', () => {
    expect(composeTeam([])).toEqual(['correctness', 'conventions', 'spec-compliance']);
  });

  it('adds the typescript specialist for .ts / package.json / tsconfig', () => {
    expect(composeTeam(['src/a.ts'])).toContain('typescript-specialist');
    expect(composeTeam(['src/a.tsx'])).toContain('typescript-specialist');
    expect(composeTeam(['package.json'])).toContain('typescript-specialist');
    expect(composeTeam(['tsconfig.build.json'])).toContain('typescript-specialist');
  });

  it('adds the go specialist for .go files', () => {
    expect(composeTeam(['main.go'])).toContain('go-specialist');
    expect(composeTeam(['src/x.ts'])).not.toContain('go-specialist');
  });

  it('adds contracts only when more than one top-level directory changes', () => {
    expect(composeTeam(['src/a.ts'])).not.toContain('contracts'); // single dir
    expect(composeTeam(['src/a.ts', 'src/b.ts'])).not.toContain('contracts'); // same dir
    expect(composeTeam(['src/a.ts', 'pkg/b.go'])).toContain('contracts'); // two dirs
    expect(composeTeam(['README.md', 'docs/x.md'])).toContain('contracts'); // root + docs
  });

  it('composes the full roster for a multi-dir multi-language change', () => {
    expect(composeTeam(['src/a.ts', 'pkg/b.go'])).toEqual([
      'correctness',
      'conventions',
      'spec-compliance',
      'go-specialist',
      'typescript-specialist',
      'contracts',
    ]);
  });
});

describe('loadRolePrompt', () => {
  const roles: TeamRole[] = [
    'correctness',
    'conventions',
    'spec-compliance',
    'go-specialist',
    'typescript-specialist',
    'contracts',
  ];

  it('loads every roster role template as non-empty text', () => {
    for (const role of roles) {
      expect(loadRolePrompt(role).length).toBeGreaterThan(0);
    }
  });

  it('loads the correctness reviewer persona', () => {
    expect(loadRolePrompt('correctness')).toMatch(/correctness/i);
  });
});

describe('buildReviewerSystemPrompt', () => {
  it('prepends the read-only + JSON-output guard to the role brief', () => {
    const sp = buildReviewerSystemPrompt('correctness');
    expect(sp).toContain('READ-ONLY');
    expect(sp).toMatch(/Do NOT execute any command/i);
    expect(sp).toMatch(/one ```json fenced block/);
    expect(sp).toMatch(/correctness/i); // role brief still included
  });

  it('places the no-run-commands guard BEFORE the conventions Run-CI mandate so it overrides', () => {
    const sp = buildReviewerSystemPrompt('conventions');
    const guardIdx = sp.indexOf('Do NOT execute any command');
    const runCiIdx = sp.search(/Run CI|execute the CI commands/i);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(runCiIdx).toBeGreaterThan(guardIdx);
  });
});
