import { blobIdFromInt } from '@mysten/walrus'
import type { ClientWithCoreApi } from '@mysten/sui/client'
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
 * @returns The owner's blobs; entries whose fields cannot be parsed are skipped.
 */
export async function fetchOwnedWalrusBlobs(
  suiClient: ClientWithCoreApi,
  walrusClient: WalrusClient,
  owner: string,
): Promise<OwnedBlob[]> {
  const blobType = await walrusClient.walrus.getBlobType()
  const { objects } = await suiClient.core.listOwnedObjects({
    owner,
    type: blobType,
    include: { json: true },
  })
  const blobs: OwnedBlob[] = []
  for (const obj of objects) {
    const fields = structFields(obj.json)
    if (!fields) continue
    const storage = structFields(fields.storage)
    try {
      blobs.push({
        objectId: obj.objectId,
        blobId: blobIdFromInt(BigInt(fields.blob_id as string)),
        size: Number(fields.size),
        endEpoch: Number(storage?.end_epoch ?? 0),
        certified: fields.certified_epoch !== null && fields.certified_epoch !== undefined,
      })
    } catch {
      // Skip blobs whose fields cannot be parsed.
    }
  }
  return blobs
}

