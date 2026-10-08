// `@meddleware/walrus-client/flow` — the headless blob-upload orchestrator shared by the apps
// (encode → [precheck] → register → upload → certify), with single-use relay access and the
// resume conventions around it.
//
// This module must not pull `@mysten/walrus` (wasm) into an app's eager bundle: it never imports
// the package root statically, only lazily through `loadWalrusClient` (default: a dynamic import).
//
// Register is ALWAYS performed fresh for a new upload, never resumed across page loads. With an
// upload relay (required for browser uploads) the SDK embeds the relay tip and a per-encode nonce
// inside the register transaction, and the relay rejects a stale `tx_id` as "the received
// transaction is too old". Within the relay's freshness window, though, a FAILED UPLOAD is retried on
// the same registration (bounded, with a fresh access token each time), so a transient relay or
// gateway error never costs a second paid registration; the thrown error then carries `uploadRetry`.
// Only the single-use consume digest is resumable across loads: it is a permanent on-chain token,
// redeemed by the gateway only when an upload succeeds.
import { buildAccessProof, isTransactionDigest } from '@meddleware/nft-gate-client'
import type { PersonalMessageSigner, SuiNetwork } from '@meddleware/nft-gate-client'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { fetchRelayChallenge } from './access.js'
import { assertEpochs } from './limits.js'

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

/** Shape of an error carrying an upload retry on the same registration. */
export interface UploadRetryable<R> {
  uploadRetry: () => Promise<R>
}

/** Attach an upload-retry closure to an error object (no-op for non-object throwables). */
export function attachUploadRetry<R>(err: unknown, retry: () => Promise<R>): void {
  if (err && typeof err === 'object') (err as Record<string, unknown>).uploadRetry = retry
}

/** The upload-retry closure attached to a thrown error, or `null`. */
export function getUploadRetry<R>(err: unknown): (() => Promise<R>) | null {
  const c = (err as Partial<UploadRetryable<R>> | null)?.uploadRetry
  return typeof c === 'function' ? c : null
}

/** The HTTP status carried by an error, structured or in the message, anywhere in its `cause` chain. */
export function httpStatusOf(err: unknown, depth = 0): number | null {
  const e = err as { status?: unknown; message?: unknown; cause?: unknown } | null
  if (!e || typeof e !== 'object' || depth > 8) return null
  if (typeof e.status === 'number' && e.status >= 100 && e.status <= 599) return e.status
  if (typeof e.message === 'string') {
    const m = /\b([45]\d\d)\b/.exec(e.message)
    if (m?.[1]) return Number(m[1])
  }
  return e.cause !== undefined && e.cause !== e ? httpStatusOf(e.cause, depth + 1) : null
}

function messageOf(err: unknown, depth = 0): string {
  const e = err as { message?: unknown; cause?: unknown } | null
  if (!e || typeof e !== 'object' || depth > 8) return ''
  const own = typeof e.message === 'string' ? e.message : ''
  return e.cause !== undefined && e.cause !== e ? `${own} ${messageOf(e.cause, depth + 1)}` : own
}

/**
 * True if `err` is the gateway's "no matching single-use consume for this address" rejection: the
 * digest it was given is not a successful consume of this gate by this address (or the node does not
 * know it). A digest resumed from storage that draws this is dropped and consumed anew.
 */
export function isConsumeRejected(err: unknown): boolean {
  return httpStatusOf(err) === 403 && /single-use consume/i.test(messageOf(err))
}

/** True if `err` is the gateway's "an upload for this consume is already in progress" (409 `leased`). */
export function isLeasedConflict(err: unknown, depth = 0): boolean {
  const e = err as { status?: number; error?: { code?: string }; message?: unknown; cause?: unknown } | null
  if (!e || typeof e !== 'object' || depth > 8) return false
  if (e.status === 409 && e.error?.code === 'leased') return true
  if (typeof e.message === 'string' && /\b409\b/.test(e.message) && /in progress/i.test(e.message)) return true
  return e.cause !== undefined && e.cause !== e && isLeasedConflict(e.cause, depth + 1)
}

