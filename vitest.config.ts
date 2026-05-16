import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // vitest 2.1.2 exits non-zero on an empty test set; we hit this
    // legitimately during Phase 0 scaffolding before any tests exist.
    // Removing this once Phase 1 lands real tests would be fine.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
