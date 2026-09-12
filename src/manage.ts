import type { Signer } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import type { createWalrusClient } from './client.js'

/** A Walrus-extended Sui client, as returned by {@link createWalrusClient}. */
export type WalrusClient = ReturnType<typeof createWalrusClient>

/**
 * True when `err` is a Sui "object / dynamic field not found" error. A blob with no attributes yet
 * has no `metadata` dynamic field, so a lookup of it fails this way. `@mysten/sui`'s `ObjectError`
 * is not exported, so we duck-type on its `code` (`'notExists'` for the derived field object,
 * `'dynamicFieldNotFound'` for the parent) with a message fallback.
 */
function isMissingFieldError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === 'notExists' || code === 'dynamicFieldNotFound') return true
  const msg = err instanceof Error ? err.message : ''
  return /does not exist|Dynamic field not found/.test(msg)
}

/**
 * How to extend a blob's storage: either add `epochs` more, or extend up to an
 * absolute `endEpoch`. Exactly one of the two must be provided.
 */
export type ExtendOptions =
  | { epochs: number; endEpoch?: never }
  | { endEpoch: number; epochs?: never }

/**
 * Extend a blob's storage lifetime on-chain (Node.js — signs and executes).
 * Since Walrus blobs expire, call this before expiry to prevent data loss.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id (not the blob id).
 * @param signer The keypair paying for and authorising the extension.
 * @param options Add `epochs` more, or extend to an absolute `endEpoch`.
 * @returns The executed transaction digest.
 */
export async function extendBlobLifetime(
  client: WalrusClient,
  blobObjectId: string,
  signer: Signer,
  options: ExtendOptions,
): Promise<{ digest: string }> {
  const result = await client.walrus.executeExtendBlobTransaction({
    blobObjectId,
    signer,
    ...options,
  })
  return { digest: result.digest }
}

/**
 * Build (but do not sign) a blob-lifetime-extension transaction for a browser
 * wallet to sign. Browser counterpart of {@link extendBlobLifetime}.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param options Add `epochs` more, or extend to an absolute `endEpoch`.
 * @returns An unsigned `Transaction`.
 */
export function extendBlobLifetimeTransaction(
  client: WalrusClient,
  blobObjectId: string,
  options: ExtendOptions,
) {
  return client.walrus.extendBlobTransaction({ blobObjectId, ...options })
}

/** A blob's storage-node availability certificate, serialized as base64 (from the upload step). */
export interface CertifyOptions {
  /** The Walrus blob id. */
  blobId: string
  /** The on-chain Blob object id (not the blob id). */
  blobObjectId: string
  /**
   * The base64 availability certificate returned by the upload step. `@mysten/walrus` accepts the
   * base64 string directly (it parses it internally), so no BCS handling is needed here.
   */
  certificate: string
  /** Must match how the blob was registered (our uploads register non-deletable). */
  deletable?: boolean
}

/**
 * Build (but do not sign) a transaction that certifies an already-uploaded blob, for a browser
 * wallet to sign. Lets an upload that was registered + uploaded (and paid for) but not certified —
 * e.g. the user dismissed the certify prompt — be completed later without re-uploading: certify is a
 * plain owner transaction that submits the stored availability certificate, validated on-chain.
 *
 * @param client A Walrus-extended client.
 * @param options The blob ids + the base64 certificate captured at upload time.
 * @returns An unsigned `Transaction`.
 */
export function certifyBlobTransaction(client: WalrusClient, options: CertifyOptions) {
  return client.walrus.certifyBlobTransaction({
    blobId: options.blobId,
    blobObjectId: options.blobObjectId,
    certificate: options.certificate,
    deletable: options.deletable ?? false,
  })
}

/**
 * Set on-chain key/value attributes on a blob (Node.js — signs and executes). A
 * `null` value deletes that attribute.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param signer The keypair authorising the write.
 * @param attributes Attributes to set; `null` deletes the key.
 * @returns The executed transaction digest.
 */
export async function setBlobAttributes(
  client: WalrusClient,
  blobObjectId: string,
  signer: Signer,
  attributes: Record<string, string | null>,
): Promise<{ digest: string }> {
  try {
    const result = await client.walrus.executeWriteBlobAttributesTransaction({
      blobObjectId,
      signer,
      attributes,
    })
    return { digest: result.digest }
  } catch (err) {
    // First write on a blob with no `metadata` dynamic field: the SDK's writeBlobAttributes reads the
    // existing attributes to compute a diff, which throws here (the field doesn't exist yet). Rebuild
    // passing `blobObject` instead of `blobObjectId` — that path skips the read and adds the metadata
    // struct itself (null-valued keys are simply skipped, correct for a fresh blob). The SDK still
    // signs, executes, and waits internally.
    if (!isMissingFieldError(err)) throw err
    const tx = new Transaction()
    const result = await client.walrus.executeWriteBlobAttributesTransaction({
      transaction: tx,
      blobObject: tx.object(blobObjectId),
      signer,
      attributes,
    })
    return { digest: result.digest }
  }
}

/**
 * Build (but do not sign) a set-blob-attributes transaction for a browser wallet
 * to sign. Browser counterpart of {@link setBlobAttributes}.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param attributes Attributes to set; `null` deletes the key.
 * @returns An unsigned `Transaction`.
 */
export function setBlobAttributesTransaction(
  client: WalrusClient,
  blobObjectId: string,
  attributes: Record<string, string | null>,
) {
  return client.walrus.writeBlobAttributesTransaction({ blobObjectId, attributes })
}

/**
 * Read a blob's on-chain attributes.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @returns The attribute map, or `null` if the blob has none.
 */
export async function readBlobAttributes(
  client: WalrusClient,
  blobObjectId: string,
): Promise<Record<string, string> | null> {
  try {
    return await client.walrus.readBlobAttributes({ blobObjectId })
  } catch (err) {
    // A blob with no attributes has no `metadata` dynamic field; the SDK throws rather than returning
    // null. Honour this function's documented contract by returning null for that case.
    if (isMissingFieldError(err)) return null
    throw err
  }
}
