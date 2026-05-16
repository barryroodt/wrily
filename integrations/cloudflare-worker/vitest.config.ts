import { defineConfig } from "vitest/config";

// Local config — the worker's test files live in `test/`, not the
// repo-root `tests/` directory. Without this, vitest picks up the parent
// vitest.config.ts (in the auto-reviewer root) whose include glob targets
// `tests/**/*.test.ts` and discovers nothing here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
