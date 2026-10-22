// WAL funding preflight for the localnet suites. Pure helpers (unit-tested in tests/wal-funding.test.ts):
// the harness feeds them the live cost from the Walrus system object and the test wallet's WAL balance.

/** Mirrors `WalrusClient.storageCost` (FROST). */
export type StorageCostFn = (
  size: number,
  epochs: number,
) => Promise<{ storageCost: bigint; writeCost: bigint; totalCost: bigint }>

/** What a suite does with the test wallet: N uploads of one blob, then one lifetime extension. */
export type WalPlan = { uploads: number; uploadEpochs: number; extendEpochs: number }

/**
 * The WAL (FROST) a plan needs at the testbed's actual prices, times `margin`: each upload pays storage
 * for its epochs plus the write fee (`totalCost`); an extension pays storage only. Computed from the
 * live system object, never from a hard-coded amount, so a price change in the testbed cannot go unseen.
 */
export async function requiredWal(
  storageCost: StorageCostFn,
  blobSize: number,
  plan: WalPlan,
  margin = 2n,
): Promise<bigint> {
  const upload = (await storageCost(blobSize, plan.uploadEpochs)).totalCost
  const extend = plan.extendEpochs > 0 ? (await storageCost(blobSize, plan.extendEpochs)).storageCost : 0n
  return (upload * BigInt(plan.uploads) + extend) * margin
}

/** Throw a self-explanatory error when the wallet cannot pay, instead of an opaque mid-suite failure. */
export function assertWalFunded(have: bigint, need: bigint, address: string): void {
  if (have >= need) return
  throw new Error(
    `localnet WAL funding: test wallet ${address} holds ${have} FROST of WAL but this suite needs ${need}. ` +
      'The bootstrap funding step did not deliver (localnet/scripts/bootstrap-localnet.sh step 3b) — ' +
      'check its log, then re-run `down.sh --clean`, `up.sh` and `bootstrap-localnet.sh`.',
  )
}
