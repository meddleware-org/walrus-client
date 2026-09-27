import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

// Flat ESLint config for a TypeScript library (no Vue SFCs). Uses the shared
// Vue+TS preset's TypeScript rules for consistency with the rest of the monorepo.
export default defineConfigWithVueTs(
  { name: 'walrus-client/files-to-lint', files: ['**/*.{ts,mts,tsx}'] },
  // localnet/ vendors an upstream Walrus checkout with its own tooling — not ours to lint.
  globalIgnores(['**/dist/**', '**/coverage/**', '**/*.d.ts', 'localnet/**']),
  vueTsConfigs.recommended,

  {
    name: 'walrus-client/overrides',
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused" marker; rest-sibling
      // destructuring (`const { a, ...rest } = x`) is a legitimate key-omission pattern.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  {
    // Tests use deliberately loose typing for mocks/stubs.
    name: 'walrus-client/test-overrides',
    files: ['**/*.{test,spec}.{ts,tsx}', 'tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
