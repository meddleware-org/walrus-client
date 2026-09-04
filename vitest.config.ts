import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration suites are localnet-gated and run via vitest.integration.config.ts, not here,
    // so the default `npm test` (unit) stays fast and offline.
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
})
