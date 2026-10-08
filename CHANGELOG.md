# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.26] - 2026-10-08

### Changed (breaking, pre-v0.2)

- **Access proofs are audience-bound** (`@meddleware/nft-gate-client` 0.0.16): `createRelayAccessToken`
  and `createGatedAccess` take the `gateId` and `network` and sign `nft-gate:access:v2` over the
  relay's origin, gate, network, nonce and consume digest. `personalMessageForNonce` is now
  `personalMessage`.
- **A failed upload no longer costs a second registration.** The signed token is minted after
  register, right before each upload attempt, and a failed upload is retried on the same registration
  (up to 3 attempts, a fresh token each time) for a relay 5xx, a network error, a stale challenge or a
  `leased` conflict; `redeemed` still spends a new use. When attempts run out the error carries
  `getUploadRetry(err)`. `GatedAccess` gains `prepare()` and `resumed()`; `token(forceFresh)` is now
  `token({ forceFresh })`.
- **The stored consume is validated.** It is persisted as `{ digest, nftId, savedAt }`; a value that is
  malformed, for another pass, over 4 days old or from the future is dropped, and a resumed consume
  the gateway rejects (403) is consumed anew once. A consume result without a valid base58 digest is
  refused instead of stored.
- `epochs` must be an integer from 1 to the network's `max_epochs_ahead` (read live, 53 fallback) and
  `uploadRelayMaxTipMist` a positive safe integer, both checked before any wallet prompt.
- `./http`: `storeBlobViaPublisher` returns `{ blobId, kind, endEpoch?, blobObjectId? }` (an
  `alreadyCertified` answer creates no Blob object for you); redirects are refused and responses are
  size-capped; the aggregator trust is documented.
- `@mysten/sui` and `@mysten/walrus` are **peer dependencies** (`^2.33.2`, `~1.2.32`), also dev
  dependencies; `legacy-peer-deps` is gone and `npm ls --all` runs in CI.
- `SECURITY.md` states the real tip-cap behaviour and the Walrus data properties.

### Added

- Tests: the real SDK calls the relay `fetch` hook (hermetic), `manage.ts` first-write and
  missing-attribute paths, `uploadImageBytes` / `createBlobUploadFlow`.

## [0.0.25] - 2026-10-03

### Changed

- `@meddleware/nft-gate-client` ^0.0.15 (`sideEffects: false`).

## [0.0.24] - 2026-10-02

### Added

- `browserStorage()` (`./flow`): the page's `localStorage` as a `StorageLike` that never throws; where
  storage is unavailable (blocked site data, private modes, sandboxed frames) values stay in memory for
  the page. Apps pass it to the flow helpers instead of `window.localStorage`, whose mere access can
  throw.

### Changed

- `"sideEffects": false`: no module has import-time effects.

## [0.0.23] - 2026-10-02

### Changed

- `fetchOwnedWalrusBlobs` pages at most `MAX_OWNED_BLOB_PAGES` (100) and throws past it instead of
  looping on a node that always reports another page; objects are re-checked against the exact
  (normalised) Blob type; a blob with a missing or malformed id, size or end epoch is skipped
  instead of listed with an invented value (an end epoch of 0 used to show it as expired).
- `readBlob` caps the bytes it reads (`maxBytes`, default 100 MiB), on the declared length and while
  streaming.
- `storeBlobViaPublisher` requires a well-formed blob id in the publisher's response.
- `loadPendingCertifies` validates each stored entry field by field (the key must equal its
  `blobObjectId`) and drops malformed ones.
- `walrusBlobUrl` encodes the blob id.
- `noUncheckedIndexedAccess` is on; `uploadFile` throws if the SDK returns no write result.

## [0.0.22] - 2026-10-02

### Changed

- `@meddleware/nft-gate-client` 0.0.14: relay challenge requests time out (10 s by default,
  `timeoutMs` on `fetchRelayChallenge`), require an `https:` relay host (loopback `http:` allowed)
  and validate the response. The gated upload flow no longer waits forever on a hung gateway.

## [0.0.21] - 2026-10-01

### Added

- `runBlobUpload({ rpcUrl })`: the Sui endpoint for the Walrus client (default: the public Mysten
  full node), so an app's own RPC setting applies to uploads.

## [0.0.20] - 2026-09-30

### Added

- **`@meddleware/walrus-client/flow`** — the headless upload orchestrator `runBlobUpload`, moved
  from walrus-ui.
  - Relay access: `createGatedAccess` and `GatedAccess`.
  - Error conventions: `attachCertifyRetry` / `getCertifyRetry` and
    `attachDuplicateExisting` / `getDuplicateExisting`.
  - `isRedeemedConflict`, which also matches the message form and wrapped causes.
  - Persistence helpers: `consumeStorageKey`, `pendingCertifyKey`, `savePendingCertify`,
    `loadPendingCertifies`, `clearPendingCertify`.
  - Types: `UploadProgress`, `UploadStepKey`, `BlobUploadResult`, `ExistingCopy`, `StorageLike`.
  - A redeemed consume now retries the upload on the same registration instead of registering
    again.
  - An unlimited pass signs without consuming.
- **`@meddleware/walrus-client/http`** — `storeBlobViaPublisher`, `readBlob` and
  `requireHttpsEndpoint`, moved from seal-ui.

### Changed

- `@meddleware/nft-gate-client` `^0.0.13` (wire protocol only).

## [0.0.13] - 2026-09-17

### Added

- `homepage` in `package.json` — links to the Walrus Storage section of the documentation site.

### Changed

- Pinned `@meddleware/nft-gate-client` dependency to `~0.0.8`.

## [0.0.1] - 2026-08-27

### Added

- Initial release as `@meddleware/walrus-client` (renamed from internal `@meddleware/sui-walrus`)
- `createWalrusClient()` — configurable Walrus client factory with upload relay, WASM, and `rpcUrl` override support
- `uploadBytes` / `uploadLocalFile` — Node.js and browser blob upload (quilt)
- `uploadImageBytes` / `createBlobUploadFlow` — raw-blob variants for wallet/explorer-renderable assets
- `createUploadFlow` — multi-step browser upload flow for wallet-popup-safe signing
- `extendBlobLifetime` / `extendBlobLifetimeTransaction` — extend blob storage before expiry
- `setBlobAttributes` / `setBlobAttributesTransaction` / `readBlobAttributes` — on-chain metadata management
- `fetchOwnedWalrusBlobs` — enumerate all Walrus blobs owned by an address (dynamic type resolution, no hardcoded addresses)
- `createRelayAccessToken` / `buildAccessProofToken` / `fetchRelayChallenge` — NFT-gated relay access helpers
- Exported constants: `DEFAULT_RPC_URLS`, `PUBLIC_UPLOAD_RELAY_HOSTS`, `WALRUS_AGGREGATOR_HOSTS`
- `disableUploadRelay` option to bypass relay and write directly to Walrus storage nodes
