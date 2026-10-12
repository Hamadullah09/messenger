// Flat ESLint config for the whole monorepo.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'e2e/report/**',
      'e2e/results/**',
      '**/*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      // NestJS needs runtime class references for dependency injection metadata.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // Command-line tools report progress on stdout.
    files: ['apps/api/prisma/*.ts', 'apps/api/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Node CommonJS maintenance scripts.
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
);
