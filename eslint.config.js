// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/coverage/**']),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    // Server-side workspaces.
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    // Browser workspace. The hooks rules are the point of having a linter here at all:
    // they catch the class of bug (stale closures, conditional hooks, state read during
    // render) that is invisible in review and only shows up as a wrong screen.
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `noUncheckedIndexedAccess` is on, so indexing returns `T | undefined`. A `!` after
      // an index we have just proven is in range is the intended escape hatch, not a smell.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },

  {
    // Tests may lean on non-null assertions and fixtures more freely.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  prettier,
]);
