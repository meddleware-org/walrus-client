// `@meddleware/walrus-client/flow` — the headless blob-upload orchestrator shared by the apps
// (encode → [precheck] → register → upload → certify), with single-use relay access and the
// resume conventions around it.
//
// This module must not pull `@mysten/walrus` (wasm) into an app's eager bundle: it never imports
// the package root statically, only lazily through `loadWalrusClient` (default: a dynamic import).
//
// Register is ALWAYS performed, never resumed. With an upload relay (required for browser uploads)
// the SDK embeds the relay tip and a per-encode nonce inside the register transaction, and the relay
// rejects a stale `tx_id` as "the received transaction is too old". Each attempt re-encodes (free)
// and registers fresh. Only the single-use consume digest is resumable: it is a permanent on-chain
// token, redeemed by the gateway only when an upload succeeds.
import { encodeAccessProof, personalMessageForNonce } from '@meddleware/nft-gate-client'
import type { PersonalMessageSigner } from '@meddleware/nft-gate-client'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { fetchRelayChallenge } from './access.js'

// ── Progress ─────────────────────────────────────────────────────────────────

/** Phases of an upload, in journey order (`access` only for gated uploads). */
export type UploadStepKey = 'access' | 'encode' | 'register' | 'upload' | 'certify'

/** Structured progress for a stepper: the phase and a sentence for it. */
export interface UploadProgress {
  step: UploadStepKey
  detail?: string
}

/** A finished upload. */
export interface BlobUploadResult {
  blobId: string
  /** Aggregator URL that serves the raw bytes. */
  url: string
  /** Certify transaction digest. */
  digest?: string
}

// ── Error conventions ────────────────────────────────────────────────────────
// A thrown upload error can carry a follow-up action, so a generic widget can offer it.

/** An existing owned copy of the blob being uploaded. */
export interface ExistingCopy {
  /** `certified` ⇒ already available (offer Extend); `pending` ⇒ uploaded but not certified (offer Certify). */
  kind: 'certified' | 'pending'
  blobId: string
  /** The on-chain Blob object id of the existing copy. */
  objectId: string
  /** That copy's storage end epoch. */
  endEpoch: number
}

/** Shape of an error carrying an existing-copy match. */
export interface DuplicateExistingError {
  duplicateExisting: ExistingCopy
}

/** Attach an existing-copy match to an error object (no-op for non-object throwables). */
export function attachDuplicateExisting(err: unknown, existing: ExistingCopy): void {
  if (err && typeof err === 'object') (err as Record<string, unknown>).duplicateExisting = existing
}

/** The existing-copy match attached to a thrown error, or `null`. */
export function getDuplicateExisting(err: unknown): ExistingCopy | null {
  const e = (err as Partial<DuplicateExistingError> | null)?.duplicateExisting
  return e && typeof e === 'object' && 'kind' in e ? e : null
}

/**
 * Shape of an error carrying a certify retry. Register and upload are paid and cannot be replayed,
 * so when only certify fails (e.g. the wallet prompt is rejected) the error carries a closure that
 * certifies from the certificate the live flow still holds.
 */
export interface CertifyRetryable<R> {
  certifyRetry: () => Promise<R>
}

/** Attach a certify-retry closure to an error object (no-op for non-object throwables). */
export function attachCertifyRetry<R>(err: unknown, retry: () => Promise<R>): void {
  if (err && typeof err === 'object') (err as Record<string, unknown>).certifyRetry = retry
}

/** The certify-retry closure attached to a thrown error, or `null`. */
export function getCertifyRetry<R>(err: unknown): (() => Promise<R>) | null {
  const c = (err as Partial<CertifyRetryable<R>> | null)?.certifyRetry
  return typeof c === 'function' ? c : null
}

/**
 * True if `err` is the gateway's "this consume was already redeemed" rejection: HTTP 409 with
 * `code: 'redeemed'`, as a structured error, in the message, or anywhere in the `cause` chain.
 * Only this re-consumes (spends a new use) — never a transient failure.
 */
