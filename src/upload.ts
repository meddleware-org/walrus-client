import { readFile } from 'node:fs/promises'
import { WalrusFile } from '@mysten/walrus'
import type { Signer } from '@mysten/sui/cryptography'
import type { createWalrusClient } from './client.js'

/** The return type of {@link createWalrusClient}. */
export type WalrusClient = ReturnType<typeof createWalrusClient>

/**
 * Maximum epochs a SINGLE Walrus reservation accepts (`max_epochs_ahead` on the
 * Walrus system object; 53 on testnet/mainnet). Passing more to `writeBlob` /
 * `writeFiles` aborts on-chain (`reserve_space`, MoveAbort code 2). ~2 years at
 * the ~2-week epoch cadence.
 */
export const MAX_SINGLE_RESERVATION_EPOCHS = 53

/**
 * Recommended TARGET lifetime for critical assets (~7.7 years at a ~2-week epoch
 * cadence). NOTE: this cannot be reached in one reservation — it exceeds
 * {@link MAX_SINGLE_RESERVATION_EPOCHS}. Reaching it requires periodic renewal via
 * {@link extendBlobLifetime} before expiry. When passing this as an initial
 * `epochs` value, clamp to `MAX_SINGLE_RESERVATION_EPOCHS` first, or pass an
 * explicit `epochs <= 53`.
 */
export const LONG_TERM_EPOCHS = 200

/** Options shared by all upload helpers. */
export type UploadOptions = {
  /** Storage epochs to reserve (default: {@link MAX_SINGLE_RESERVATION_EPOCHS}). */
  epochs?: number
  /** Whether the blob can be deleted by its owner (default false). */
  deletable?: boolean
  /** Arbitrary key-value metadata tags stored with the blob. */
  tags?: Record<string, string>
}

/** The object IDs returned after a successful upload. */
export type UploadResult = {
  /** Walrus content-addressed blob ID. */
  blobId: string
  /** On-chain Walrus blob object ID. */
  blobObjectId: string
}

/**
 * Upload raw bytes as a Walrus quilt (file bundle). Use this from Node.js with a keypair
 * signer; use {@link createUploadFlow} in the browser for wallet-popup-safe signing.
 *
 * @throws {Error} if the Walrus write transaction fails or the signer rejects.
 */
export async function uploadBytes(
  client: WalrusClient,
  contents: Uint8Array,
  identifier: string,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const file = WalrusFile.from({ contents, identifier, tags: options.tags })
  const [result] = await client.walrus.writeFiles({
    files: [file],
    // Default to the largest reservation Walrus accepts; a caller wanting the
    // LONG_TERM target must renew via extendBlobLifetime after this.
    epochs: options.epochs ?? MAX_SINGLE_RESERVATION_EPOCHS,
    deletable: options.deletable ?? false,
    signer,
  })
  return { blobId: result.blobId, blobObjectId: result.id }
}

/**
 * Read a local file and upload it as a Walrus quilt. Node.js only.
 *
 * @throws {Error} if the file cannot be read or the upload fails.
 */
export async function uploadLocalFile(
  client: WalrusClient,
  filePath: string,
  identifier: string,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const contents = await readFile(filePath)
  return uploadBytes(client, new Uint8Array(contents), identifier, signer, options)
}

/**
 * Begin a multi-step quilt upload flow suitable for browser wallet signing.
 * The caller drives the flow: encode → register (wallet signs) → upload → certify (wallet signs).
 */
export function createUploadFlow(
  client: WalrusClient,
  contents: Uint8Array,
  identifier: string,
  options: UploadOptions = {},
) {
  const file = WalrusFile.from({ contents, identifier, tags: options.tags })
  return client.walrus.writeFilesFlow({ files: [file] })
}

// ─── Raw blobs ───────────────────────────────────────────────────────────────
// `createUploadFlow` / `uploadBytes` store a QUILT (a bundle of files); reading
// the quilt blob id back returns the encoded quilt, not the file. For assets that
// must be served directly by their blob URL (e.g. a token icon rendered by
// wallets/explorers), use a RAW blob: `GET /v1/blobs/<blobId>` returns the exact
// bytes. See `walrusBlobUrl()` in ./client.

/**
 * Upload raw bytes as a Walrus raw blob (served directly at `/v1/blobs/<blobId>`).
 * Use this for assets that must be URL-addressable (e.g. token icons). Node.js only.
 *
 * @throws {Error} if the Walrus write transaction fails or the signer rejects.
 */
export async function uploadImageBytes(
  client: WalrusClient,
  contents: Uint8Array,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const res = await client.walrus.writeBlob({
    blob: contents,
    // Default to the largest reservation Walrus accepts (see uploadBytes).
    epochs: options.epochs ?? MAX_SINGLE_RESERVATION_EPOCHS,
    deletable: options.deletable ?? false,
    signer,
  })
  return { blobId: res.blobId, blobObjectId: res.blobObject.id }
}

/**
 * Begin a multi-step raw-blob upload flow suitable for browser wallet signing.
 *
 * Drive the returned flow:
 * ```ts
 * await flow.encode()
 * const regTx = flow.register({ owner, epochs, deletable }) // wallet signs + executes
 * await flow.upload({ digest })                              // digest of regTx
 * const certTx = flow.certify()                              // wallet signs + executes
 * const { blobId } = await flow.getBlob()                   // use walrusBlobUrl(network, blobId)
 * ```
 */
export function createBlobUploadFlow(client: WalrusClient, contents: Uint8Array) {
  return client.walrus.writeBlobFlow({ blob: contents })
}
