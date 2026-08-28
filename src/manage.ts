import type { Signer } from '@mysten/sui/cryptography'
import type { createWalrusClient } from './client.js'

/** A Walrus-extended Sui client, as returned by {@link createWalrusClient}. */
export type WalrusClient = ReturnType<typeof createWalrusClient>

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
  const result = await client.walrus.executeWriteBlobAttributesTransaction({
    blobObjectId,
    signer,
    attributes,
  })
  return { digest: result.digest }
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
  return client.walrus.readBlobAttributes({ blobObjectId })
}
