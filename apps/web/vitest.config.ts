import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// node environment is enough: the web tests cover pure functions, and the few
// that render a component do it to a string (react-dom/server), with no DOM
export default defineConfig({
  // tsconfig says `jsx: preserve` because Next compiles it; here nothing else will
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      // mirror the "@/*" path alias from tsconfig.json
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
