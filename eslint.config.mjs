import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SERVER_ONLY_RESTRICTED_IMPORTS = {
  patterns: [
    {
      group: ['**/server/**', '@server/*', '../server/*', '../../server/*', 'server'],
      message: 'Browser code must never import server-only modules.',
    },
  ],
  paths: [
    { name: 'postgres', message: 'Database drivers cannot be imported in client code.' },
    { name: 'drizzle-orm', message: 'ORM modules cannot be imported in client code.' },
    { name: 'drizzle-kit', message: 'Migration tooling cannot be imported in client code.' },
    { name: '@google/genai', message: 'Gemini AI SDK must only run server-side.' },
    { name: 'dotenv', message: 'Environment loaders cannot be imported in client code.' },
    { name: 'express', message: 'Express server cannot be imported in client code.' },
    { name: 'helmet', message: 'Server security middleware cannot be imported in client code.' },
    { name: 'cors', message: 'Server CORS middleware cannot be imported in client code.' },
    { name: 'express-rate-limit', message: 'Server rate limiter cannot be imported in client code.' },
    { name: 'pino', message: 'Server logger cannot be imported in client code.' },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'bun.lock'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', SERVER_ONLY_RESTRICTED_IMPORTS],
    },
  },
  {
    files: [
      'server.ts',
      'src/server/**/*.ts',
      'tests/**/*.ts',
      'vite.config.ts',
      'vitest.config.ts',
      'drizzle.config.ts',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/client/**', '@/*', '../client/*', '../../client/*'],
              message: 'Server modules must not import browser client modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/client/**', '**/server/**', '@/*', '@server/*'],
              message: 'Shared schemas/types must remain pure and environment-agnostic.',
            },
          ],
        },
      ],
    },
  },
);
