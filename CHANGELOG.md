# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
