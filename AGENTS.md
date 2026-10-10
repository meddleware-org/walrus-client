# AGENTS.md — @meddleware/walrus-client

## Package identity

| Field | Value |
|---|---|
| npm name | `@meddleware/walrus-client` |
| Version | see `package.json` (the source of truth; patch bumps only until mainnet) |
| Licence | 0BSD |
| Type | TypeScript source package; `dist/` holds the `.d.ts` declarations only (`npm run build`) |
| Runtime targets | Node.js >=24 (`engines`), browsers (via Vite) |

## Package layout

```
walrus-client/
├── src/
│   ├── index.ts       — public re-exports of the root entry point (`.`)
│   ├── client.ts      — createWalrusClient(), host constants, WalrusNetwork type, relayAuthFetch
│   ├── limits.ts      — epoch and tip-cap validation (assertEpochs, assertTipCapMist)
│   ├── upload.ts      — uploadBytes, createUploadFlow, uploadImageBytes, createBlobUploadFlow
│   ├── manage.ts      — extendBlobLifetime, setBlobAttributes, readBlobAttributes (+ *Transaction variants)
│   ├── query.ts       — fetchOwnedWalrusBlobs
│   ├── access.ts      — NFT-gated relay access helpers (createRelayAccessToken, buildAccessProofToken, fetchRelayChallenge)
│   ├── flow.ts        — `./flow`: headless upload orchestrator (register/upload/certify, single-use consume, resume)
│   ├── http.ts        — `./http`: publisher and aggregator over plain fetch (no @mysten imports)
│   └── node.ts        — `./node`: Node-only filesystem upload (uploadLocalFile)
├── tests/             — vitest unit tests (mocked client), packaging and release-gate tests
│   └── integration/   — localnet suite (needs the Docker testbed; `npm run test:integration`)
├── localnet/          — Docker localnet harness (not published)
├── .github/           — CI: node-ci, integration (nightly localnet), npm-publish, localnet-gate.mjs
├── docs/audit/        — the audit record
├── tsconfig.json      — type-check (src + tests)
├── tsconfig.build.json — declarations only, into dist/
├── package.json
├── CHANGELOG.md
├── CLAUDE.md          — invariants
├── SECURITY.md        — shipped in the tarball
├── AGENTS.md          — this file
├── LICENSE
└── README.md
```

## Key modules

| Module | Responsibility |
|---|---|
| `client.ts` | Factory function + network constants. Entry point for all consumers. |
| `upload.ts` | Node and browser upload paths. `createUploadFlow` is the browser-safe multi-step variant. |
| `flow.ts` | `runBlobUpload` and the resume conventions (fresh register, persisted consume, same-registration retry). Conflict handling reads nft-gate-client's `GATEWAY_CONFLICT_CODES` through `parseGatewayError`. |
| `http.ts` | Publisher store and aggregator read over `fetch`; https only, bounded responses, no redirects. |
| `manage.ts` | Blob lifetime extension and attribute CRUD. `*Transaction` variants return unsigned `Transaction` for wallet signing. |
| `query.ts` | Owned-blob enumeration. Uses dynamic type resolution — no hardcoded package addresses. |
| `access.ts` | Challenge/proof construction for NFT-gated relay. Wire format must match `nft-gate` gateway. |

## Key constants

| Constant | Location | Value |
|---|---|---|
| `DEFAULT_RPC_URLS` | `client.ts` | Public Mysten fullnode URLs (testnet/mainnet) |
| `PUBLIC_UPLOAD_RELAY_HOSTS` | `client.ts` | Public Mysten upload relay hosts (default when no `uploadRelayHost` is passed) |
| `WALRUS_AGGREGATOR_HOSTS` | `client.ts` | Public Walrus aggregator hosts |
| `DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST` | `client.ts` | 50,000,000 MIST (0.05 SUI) tip ceiling |
| `MAX_SINGLE_RESERVATION_EPOCHS` | `limits.ts` | 53 — Walrus `max_epochs_ahead` fallback |
| `LONG_TERM_EPOCHS` | `upload.ts` | 200 — ~7.7 years (requires renewal) |

## Commands

```bash
npm run type-check   # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run (unit)
npm run build        # declarations into dist/ (tsc -p tsconfig.build.json)
npm run test:integration   # localnet suite; needs localnet/scripts/up.sh + bootstrap-localnet.sh first
```

## Publish instructions

The package ships TypeScript source (consumed by Vite bundlers) plus generated `.d.ts` files in
`dist/`. Publishing runs from CI on a `v*` tag (npm trusted publishing, `npm-publish.yml`); the
`prepublishOnly` script rebuilds the declarations.

Checklist before tagging a new version:
1. Update `version` in `package.json` (and the lockfile root entry: `npm version patch --no-git-tag-version`)
2. Add entry to `CHANGELOG.md`
3. Verify `npm run type-check`, `npm run lint`, `npm test` and `npm run build` pass
4. Confirm `@mysten/sui` and `@mysten/walrus` dep versions match the target Sui/Walrus testnet release
5. Make sure the localnet suite is green: the publish workflow's `localnet-gate` blocks a tag while the
   newest "Integration (localnet)" run on main is red or older than 72 h. After a fix, dispatch the
   workflow on main (or on the commit you will tag) and wait for it to pass before pushing the tag.

## Consumers

This package is the published Walrus storage/client layer. When making breaking changes,
coordinate with its downstream consumers:

- [`@meddleware/walrus-relay`](https://github.com/meddleware-org/walrus-relay) — relay UI library
  (wires `createWalrusClient` / `createBlobUploadFlow` into the upload widget)
- [`@meddleware/walrus-ui`](https://github.com/meddleware-org/walrus-ui) — standalone uploader app
- `token-deployer-sui` — token icon upload

Its own upstream dependency is [`@meddleware/nft-gate-client`](https://github.com/meddleware-org/nft-gate-client)
(the access-proof wire format re-exported from `src/access.ts`).
