import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// node environment is enough: the web tests cover pure functions (no DOM)
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // mirror the "@/*" path alias from tsconfig.json
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
