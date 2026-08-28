/**
 * NFT-gated relay access helpers.
 *
 * When the MeddleWare upload relay runs behind an `nft-gate` auth gateway, an upload must
 * carry a wallet-signed **access proof** proving the caller holds the required access NFT.
 * These helpers build that proof; the resulting token is passed to
 * `createWalrusClient({ uploadRelayAuthToken })`, which threads it as the relay
 * `Authorization: Bearer` header (see `client.ts`).
 *
 * The wire format mirrors `@meddleware/nft-gate-client` (challenge, signed message, and
 * base64-JSON proof token). It is duplicated here — rather than depended upon — so this
 * package stays self-contained; the gateway (`nft-gate-gateway`) is the authority that
 * verifies these proofs.
 *
 * TODO(unify): once `@meddleware/nft-gate-client` is published (from the `nft-gate`
 * standalone workspace, canonical vault location `blockchain/sui/packages/nft-gate-client-sui/`),
 * import `fetchChallenge`/`buildAccessProof`/`personalMessageForNonce` from it and delete the
 * duplicated logic below (keep this module as the thin Walrus-facing wrapper).
 */

/** A server-issued, time-bound challenge from the gateway's `GET /v1/challenge`. */
export interface RelayChallenge {
  nonce: string
  expiresAt: number
}

/** The proof payload; `consumeDigest` is present only for single-use gates. */
export interface AccessProofInput {
  address: string
  nonce: string
  signature: string
  consumeDigest?: string
}

/** A wallet personal-message signer (e.g. wallet-standard `sui:signPersonalMessage`). */
export type PersonalMessageSigner = (message: Uint8Array) => Promise<{ signature: string }>

/** The exact bytes the wallet signs for a nonce. MUST match the gateway's derivation. */
export function personalMessageForNonce(nonce: string): Uint8Array {
  return new TextEncoder().encode(`nft-gate:access:${nonce}`)
}

function toBase64(s: string): string {
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf-8').toString('base64')
}

/** Encode a proof as the base64(JSON) Bearer token the relay auth header carries. */
export function buildAccessProofToken(proof: AccessProofInput): string {
  const payload: AccessProofInput = {
    address: proof.address,
    nonce: proof.nonce,
    signature: proof.signature,
  }
  if (proof.consumeDigest) payload.consumeDigest = proof.consumeDigest
  return toBase64(JSON.stringify(payload))
}

/** Fetch a fresh challenge from the gateway. Tolerates `expiresAt` or `expires_at`. */
export async function fetchRelayChallenge(
  relayHost: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RelayChallenge> {
  const res = await fetch(`${relayHost.replace(/\/$/, '')}/v1/challenge`, { signal: opts.signal })
  if (!res.ok) throw new Error(`challenge request failed: ${res.status}`)
  const data = (await res.json()) as { nonce?: string; expiresAt?: number; expires_at?: number }
  if (!data || typeof data.nonce !== 'string') throw new Error('challenge response missing nonce')
  return { nonce: data.nonce, expiresAt: data.expiresAt ?? data.expires_at ?? 0 }
}

/**
 * One-shot: fetch a challenge, sign it with the wallet, and return the token to pass as
 * `createWalrusClient({ uploadRelayAuthToken })`. For single-use gates, supply the
 * `consumeDigest` of the on-chain consume transaction first.
 */
export async function createRelayAccessToken(opts: {
  relayHost: string
  address: string
  sign: PersonalMessageSigner
  consumeDigest?: string
  signal?: AbortSignal
}): Promise<string> {
  const challenge = await fetchRelayChallenge(opts.relayHost, { signal: opts.signal })
  const message = personalMessageForNonce(challenge.nonce)
  const { signature } = await opts.sign(message)
  return buildAccessProofToken({
    address: opts.address,
    nonce: challenge.nonce,
    signature,
    consumeDigest: opts.consumeDigest,
  })
}
