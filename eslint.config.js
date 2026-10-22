import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.remember'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // Core harus netral platform (lihat CLAUDE.md).
      'no-restricted-imports': ['error', { patterns: ['discord.js', 'discord.js/*', '@whiskeysockets/baileys', '**/adapters/**'] }],
    },
  },
);
