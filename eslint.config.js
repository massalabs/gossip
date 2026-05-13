import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'gossip-sdk/dist',
      'src/assets/generated',
      'gossip-sdk/src/assets/generated',
      'android/**',
      'ios/**',
      '.worktrees/**',
      '.claude/worktrees/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `Comlink.transfer` detaches the source ArrayBuffer on this side
      // as soon as the call dispatches. That's intentional only when
      // the caller is DONE with the bytes (e.g. zeroizing a password
      // *after* checking byteLength === 0). For SQL bind params it's
      // a recurring source of "Cannot perform values on a detached
      // ArrayBuffer" because Drizzle / event listeners keep references
      // to the params after the SQL call. Force a justification at
      // every introduction site:
      //
      //   // eslint-disable-next-line no-restricted-syntax -- ALLOWED-TRANSFER: <reason>
      //   await proxy.unlock(Comlink.transfer(pwBytes, [pwBytes.buffer]));
      //
      // The rule fires on `Comlink.transfer(...)` regardless of how
      // it's imported, by matching the property access shape.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='Comlink'][callee.property.name='transfer']",
          message:
            'Comlink.transfer detaches the source ArrayBuffer on this side. ' +
            'Confirm the caller never reuses the buffer afterwards (Drizzle ' +
            'wraps params in error messages; event listeners may re-emit). ' +
            'Add `// eslint-disable-next-line no-restricted-syntax -- ' +
            'ALLOWED-TRANSFER: <why>` above the call to silence this rule.',
        },
      ],
    },
  },
  {
    files: ['src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: [
      'test/**/*.{ts,tsx}',
      'gossip-sdk/test/**/*.{ts,tsx}',
      'gossip-sdk/examples/**/*.{ts,tsx}',
      'gossip-sdk/scripts/**/*.{ts,tsx}',
      '**/*.config.{ts,js}',
      'scripts/**/*.{ts,js,mjs}',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  // Gossip SDK: enforce explicit .js extensions in relative imports
  {
    files: ['gossip-sdk/src/**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    rules: {
      // Require .js extension for all relative imports (./ or ../)
      'import/extensions': [
        'error',
        'ignorePackages',
        {
          js: 'always',
          jsx: 'always',
          ts: 'always',
          tsx: 'always',
        },
      ],
    },
    settings: {
      'import/extensions': ['.js'],
    },
  }
);
