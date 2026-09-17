import { defineConfig } from 'vitest/config';

/**
 * The UNIT suite (`pnpm test`): everything that matches *.test.ts and needs no
 * database. The end-to-end suite has its own config (vitest.integration.config)
 * and its own `.itest.ts` suffix, so neither picks up the other's files.
 *
 * Coverage floors, not targets: just under what the unit suite covers today, so
 * a change that drops tests fails CI. Lines look low because the services that
 * talk to databases, Redis and the network are covered by the integration
 * suite, which is not counted here.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: {
        lines: 35,
        statements: 35,
        functions: 73,
        branches: 77,
      },
    },
  },
});
