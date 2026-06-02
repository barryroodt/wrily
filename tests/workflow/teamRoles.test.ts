import { describe, it, expect } from 'vitest';
import { composeTeam, loadRolePrompt, type TeamRole } from '../../src/workflow/teamRoles.js';

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
