import { blobIdFromInt } from '@mysten/walrus'
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import type { WalrusClient } from './upload.js'

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
 * @param suiClient A JSON-RPC Sui client (provides `getOwnedObjects`).
 * @param walrusClient A Walrus-extended client (see {@link createWalrusClient}).
 * @param owner The address whose owned blobs to enumerate.
 * @returns The owner's blobs; entries whose fields cannot be parsed are skipped.
 */
export async function fetchOwnedWalrusBlobs(
  suiClient: SuiJsonRpcClient,
  walrusClient: WalrusClient,
  owner: string,
): Promise<OwnedBlob[]> {
  const blobType = await walrusClient.walrus.getBlobType()
  const { data } = await suiClient.getOwnedObjects({
    owner,
    filter: { StructType: blobType },
    options: { showContent: true },
  })
  const blobs: OwnedBlob[] = []
  for (const item of data) {
    if (!item.data) continue
    const fields = (item.data.content as { fields?: Record<string, unknown> } | undefined)?.fields
    if (!fields) continue
    const storage = fields.storage as { fields?: { end_epoch?: unknown } } | undefined
    try {
      blobs.push({
        objectId: item.data.objectId,
        blobId: blobIdFromInt(BigInt(fields.blob_id as string)),
        size: Number(fields.size),
        endEpoch: Number(storage?.fields?.end_epoch ?? 0),
        certified: fields.certified_epoch !== null && fields.certified_epoch !== undefined,
      })
    } catch {
      // Skip blobs whose fields cannot be parsed.
    }
  }
  return blobs
}
