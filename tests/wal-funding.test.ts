import { describe, it, expect } from 'vitest'
import { assertWalFunded, requiredWal, type StorageCostFn } from './integration/wal-funding.js'

// The testbed's prices: storage 5 FROST/unit/epoch, write 1 FROST/unit (localnet/scripts/lib.sh), one
// encoded unit for a tiny blob, so 3 epochs cost 5*3 + 1 = 16 — the amount in the 2026-10-22 failure.
const cost: StorageCostFn = async (_size, epochs) => {
  const storageCost = 5n * BigInt(epochs)
  return { storageCost, writeCost: 1n, totalCost: storageCost + 1n }
}

describe('localnet WAL funding preflight', () => {
  it('derives the requirement from the live price: two 3-epoch uploads + a 2-epoch extension, with margin', async () => {
    expect(await requiredWal(cost, 30, { uploads: 2, uploadEpochs: 3, extendEpochs: 2 }, 1n)).toBe(16n * 2n + 10n)
    expect(await requiredWal(cost, 30, { uploads: 2, uploadEpochs: 3, extendEpochs: 2 })).toBe((16n * 2n + 10n) * 2n)
  })

  it('scales with a price change (never a hard-coded amount)', async () => {
    const dear: StorageCostFn = async (s, e) => {
      const c = await cost(s, e)
      return { storageCost: c.storageCost * 1000n, writeCost: c.writeCost, totalCost: c.storageCost * 1000n + 1n }
    }
    expect(await requiredWal(dear, 30, { uploads: 1, uploadEpochs: 3, extendEpochs: 0 }, 1n)).toBe(15_001n)
  })

  it('passes when funded and fails fast with an actionable message when not', () => {
    expect(() => assertWalFunded(100n, 42n, '0xabc')).not.toThrow()
    expect(() => assertWalFunded(42n, 42n, '0xabc')).not.toThrow()
    expect(() => assertWalFunded(0n, 42n, '0xabc')).toThrow(/holds 0 FROST of WAL.*needs 42.*bootstrap funding step/s)
  })
})
