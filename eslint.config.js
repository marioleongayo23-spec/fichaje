import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'supabase/functions/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['tests/**/*.ts', '*.config.{js,ts}', 'scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['src/**/*.{ts,tsx}'], rules: { 'no-console': 'error' } },
  // H7 Cloudflare Pages Functions: worker runtime, never logs.
  { files: ['edge/**/*.ts', 'functions/**/*.ts'], languageOptions: { globals: globals.worker }, rules: { 'no-console': 'error' } },
);
