/**
 * Lint rules for the server side: the API and the core package. (The web app
 * has its own, through `next lint`.) Neither was linted at all.
 *
 * Kept to what catches bugs rather than what enforces taste — prettier owns
 * formatting. The two rules that earn their keep here are the promise ones: in
 * a codebase whose whole job is "do not lose a row", a promise nobody awaits is
 * an error nobody sees.
 *
 * Deliberately NOT named eslint.config.*: ESLint would pick that up from every
 * package below it, the web app included. Each linted package has its own
 * eslint.config.mjs that imports this.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @param {string} tsconfigRootDir the package being linted */
export function serverConfig(tsconfigRootDir) {
  return tseslint.config(
    {
      ignores: [
        'dist/**',
        'coverage/**',
        'node_modules/**',
        'prisma/**',
        '*.config.*',
        'eslint.config.mjs',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.ts'],
      languageOptions: {
        // its own tsconfig: the packages' build configs leave the tests out
        parserOptions: { project: ['./tsconfig.eslint.json'], tsconfigRootDir },
      },
      rules: {
        // a promise that is neither awaited, returned nor explicitly voided:
        // its rejection goes nowhere
        '@typescript-eslint/no-floating-promises': 'error',
        // an async function where a sync callback is expected (an event
        // listener, a forEach): its rejection goes nowhere either
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        // unused things are usually a refactor that stopped halfway
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'none',
            ignoreRestSiblings: true,
          },
        ],
        // `any` is a judgement call at a driver boundary; a warning, not a gate
        '@typescript-eslint/no-explicit-any': 'warn',
        // Nest's DI needs the runtime import of a class used only as a type
        '@typescript-eslint/consistent-type-imports': 'off',
        'no-console': ['error', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'no-empty': ['error', { allowEmptyCatch: true }],
      },
    },
    {
      // tests reach into private state and stub with `any` on purpose; the
      // benchmarks print their results, which is what they are for
      files: ['**/*.test.ts', '**/*.itest.ts', 'test/**/*.ts', 'bench/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/no-unsafe-function-type': 'off',
        'no-console': 'off',
      },
    },
  );
}
