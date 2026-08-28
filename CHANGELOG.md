# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