/** True if `err` is a gateway rejection of the challenge/signature (401/403 about the nonce or signature). */
export function isStaleProof(err: unknown): boolean {
  const status = httpStatusOf(err)
  return (status === 401 || status === 403) && /nonce|signature|access proof/i.test(messageOf(err))
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

/**
 * The page's `localStorage` as a {@link StorageLike} that never throws. Where storage is unavailable
 * (blocked site data, some private modes, sandboxed frames — even reading `window.localStorage` can
 * throw) values are kept in memory for this page instead: an interrupted flow then cannot resume
 * after a reload, but nothing breaks. Pass this, not `window.localStorage`, to the flow helpers.
 */
export function browserStorage(): StorageLike {
  const memory = new Map<string, string>()
  const local = (): StorageLike | null => {
    try {
      return typeof window !== 'undefined' ? window.localStorage : null
    } catch {
      return null
    }
  }
  return {
    getItem(key) {
      try {
        const s = local()
        if (s) return s.getItem(key)
      } catch {
        // fall through to memory
      }
      return memory.get(key) ?? null
    },
    setItem(key, value) {
      memory.set(key, value)
      try {
        local()?.setItem(key, value)
      } catch {
        // kept in memory only
      }
    },
    removeItem(key) {
      memory.delete(key)
      try {
        local()?.removeItem(key)
      } catch {
        // nothing persisted to remove
      }
    },
  }
}

/** Stable per-(network, address) key for pending certifications. */
export function pendingCertifyKey(network: string, address: string): string {
  return `mw:walrus:pendingCertify:${network}:${address}`
}

/** One stored entry, copied field by field, or `null` if it is not a well-formed entry for `key`. */
function pendingEntry(key: string, v: unknown): PendingCertify | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (
    typeof e.blobId !== 'string' ||
    typeof e.blobObjectId !== 'string' ||
    e.blobObjectId !== key ||
    typeof e.certificate !== 'string' ||
    typeof e.deletable !== 'boolean' ||
    typeof e.savedAt !== 'number'
  ) {
    return null
  }
  return { blobId: e.blobId, blobObjectId: e.blobObjectId, certificate: e.certificate, deletable: e.deletable, savedAt: e.savedAt }
}

/**
 * The pending-certify map (keyed by blobObjectId); empty if none or corrupt. Browser storage is
 * untrusted: malformed entries are dropped (a tampered entry can at worst fail its own certify
 * transaction on-chain).
 */
export function loadPendingCertifies(storage: StorageLike, key: string): Record<string, PendingCertify> {
  const raw = storage.getItem(key)
  if (!raw || raw.length > 1_000_000) return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, PendingCertify> = {}
  for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
    const parsed = pendingEntry(id, entry)
    if (parsed) out[id] = parsed
  }
  return out
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

/** Relay access for one upload: prepare once, mint a token per attempt, signal once it has landed. */
export interface GatedAccess {
  /**
   * Make sure a single-use consume exists (spending one use on-chain and persisting its digest if
   * none is stored). Call it BEFORE register: the digest is persisted, so an interruption resumes
   * instead of consuming again. A no-op for an unlimited pass.
   */
  prepare(): Promise<void>
  /**
   * A fresh relay token: a new challenge, signed over the gateway's origin, gate, network and the
   * consume digest. Mint it right before the upload (a challenge lives minutes, not the time a
   * register approval can take). `forceFresh` spends a new use first (after a redeemed conflict); an
   * unusable stored digest (`dropStored`) is dropped and consumed anew.
   */
  token(opts?: { forceFresh?: boolean }): Promise<string>
  /** True if the consume in use was resumed from storage rather than spent in this run. */
  resumed(): boolean
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
  /** The `Gate` the relay guards (`0x` + 64 lower-case hex): signed into every proof. */
  gateId: string
  /** The Sui network the gateway serves: signed into every proof. */
  network: SuiNetwork
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
  /** Clock (tests). */
  now?: () => number
}

/** Oldest stored consume this client will resume (the gateways refuse a consume older than 5 days). */
export const CONSUME_RESUME_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000

/** A stored consume: the digest, the pass it spent a use of, and when. */
interface StoredConsume {
  digest: string
  nftId: string
  savedAt: number
}

