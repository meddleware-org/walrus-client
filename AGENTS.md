# AGENTS.md — @meddleware/walrus-client

## Package identity

| Field | Value |
|---|---|
| npm name | `@meddleware/walrus-client` |
| Version | `0.0.1` |
| Licence | 0BSD |
| Type | TypeScript source package (no build step) |
| Runtime targets | Node.js ≥22, browsers (via Vite) |

## Package layout

```
packages/walrus-client/
├── src/
│   ├── index.ts       — public re-exports (all symbols pass through here)
│   ├── client.ts      — createWalrusClient(), host constants, WalrusNetwork type
│   ├── upload.ts      — uploadBytes, uploadLocalFile, createUploadFlow, uploadImageBytes, createBlobUploadFlow
│   ├── manage.ts      — extendBlobLifetime, setBlobAttributes, readBlobAttributes (+ *Transaction variants)
│   ├── query.ts       — fetchOwnedWalrusBlobs
│   └── access.ts      — NFT-gated relay access helpers (createRelayAccessToken, buildAccessProofToken, fetchRelayChallenge)
├── tests/             — vitest unit tests (mocked client)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── CLAUDE.md
├── AGENTS.md          — this file
├── LICENSE
└── README.md
```

## Key modules

| Module | Responsibility |
|---|---|
| `client.ts` | Factory function + network constants. Entry point for all consumers. |
| `upload.ts` | Node and browser upload paths. `createUploadFlow` is the browser-safe multi-step variant. |
| `manage.ts` | Blob lifetime extension and attribute CRUD. `*Transaction` variants return unsigned `Transaction` for wallet signing. |
| `query.ts` | Owned-blob enumeration. Uses dynamic type resolution — no hardcoded package addresses. |
| `access.ts` | Challenge/proof construction for NFT-gated relay. Wire format must match `nft-gate` gateway. |

## Key constants

| Constant | Location | Value |
|---|---|---|
| `DEFAULT_RPC_URLS` | `client.ts` | Public Mysten fullnode URLs (testnet/mainnet) |
| `PUBLIC_UPLOAD_RELAY_HOSTS` | `client.ts` | Public Mysten upload relay hosts (default when no `uploadRelayHost` is passed) |
| `WALRUS_AGGREGATOR_HOSTS` | `client.ts` | Public Walrus aggregator hosts |
| `MAX_SINGLE_RESERVATION_EPOCHS` | `upload.ts` | 53 — Walrus `max_epochs_ahead` |
| `LONG_TERM_EPOCHS` | `upload.ts` | 200 — ~7.7 years (requires renewal) |

## Commands

```bash
npm run type-check   # tsc --noEmit
npm test             # vitest run
npm run test:watch   # vitest (interactive)
```

## Publish instructions

This package ships TypeScript source and is consumed by Vite bundlers. No build step is required before publishing.

```bash
npm publish --access public
```

Checklist before publishing a new version:
1. Update `version` in `package.json`
2. Add entry to `CHANGELOG.md`
3. Verify `npm run type-check` passes
4. Verify `npm test` passes
5. Confirm `@mysten/sui` and `@mysten/walrus` dep versions match the target Sui/Walrus testnet release

## Consumers

This package is the published Walrus storage/client layer. When making breaking changes,
coordinate with its downstream consumers:

- [`@meddleware/walrus-relay`](https://github.com/meddleware-org/walrus-relay) — relay UI library
  (wires `createWalrusClient` / `createBlobUploadFlow` into the upload widget)
- [`@meddleware/walrus-ui`](https://github.com/meddleware-org/walrus-ui) — standalone uploader app
- `token-deployer-sui` — token icon upload

Its own upstream dependency is [`@meddleware/nft-gate-client`](https://github.com/meddleware-org/nft-gate-client)
(the access-proof wire format re-exported from `src/access.ts`).
