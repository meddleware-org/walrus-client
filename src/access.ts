/**
 * NFT-gated relay access helpers.
 *
 * When the Meddleware upload relay runs behind an `nft-gate` auth gateway, an upload must
 * carry a wallet-signed **access proof** proving the caller holds the required access NFT.
 * These helpers build that proof; the resulting token is passed to
 * `createWalrusClient({ uploadRelayAuthToken })`, which threads it as the relay
 * `Authorization: Bearer` header (see `client.ts`).
 *
 * Core primitives are imported from `@meddleware/nft-gate-client` (the canonical package).
 * This module re-exports them under Walrus-friendly aliases and adds the one-shot
 * `createRelayAccessToken` convenience function.
 */

import {
  type Challenge,
  type AccessProof,
  type PersonalMessageSigner,
  type SuiNetwork,
  personalMessage,
  encodeAccessProof,
  buildAccessProof,
  fetchChallenge,
} from '@meddleware/nft-gate-client'

// ── Re-exports under Walrus-client aliases ────────────────────────────────────

/** A server-issued, time-bound challenge from the gateway's `GET /v1/challenge`. */
export type RelayChallenge = Challenge

/** The proof payload; `consumeDigest` is present only for single-use gates. */
export type AccessProofInput = AccessProof

/** A wallet personal-message signer (e.g. wallet-standard `sui:signPersonalMessage`). */
export type { PersonalMessageSigner, SuiNetwork }

/**
 * The exact bytes the wallet signs: the audience-bound `nft-gate:access:v2` message (gateway origin,
 * gate, network, nonce and, for single-use gateways, the consume digest). MUST match the gateway's
 * derivation.
 */
export { personalMessage }

/**
 * Encode a proof as the base64(JSON) Bearer token the relay auth header carries.
 *
 * @throws {Error} if `JSON.stringify` or `btoa` is unavailable in the environment.
 */
export function buildAccessProofToken(proof: AccessProofInput): string {
  return encodeAccessProof(proof)
}

/**
 * Fetch a fresh challenge from the gateway's `GET /v1/challenge` endpoint. The relay host must be
 * `https:` (loopback `http:` allowed); redirects are refused, the body is size-capped, and the
 * request aborts after `opts.timeoutMs` (default 10 s) or on `opts.signal`.
 *
 * @throws {Error} if the network request fails or the gateway returns a non-2xx status.
 * @throws {Error} if the response lacks a valid `nonce` or a positive numeric `expiresAt`.
 */
export function fetchRelayChallenge(
  relayHost: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RelayChallenge> {
  return fetchChallenge(relayHost, opts)
}

/**
 * One-shot: fetch a challenge, sign it with the wallet, and return the encoded proof token
 * to pass as `createWalrusClient({ uploadRelayAuthToken })`. The signature binds the relay's origin,
 * the gate and the network, so the token works nowhere else. For single-use gates, supply the
 * `consumeDigest` of the on-chain consume transaction.
 *
 * @throws {Error} if the challenge fetch fails or an input is not in its canonical form.
 * @throws {Error} if the wallet signer rejects the message.
 */
export async function createRelayAccessToken(opts: {
  relayHost: string
  address: string
  /** The `Gate` the relay guards (`0x` + 64 lower-case hex). */
  gateId: string
  network: SuiNetwork
  sign: PersonalMessageSigner
  consumeDigest?: string
  signal?: AbortSignal
}): Promise<string> {
  const challenge = await fetchChallenge(opts.relayHost, { signal: opts.signal })
  return buildAccessProof({
    address: opts.address,
    challenge,
    sign: opts.sign,
    gateway: opts.relayHost,
    gateId: opts.gateId,
    network: opts.network,
    ...(opts.consumeDigest ? { consumeDigest: opts.consumeDigest } : {}),
  })
}
