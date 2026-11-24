import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'coverage', '.tmp']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.strict],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Parsers index into bytes after checking lengths; `noUncheckedIndexedAccess` makes every access
      // possibly undefined, and a `?? 0` at each would hide real errors behind a default.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The library runs in browsers and Node: only standard APIs, no node: imports, no I/O.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', '**/relay/*'], message: 'Library core: standard APIs only.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'fetch', 'process', 'Buffer', 'require'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
]);
