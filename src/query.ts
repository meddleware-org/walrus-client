import { blobIdFromInt } from '@mysten/walrus'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { normalizeStructTag } from '@mysten/sui/utils'
import type { WalrusClient } from './upload.js'

/**
 * Unwrap a Move-struct field bag from a core `json` value. The gRPC/core API returns struct
 * fields flat (`{ blob_id, size, storage: {...} }`); the old JSON-RPC shape nested them under
 * `.fields`. Tolerate both so parsing is robust to the transport and to the SDK's documented
 * caveat that the `json` shape may vary between API implementations.
 */
function structFields(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const nested = o.fields
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : o
}

/** Upper bound on owned-object pages read by {@link fetchOwnedWalrusBlobs} (50 objects per page). */
export const MAX_OWNED_BLOB_PAGES = 100

/** A u64/u32 rendered as a decimal string (or number); `null` otherwise. */
function uintField(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v)
  return null
}

/** `type` normalised, or `null` if it is not a struct tag. */
function normalizedType(type: unknown): string | null {
  if (typeof type !== 'string') return null
  try {
    return normalizeStructTag(type)
  } catch {
    return null
  }
}

/** A Walrus blob object owned by a Sui address. */
export type OwnedBlob = {
  /** The on-chain Blob object id. */
  objectId: string
  /** Aggregator-URL-compatible blob id string (`GET /v1/blobs/<blobId>`). */
  blobId: string
  /** Size in bytes. */
  size: number
  /** Epoch at which the blob's storage expires. */
  endEpoch: number
  /** Whether the blob has been certified. */
  certified: boolean
}

/**
 * Return all Walrus blobs owned by `owner`. Resolves the on-chain Blob struct
 * type dynamically via `getBlobType()`, so no package addresses are hardcoded.
 *
 * @param suiClient A Sui client exposing the unified core API (`SuiGrpcClient`).
 * @param walrusClient A Walrus-extended client (see {@link createWalrusClient}).
 * @param owner The address whose owned blobs to enumerate.
 * @returns The owner's blobs; entries that are not exactly the Blob type, or whose fields are missing
 *   or malformed, are skipped (never listed with invented values).
 * @throws {Error} if an RPC call fails, or more than {@link MAX_OWNED_BLOB_PAGES} pages would be needed.
 */
export async function fetchOwnedWalrusBlobs(
  suiClient: ClientWithCoreApi,
  walrusClient: WalrusClient,
  owner: string,
): Promise<OwnedBlob[]> {
  const blobType = await walrusClient.walrus.getBlobType()
  type OwnedPage = Awaited<ReturnType<typeof suiClient.core.listOwnedObjects>>
  const objects: OwnedPage['objects'] = []
  let cursor: string | null | undefined
  // Page through every owned blob — a single page silently truncates large wallets — but never
  // without bound (a node that always reports another page must not loop forever).
  let done = false
  for (let n = 0; n < MAX_OWNED_BLOB_PAGES && !done; n++) {
    const page: OwnedPage = await suiClient.core.listOwnedObjects({
      owner,
      type: blobType,
      include: { json: true },
      ...(cursor ? { cursor } : {}),
    })
    objects.push(...page.objects)
    if (!page.hasNextPage || !page.cursor) done = true
    else cursor = page.cursor
  }
  if (!done) throw new Error(`more than ${MAX_OWNED_BLOB_PAGES} pages of Walrus blobs owned by ${owner}`)

  const expected = normalizedType(blobType)
  const blobs: OwnedBlob[] = []
  for (const obj of objects) {
    // The node filtered by type; check it here too (full normalised type, no look-alikes).
    if (expected === null || normalizedType(obj.type) !== expected) continue
    const fields = structFields(obj.json)
    const blobIdInt = uintField(fields?.blob_id ?? null)
    const size = uintField(fields?.size)
    const endEpoch = uintField(structFields(fields?.storage)?.end_epoch)
    if (!fields || blobIdInt === null || size === null || endEpoch === null) continue
    let blobId: string
    try {
      blobId = blobIdFromInt(blobIdInt)
    } catch {
      continue // not a valid blob id: skipped, never listed with an invented value
    }
    blobs.push({
      objectId: obj.objectId,
      blobId,
      // Safe as numbers: epochs are u32 and a blob's size is bounded far below 2^53.
      size: Number(size),
      endEpoch: Number(endEpoch),
      certified: fields.certified_epoch !== null && fields.certified_epoch !== undefined,
    })
  }
  return blobs
}