export function isRedeemedConflict(err: unknown, depth = 0): boolean {
  const e = err as { status?: number; error?: { code?: string }; message?: unknown; cause?: unknown } | null
  if (!e || typeof e !== 'object' || depth > 8) return false
  if (e.status === 409 && e.error?.code === 'redeemed') return true
  if (typeof e.message === 'string' && /\b409\b/.test(e.message) && /\bredeemed\b/.test(e.message)) return true
  return e.cause !== undefined && e.cause !== e && isRedeemedConflict(e.cause, depth + 1)
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** The subset of the Web Storage API this module needs (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Stable per-(network, gate, address) key for the pending consume digest. */
export function consumeStorageKey(network: string, gateId: string, address: string): string {
  return `mw:walrus:consume:${network}:${gateId}:${address}`
}

/** A stored "uploaded but not yet certified" blob. */
export interface PendingCertify {
  blobId: string
  /** The on-chain Blob object id — the map key and the object being certified. */
  blobObjectId: string
  /** Base64 availability certificate from the upload step (accepted by `certifyBlobTransaction`). */
  certificate: string
  deletable: boolean
  /** Epoch ms the entry was saved. */
  savedAt: number
}

/** Stable per-(network, address) key for pending certifications. */
export function pendingCertifyKey(network: string, address: string): string {
  return `mw:walrus:pendingCertify:${network}:${address}`
}

/** The pending-certify map (keyed by blobObjectId); empty if none or corrupt. */
export function loadPendingCertifies(storage: StorageLike, key: string): Record<string, PendingCertify> {
  const raw = storage.getItem(key)
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as Record<string, PendingCertify>
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** Persist one pending certification (merged into the map by blobObjectId). */
export function savePendingCertify(storage: StorageLike, key: string, entry: Omit<PendingCertify, 'savedAt'>): void {
  const map = loadPendingCertifies(storage, key)
  map[entry.blobObjectId] = { ...entry, savedAt: Date.now() }
  storage.setItem(key, JSON.stringify(map))
}

/** Remove a pending certification once the blob is certified (or found already certified). */
export function clearPendingCertify(storage: StorageLike, key: string, blobObjectId: string): void {
  const map = loadPendingCertifies(storage, key)
  if (!(blobObjectId in map)) return
  delete map[blobObjectId]
  if (Object.keys(map).length === 0) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify(map))
}

// ── Gated relay access ───────────────────────────────────────────────────────

/** Relay access for one upload: a token source, and a signal once the upload has landed. */
export interface GatedAccess {
  /** A fresh relay token. `forceFresh` spends a new use (after {@link isRedeemedConflict}). */
  token(forceFresh: boolean): Promise<string>
  /** The upload landed: the stored consume is now spent for it. */
  uploaded(): void
}

/** Injected wallet/chain calls for {@link createGatedAccess}. `Tx` is the app's transaction type. */
export interface GatedAccessPorts<Tx> {
  storage: StorageLike
  /** Usually {@link consumeStorageKey}. */
  key: string
  relayHost: string
  address: string
  /** The held access NFT. */
  nftId: string
  /** Single-use NFTs spend one use on-chain per upload; an unlimited pass only signs. */
  singleUse: boolean
  /** Build the on-chain consume of `nftId` bound to `nonce` (e.g. access-gate-client `buildConsumeTx`). */
  buildConsume(nftId: string, nonce: string): Tx
  signAndExecute(tx: Tx): Promise<{ digest?: string }>
  waitForTransaction(digest: string): Promise<unknown>
  /** Wallet personal-message signer (free — no gas, no use). */
  sign: PersonalMessageSigner
  /** Challenge source (default: the relay gateway's `GET /v1/challenge`). */
  fetchChallenge?: (relayHost: string) => Promise<{ nonce: string }>
  onStatus?: (p: UploadProgress) => void
}

/**
 * Relay access that never burns a use on an interrupted upload.
 *
 * - A stored (unspent) consume digest is reused: fresh challenge, free signature, no new consume.
 * - Otherwise one use is consumed on-chain and its digest persisted **before** the upload, so an
 *   interruption resumes instead of consuming again.
 * - `uploaded()` clears the stored digest; `token(true)` consumes anew after a redeemed conflict.
 */
export function createGatedAccess<Tx>(ports: GatedAccessPorts<Tx>): GatedAccess {
  const challengeOf = ports.fetchChallenge ?? ((host: string) => fetchRelayChallenge(host))
  return {
    async token(forceFresh) {
      if (forceFresh) ports.storage.removeItem(ports.key)
      const challenge = await challengeOf(ports.relayHost)
      let consumeDigest: string | undefined
      if (ports.singleUse) {
        consumeDigest = ports.storage.getItem(ports.key) ?? undefined
        if (!consumeDigest) {
          ports.onStatus?.({ step: 'access', detail: 'Using one access pass (approve in wallet)…' })
          const res = await ports.signAndExecute(ports.buildConsume(ports.nftId, challenge.nonce))
          if (!res.digest) throw new Error('The consume transaction returned no digest.')
          consumeDigest = res.digest
          ports.storage.setItem(ports.key, consumeDigest)
          // Best-effort: the gateway re-reads the consume with its own bounded retry, so an
          // indexing delay must not abort the upload; a failed consume is rejected by the gateway.
          await ports.waitForTransaction(consumeDigest).catch(() => {})
        }
      }
      ports.onStatus?.({ step: 'access', detail: 'Signing relay access (approve in wallet)…' })
      const { signature } = await ports.sign(personalMessageForNonce(challenge.nonce))
      return encodeAccessProof({
        address: ports.address,
        nonce: challenge.nonce,
        signature,
        ...(consumeDigest ? { consumeDigest } : {}),
      })
    },
    uploaded() {
      ports.storage.removeItem(ports.key)
    },
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/** Minimal transaction executor (e.g. wallet-adapter's `buildExecutor`). */
export interface UploadExecutor {
  signAndExecute(tx: unknown): Promise<{ digest: string }>
  waitForTransaction(digest: string): Promise<unknown>
}

interface BuiltTx {
  setSenderIfNotSet(address: string): void
  build(opts: { client: ClientWithCoreApi }): Promise<unknown>
}

/** The upload flow shape of `createBlobUploadFlow` this orchestrator drives. */
export interface BlobUploadFlow {
  /** Deterministic from the content, no gas; mints the per-attempt relay nonce. */
  encode(): Promise<{ blobId: string }>
  register(opts: { owner: string; epochs: number; deletable: boolean }): BuiltTx
  upload(opts: { digest: string; deletable?: boolean }): Promise<{
    blobId: string
    blobObjectId: string
    certificate: string
  }>
  certify(): BuiltTx
  getBlob(): Promise<{ blobId: string }>
}

/** Client options this flow passes (a subset of `CreateWalrusClientOptions`). */
export interface FlowClientOptions {
  network: 'testnet' | 'mainnet'
  wasmUrl?: string
  uploadRelayHost: string
  uploadRelayMaxTipMist?: number
  uploadRelayAuthToken?: () => string | undefined
}

/** The slice of the package root this flow loads lazily (method syntax: the real root satisfies it). */
export interface WalrusClientModule {
  createWalrusClient(opts: FlowClientOptions): unknown
  createBlobUploadFlow(client: unknown, bytes: Uint8Array): BlobUploadFlow
  walrusBlobUrl(network: 'testnet' | 'mainnet', blobId: string): string
}

export interface RunBlobUploadDeps {
  bytes: Uint8Array
  network: 'testnet' | 'mainnet'
  relayHost: string
  /** Owner and sender (the connected wallet account). */
  address: string
  /** Wasm bundle URL for the Walrus client. */
  wasmUrl?: string
  /** Cap on the relay tip in MIST. */
  maxTipMist?: number
  /** Storage reservation in epochs. */
  epochs: number
  /** Register as deletable. Default false: permanent. */
  deletable?: boolean
  /** Skip the existing-copy precheck (the user chose to upload a new copy anyway). */
  force?: boolean
  /**
   * Existing owned copy of this content (by the encoded `blobId`). A match aborts BEFORE
   * registering, with the match attached to the error ({@link getDuplicateExisting}).
   */
  findExistingCopy?: (blobId: string) => Promise<ExistingCopy | null>
  executor: UploadExecutor
  /** A Sui client used to `build()` the register and certify transactions. */
  suiClient: ClientWithCoreApi
  /** Relay access for an NFT-gated relay ({@link createGatedAccess}); omit for an open relay. */
  access?: GatedAccess
  onStatus: (p: UploadProgress) => void
  /** Called when the upload has landed, before certify: persist it to certify later. */
  onUploaded?: (info: { blobId: string; blobObjectId: string; certificate: string; deletable: boolean }) => void
  /** Called with the `blobObjectId` once certified: drop the persisted entry. */
  onCertified?: (blobObjectId: string) => void
  /** Lazy loader for the package root (default: dynamic import; keeps wasm out of the eager bundle). */
  loadWalrusClient?: () => Promise<WalrusClientModule>
}

/**
 * Encode → [precheck] → register → upload → certify, resolving the blob id and URL. Two wallet
 * approvals (register, certify), plus the access step for a gated relay.
 *
 * - An existing copy aborts before register ({@link getDuplicateExisting}).
 * - A redeemed consume (409) spends one new use and retries the upload once, on the same
 *   registration.
 * - A certify failure throws with {@link getCertifyRetry}; the upload is never repeated.
 */
export async function runBlobUpload(deps: RunBlobUploadDeps): Promise<BlobUploadResult> {
  const load = deps.loadWalrusClient ?? (async (): Promise<WalrusClientModule> => await import('./index.js'))
  const { createWalrusClient, createBlobUploadFlow, walrusBlobUrl } = await load()

  let token: string | undefined
  if (deps.access) {
    deps.onStatus({ step: 'access', detail: 'Confirming access…' })
    token = await deps.access.token(false)
  }

  const client = createWalrusClient({
    network: deps.network,
    wasmUrl: deps.wasmUrl,
    uploadRelayHost: deps.relayHost,
    uploadRelayMaxTipMist: deps.maxTipMist,
    ...(deps.access ? { uploadRelayAuthToken: () => token } : {}),
  })
  const flow = createBlobUploadFlow(client, deps.bytes)

  deps.onStatus({ step: 'encode', detail: 'Encoding…' })
  const { blobId } = await flow.encode()

  if (!deps.force && deps.findExistingCopy) {
    const existing = await deps.findExistingCopy(blobId)
    if (existing) {
      const err = new Error('Blob already stored on-chain')
      attachDuplicateExisting(err, existing)
      throw err
    }
  }

  deps.onStatus({ step: 'register', detail: 'Registering blob (approve in wallet)…' })
  const deletable = deps.deletable ?? false
  const regTx = flow.register({ owner: deps.address, epochs: deps.epochs, deletable })
  regTx.setSenderIfNotSet(deps.address)
  await regTx.build({ client: deps.suiClient })
  const reg = await deps.executor.signAndExecute(regTx)
  await deps.executor.waitForTransaction(reg.digest)

  deps.onStatus({ step: 'upload', detail: 'Uploading to the relay…' })
  let uploaded: Awaited<ReturnType<BlobUploadFlow['upload']>>
  try {
    uploaded = await flow.upload({ digest: reg.digest, deletable })
  } catch (e) {
    if (!deps.access || !isRedeemedConflict(e)) throw e
    // The stored consume was redeemed by an earlier upload: spend a new use and retry once on the
    // same (still recent) registration.
    token = await deps.access.token(true)
    deps.onStatus({ step: 'upload', detail: 'Uploading to the relay…' })
    uploaded = await flow.upload({ digest: reg.digest, deletable })
  }
  deps.access?.uploaded()
  deps.onUploaded?.({
    blobId: uploaded.blobId,
    blobObjectId: uploaded.blobObjectId,
    certificate: uploaded.certificate,
    deletable,
  })

  // Certify is a plain owner transaction built from the certificate the live flow holds (no relay,
  // no tip); a retry rebuilds the same transaction.
  const runCertify = async (): Promise<BlobUploadResult> => {
    deps.onStatus({ step: 'certify', detail: 'Certifying (approve in wallet)…' })
    const certTx = flow.certify()
    certTx.setSenderIfNotSet(deps.address)
    await certTx.build({ client: deps.suiClient })
    const cert = await deps.executor.signAndExecute(certTx)
    await deps.executor.waitForTransaction(cert.digest)
    const blob = await flow.getBlob()
    deps.onCertified?.(uploaded.blobObjectId)
    return { blobId: blob.blobId, url: walrusBlobUrl(deps.network, blob.blobId), digest: cert.digest }
  }

  try {
    return await runCertify()
  } catch (e) {
    attachCertifyRetry<BlobUploadResult>(e, runCertify)
    throw e
  }
}
