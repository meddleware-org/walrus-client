# Security Policy

## Scope

This policy covers security issues in the `@meddleware/walrus-client` package source (`src/**`) —
the client factory, the upload-relay auth-token injection, the tip cap, blob upload/query/manage, and
lifetime management.

It does not cover:

- `@mysten/walrus` (incl. its WASM) or `@mysten/sui` (report upstream to
  [Mysten Labs](https://github.com/MystenLabs))
- The Walrus relay, aggregator, or Sui RPC endpoints the caller configures
- The `localnet/` testbed fixtures (ephemeral localnet key material, never published — see the note
  below)

## Security model (invariants)

These invariants are load-bearing. A report demonstrating that any is violated is in scope and
treated as high severity:

1. **The upload-relay Bearer token is scoped to the upload-relay origin only.** It is injected via a
   wrapped `fetch` passed solely into the upload-relay config; it is never attached to Sui RPC,
   storage-node, or aggregator requests. (Re-verify this on every `@mysten/walrus` upgrade.)
2. **The tip cap is enforced by `@mysten/walrus` before signing.** `uploadRelayMaxTipMist` (default
   50,000,000 MIST = 0.05 SUI, validated as a positive safe integer) is passed to the SDK's `sendTip.max`,
   which refuses a relay whose tip exceeds it. Re-verify this on every `@mysten/walrus` upgrade.
3. **No protocol addresses are hardcoded.** `walrusPackageConfig` is caller-supplied; a caller
   `rpcUrl` selects the endpoint for the client it constructs and never mutates the default map.
4. **No secrets are held at rest or logged.** Relay tokens are caller-supplied (optionally via a
   per-request provider function) and never persisted or logged.

## Data properties

- **Everything stored on Walrus is public** unless you encrypt it first (e.g. with Seal). The upload
  relay and publisher see the plaintext they are given.
- **Storage is time-limited**, not permanent: a blob lives for its epochs and must be extended.
  Blobs are registered permanent (non-deletable) by default, so they cannot be removed before expiry.
- **Ownership differs by path.** A wallet upload (`runBlobUpload`) registers the `Blob` object to the
  signing wallet. A publisher upload (`./http`) sends it to `sendObjectTo`, except when the publisher
  answers `alreadyCertified`: then no object is created for you and the blob lives only until the
  `endEpoch` it reports (see `PublishResult.kind`).
- **`readBlob` trusts the aggregator** for the bytes returned; no blob id is re-derived locally.

> **`uploadRelayHost` is a trust boundary.** The relay origin receives the (single-use, NFT-gated)
> access proof the caller hands it. Point it only at relays you trust; use `https` off-loopback.

## Supported versions

Only the latest published npm version receives security fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities by emailing **<security@meddleware.co.uk>**. Include:

- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept (if available)
- The package version or commit SHA you tested against

You will receive an acknowledgement within **3 business days** and a resolution plan within
**14 days** for confirmed issues. Critical issues (CVSS ≥ 9.0) are prioritised for same-day
acknowledgement.

## Disclosure

Once a fix is released, a security advisory will be published on the GitHub repository. Reporters
may be credited by name unless they prefer to remain anonymous.
