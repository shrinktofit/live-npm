import { defineConfig, globalIgnores } from 'eslint/config';
import stf from '@shrinktofit/eslint-config';
import node from '@shrinktofit/eslint-config/node';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  globalIgnores([
    'node_modules',
    'dist',
    '**/dist/**',
    'packages/*/lib',
    'coverage',
  ]),
  {
    settings: {
      node: {
        version: '>=22.0.0',
      },
    },
  },
  ...stf.configs.recommended,
  ...node.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir,
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
          ],
        },
      },
    },
  },
  {
    rules: {
      'n/no-extraneous-import': 'off',
      'n/no-unpublished-import': 'off',
    },
  },
  {
    files: ['packages/cli/src/cli.ts'],
    rules: {
      'n/hashbang': 'off',
    },
  },
]);
