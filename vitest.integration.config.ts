import { defineConfig } from 'vitest/config'

// Localnet integration suites — run against the Docker-Compose testbed in ./localnet after
// `source .env.localnet`. Gated by WALRUS_LOCALNET (suites self-skip otherwise), so this config is
// safe to run anywhere; without the env it simply reports skipped tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    // Real blob writes (encode → register → upload → certify) are slow; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // localnet has one storage cluster; run serially to keep faucet/gas usage predictable.
    fileParallelism: false,
  },
})