/** The stored consume if it is well-formed, for this pass and recent; otherwise `null` (browser storage is untrusted). */
function readStoredConsume(storage: StorageLike, key: string, nftId: string, now: number): StoredConsume | null {
  const raw = storage.getItem(key)
  if (!raw || raw.length > 4096) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  if (typeof e.digest !== 'string' || !isTransactionDigest(e.digest)) return null
  if (typeof e.nftId !== 'string' || e.nftId !== nftId) return null
  if (typeof e.savedAt !== 'number' || !Number.isFinite(e.savedAt)) return null
  if (now - e.savedAt > CONSUME_RESUME_MAX_AGE_MS || e.savedAt > now + 60_000) return null
  return { digest: e.digest, nftId: e.nftId, savedAt: e.savedAt }
}

/**
 * Relay access that never burns a use on an interrupted upload.
 *
 * - A stored (unspent) consume is reused when it is well-formed, for this pass and recent: a fresh
 *   challenge, a free signature, no new consume. Anything else in storage is dropped.
 * - Otherwise one use is consumed on-chain and its digest persisted **before** the upload, so an
 *   interruption resumes instead of consuming again.
 * - `uploaded()` clears the stored digest; `token({ forceFresh: true })` consumes anew after a
 *   redeemed conflict.
 */
