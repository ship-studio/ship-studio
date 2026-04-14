import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores (must be first, standalone object)
  {
    ignores: [
      'dist/',
      'node_modules/',
      'src-tauri/',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // Base configs
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  // TypeScript parser options for type checking
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React configuration
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React rules
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      'react/prop-types': 'off', // TypeScript handles this
      'react/no-unescaped-entities': 'off', // Too noisy for now

      // React hooks rules
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'error',

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Strict type-checked rules
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/only-throw-error': 'error',

      // Disallow console.log (allow warn/error for logger.ts internals)
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Pattern enforcement (DX refactor guardrails — see CLAUDE.md "How to Do Things")
  // Implementations live in src/hooks/ and src/components/primitives/, so they're
  // exempt from these rules.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/hooks/useCopyToClipboard.ts',
      'src/hooks/usePolling.ts',
      'src/hooks/useInvoke.ts',
      'src/hooks/useToasts.ts',
      'src/components/primitives/**',
      'src/contexts/**',
      'src/lib/logger.ts',
      'src/lib/polling.ts',
      'src/**/*.test.{ts,tsx}',
    ],
    rules: {
      // Warn (not error) on legacy patterns — the DX refactor is in flight and there
      // are known migration sites tracked in DX_REFACTOR_PLAN.md. New code is expected
      // to follow the new patterns; existing offenders get cleaned up over time.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "MemberExpression[object.object.name='navigator'][object.property.name='clipboard'][property.name='writeText']",
          message:
            "Use the `useCopyToClipboard` hook instead of calling `navigator.clipboard.writeText` directly. See CLAUDE.md → How to Do Things → Copy-to-clipboard.",
        },
        {
          selector: "CallExpression[callee.name='setInterval']",
          message:
            'Prefer the `usePolling` hook over raw `setInterval` in components — it auto-cleans up and supports backoff. See CLAUDE.md → How to Do Things → Polling.',
        },
      ],
    },
  },
  {
    // Components specifically — also block direct `invoke` usage (force `useInvoke`).
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: [
      'src/components/primitives/**',
      'src/components/**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message:
                'Components should use `useInvoke` from src/hooks/useInvoke.ts (handles loading/error state + structured logging). Direct `invoke` is OK in src/lib/* wrappers and primitives. See CLAUDE.md → How to Do Things → Calling Tauri commands.',
            },
          ],
        },
      ],
    },
  },

  // Prettier must be last to override formatting rules
  prettier
);
