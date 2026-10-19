import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, THREE: 'readonly', JSZip: 'readonly' },
    },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
  },
  {
    ignores: [
      'index.html',
      'node_modules/**',
      'tests/fixtures/**',
      '.superpowers/**',
      'probe/**',
      'forge/**',
    ],
  },
];