export function createGatedAccess<Tx>(ports: GatedAccessPorts<Tx>): GatedAccess {
  const challengeOf = ports.fetchChallenge ?? ((host: string) => fetchRelayChallenge(host))
  const now = ports.now ?? Date.now
  let resumedStored = false

  async function ensureConsume(forceFresh: boolean): Promise<string | undefined> {
    if (!ports.singleUse) return undefined
    if (forceFresh) ports.storage.removeItem(ports.key)
    const stored = readStoredConsume(ports.storage, ports.key, ports.nftId, now())
    if (stored) {
      resumedStored = true
      return stored.digest
    }
    ports.storage.removeItem(ports.key) // malformed, foreign or expired: never reused
    resumedStored = false
    ports.onStatus?.({ step: 'access', detail: 'Using one access pass (approve in wallet)…' })
    const challenge = await challengeOf(ports.relayHost)
    const res = await ports.signAndExecute(ports.buildConsume(ports.nftId, challenge.nonce))
    if (!res.digest || !isTransactionDigest(res.digest)) throw new Error('The consume transaction returned no valid digest.')
    ports.storage.setItem(ports.key, JSON.stringify({ digest: res.digest, nftId: ports.nftId, savedAt: now() } satisfies StoredConsume))
    // Best-effort: the gateway re-reads the consume with its own bounded retry, so an indexing
    // delay must not abort the upload; a failed consume is rejected by the gateway.
    await ports.waitForTransaction(res.digest).catch(() => {})
    return res.digest
  }

  return {
    async prepare() {
      await ensureConsume(false)
    },
    async token(opts) {
      const consumeDigest = await ensureConsume(opts?.forceFresh ?? false)
      const challenge = await challengeOf(ports.relayHost)
      ports.onStatus?.({ step: 'access', detail: 'Signing relay access (approve in wallet)…' })
      return buildAccessProof({
        address: ports.address,
        challenge: { nonce: challenge.nonce, expiresAt: 0 },
        sign: ports.sign,
        gateway: ports.relayHost,
        gateId: ports.gateId,
        network: ports.network,
        ...(consumeDigest ? { consumeDigest } : {}),
      })
    },
    resumed() {
      return resumedStored
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
  rpcUrl?: string
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
  /** Sui gRPC endpoint for the Walrus client (default: the public Mysten full node). */
  rpcUrl?: string
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
  /** Clock and delay (tests). */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Encode → [precheck] → register → upload → certify, resolving the blob id and URL. Two wallet
 * approvals (register, certify), plus the access step for a gated relay.
 *
 * - An existing copy aborts before register ({@link getDuplicateExisting}).
 * - The single-use consume is spent and persisted BEFORE register; the signed relay token is minted
 *   AFTER register, right before each upload attempt.
 * - A failed upload is retried on the same registration (bounded; see `uploadWithRetries`): a
 *   redeemed consume (409) spends one new use, a stale proof or transient failure gets a fresh
 *   token. When attempts run out, the error carries {@link getUploadRetry}.
 * - A certify failure throws with {@link getCertifyRetry}; the upload is never repeated.
 */
export async function runBlobUpload(deps: RunBlobUploadDeps): Promise<BlobUploadResult> {
  assertEpochs(deps.epochs) // before any wallet prompt or gas
  const load = deps.loadWalrusClient ?? (async (): Promise<WalrusClientModule> => await import('./index.js'))
  const { createWalrusClient, createBlobUploadFlow, walrusBlobUrl } = await load()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  // The consume (if single-use) is spent and persisted up front; the signed token is minted per
  // upload attempt, right before the relay is called (see `attempt` below).
  let token: string | undefined
  if (deps.access) {
    deps.onStatus({ step: 'access', detail: 'Confirming access…' })
    await deps.access.prepare()
  }

  const client = createWalrusClient({
    network: deps.network,
    ...(deps.rpcUrl ? { rpcUrl: deps.rpcUrl } : {}),
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
  const registeredAt = now()

  // One upload attempt on this registration. A gated relay gets a fresh challenge and signature
  // every time (a challenge outlives neither a slow approval nor a retry).
  const attempt = async (forceFresh: boolean): Promise<Awaited<ReturnType<BlobUploadFlow['upload']>>> => {
    if (deps.access) token = await deps.access.token({ forceFresh })
    deps.onStatus({ step: 'upload', detail: 'Uploading to the relay…' })
    return flow.upload({ digest: reg.digest, deletable })
  }

  // Upload with bounded same-registration retries. The relay accepts the registration's tip
  // transaction for its freshness window, so a transient failure must not cost a second paid
  // registration. What is retried, and how:
  //   - 409 `redeemed`  → spend a new use (the stored consume was redeemed by an earlier upload);
  //   - a rejected resumed consume (403) → drop it and consume anew, once;
  //   - 409 `leased`, 401/403 stale proof, 429, 5xx, network errors → a fresh token (no new consume).
  // Anything else (a 4xx that is not about the proof) is final.
  const uploadWithRetries = async (): Promise<Awaited<ReturnType<BlobUploadFlow['upload']>>> => {
    let forceFresh = false
    let reconsumed = false
    for (let n = 1; ; n++) {
      try {
        return await attempt(forceFresh)
      } catch (e) {
        forceFresh = false
        const fresh = now() - registeredAt <= REGISTRATION_FRESH_MS
        if (n >= UPLOAD_ATTEMPTS || !fresh) throw e
        if (deps.access && isRedeemedConflict(e)) {
          forceFresh = true
        } else if (deps.access && isConsumeRejected(e) && deps.access.resumed() && !reconsumed) {
          reconsumed = true
          forceFresh = true
        } else if (isLeasedConflict(e) || isStaleProof(e) || isRetryableUploadFailure(e)) {
          await sleep(UPLOAD_RETRY_DELAY_MS * n)
        } else {
          throw e
        }
      }
    }
  }

  // Certify is a plain owner transaction built from the certificate the live flow holds (no relay,
  // no tip); a retry rebuilds the same transaction.
  let uploaded: Awaited<ReturnType<BlobUploadFlow['upload']>>
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

  const uploadAndCertify = async (): Promise<BlobUploadResult> => {
    uploaded = await uploadWithRetries()
    deps.access?.uploaded()
    deps.onUploaded?.({
      blobId: uploaded.blobId,
      blobObjectId: uploaded.blobObjectId,
      certificate: uploaded.certificate,
      deletable,
    })
    try {
      return await runCertify()
    } catch (e) {
      attachCertifyRetry<BlobUploadResult>(e, runCertify)
      throw e
    }
  }

  try {
    return await uploadAndCertify()
  } catch (e) {
    // A failure before the upload landed leaves a paid registration; offer another try on it while
    // the relay still accepts it. (A certify failure carries `certifyRetry` instead.)
    if (!getCertifyRetry(e) && now() - registeredAt <= REGISTRATION_FRESH_MS) {
      attachUploadRetry<BlobUploadResult>(e, uploadAndCertify)
    }
    throw e
  }
}

/** Upload attempts per registration (the first plus retries). */
export const UPLOAD_ATTEMPTS = 3
/** Backoff unit between retries (multiplied by the attempt number). */
export const UPLOAD_RETRY_DELAY_MS = 2000
/** How long a registration's tip transaction stays acceptable to the relay (its default is 1 hour; this leaves margin). */
export const REGISTRATION_FRESH_MS = 50 * 60 * 1000

/** True for failures worth another attempt on the same registration: 429, 5xx, and errors with no HTTP status (network, timeout). */
function isRetryableUploadFailure(err: unknown): boolean {
  const status = httpStatusOf(err)
  if (status === null) return true
  return status === 429 || status >= 500
}
