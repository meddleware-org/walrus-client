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

/** A registered-but-not-yet-uploaded blob, discoverable on-chain to resume an interrupted upload. */
export type ResumableRegistration = {
  /** The on-chain Blob object id. */
  objectId: string
  /** The register transaction digest (the tx that last mutated an uncertified blob). */
  registerDigest: string
}

/**
 * Find an owned `Blob` that was already registered on-chain for `blobId` but not yet certified, so
 * an interrupted upload can be resumed WITHOUT re-registering — no local pointer needed. This makes
 * resume robust across cache-clear / new device / incognito (the registration lives on-chain).
 *
 * A blob matches when its `blob_id` equals `blobId`, it is uncertified, and its storage has not
 * expired. `registerDigest` is read from the object's `previousTransaction` — for a blob that was
 * only registered (never certified), that is the register transaction.
 *
 * @param suiClient A Sui client exposing the unified core API (`SuiGrpcClient`).
 * @param walrusClient A Walrus-extended client (see {@link createWalrusClient}).
 * @param owner The address whose owned blobs to search.
 * @param blobId The target blob id (deterministic from the encoded file content).
 * @returns The matching registration, or `null` if none is resumable.
 */
export async function findUncertifiedRegisteredBlob(
  suiClient: ClientWithCoreApi,
  walrusClient: WalrusClient,
  owner: string,
  blobId: string,
): Promise<ResumableRegistration | null> {
  const [blobType, sys] = await Promise.all([
    walrusClient.walrus.getBlobType(),
    walrusClient.walrus.systemState(),
  ])
  const currentEpoch = Number(sys.committee.epoch)
  const { objects } = await suiClient.core.listOwnedObjects({
    owner,
    type: blobType,
    include: { json: true, previousTransaction: true },
  })
  for (const obj of objects) {
    const o = obj as { objectId: string; json?: unknown; previousTransaction?: string }
    const fields = structFields(o.json)
    if (!fields || o.previousTransaction === undefined) continue
    const certified = fields.certified_epoch !== null && fields.certified_epoch !== undefined
    if (certified) continue
    const storage = structFields(fields.storage)
    const endEpoch = Number(storage?.end_epoch ?? 0)
    if (endEpoch <= currentEpoch) continue // expired reservation — cannot upload to it
    let id: string
    try {
      id = blobIdFromInt(BigInt(fields.blob_id as string))
    } catch {
      continue
    }
    if (id === blobId) {
      return { objectId: o.objectId, registerDigest: o.previousTransaction }
    }
  }
  return null
}
