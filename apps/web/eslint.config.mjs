/**
 * Lint rules for the web app: Next's own Core Web Vitals set, run by the ESLint
 * CLI. (`next lint` read the old .eslintrc format and is gone in Next 16;
 * eslint-config-next 16 only ships flat configs.)
 */
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    // new in eslint-plugin-react-hooks 7, written for the React Compiler, which
    // this app doesn't use. The places they flag work today; rewriting them is
    // its own change, so they warn here rather than fail the build.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  // what `next lint` skipped on its own
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'next-env.d.ts',
    'public/**',
  ]),
]);
