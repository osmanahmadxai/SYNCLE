import { defineConfig } from 'vitest/config';

/**
 * Coverage floors, not targets. They sit just under what the suite covers
 * today, so that a change which drops a module's tests fails CI instead of
 * quietly lowering a number nobody looks at. Raise them when coverage rises.
 *
 * Lines look low because the adapters talk to real databases and are covered
 * by the API's integration suite, which is not counted here.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 52,
        statements: 52,
        functions: 69,
        branches: 81,
      },
    },
  },
});
