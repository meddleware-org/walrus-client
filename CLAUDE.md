# CLAUDE.md — @meddleware/walrus-client

## Invariants

- **No build step.** The package ships TypeScript source directly. Entry points:
  - `"."` → `src/index.ts`, browser-safe;
  - `"./flow"` → `src/flow.ts`, the upload orchestrator, lazy about wasm;
  - `"./http"` → `src/http.ts`, publisher and aggregator over plain `fetch`;
  - `"./node"` → `src/node.ts`, Node.js only (filesystem utilities).

  Vite apps resolve the source through their own bundler. Do not add a `build` script or `dist/`
  output. Node.js-only imports must use `@meddleware/walrus-client/node`, to avoid warnings about
  Node-only modules in browser bundles.
- **No hardcoded package addresses.** Walrus object type resolution must remain dynamic (see `query.ts`). Never introduce hardcoded Walrus package IDs — they differ between testnet and mainnet.
- **`disableUploadRelay` is a safety valve, not the default.** The relay is required for browser uploads. Direct-to-storage-node only works from Node.js (or when the relay is explicitly unavailable). Default relay fallback must remain `PUBLIC_UPLOAD_RELAY_HOSTS[network]` (Mysten public relay — correct for any operator; operators with their own relay pass `uploadRelayHost` explicitly).
- **`rpcUrl` overrides `DEFAULT_RPC_URLS`, never removes them.** The default URLs must always be present so the client works out-of-the-box without configuration.
- **Access proof format is the wire format.** The challenge/proof helpers in `access.ts` must stay compatible with the `nft-gate` gateway wire protocol (`nft-gate:access:v2`, an audience-bound message: gateway origin, gate, network, nonce, consume digest). Do not change the encoding without coordinating with the gateway.
- **Relay auth is injected via `fetch`, not `headers`.** `@mysten/walrus`'s `UploadRelayClient` options are only `{ host, fetch, timeout, onError }` — there is **no `headers` option** (a `headers` key is silently dropped, so a gated relay never sees the token and returns `401 missing access proof`). `createWalrusClient` therefore threads `uploadRelayAuthToken` by wrapping `globalThis.fetch` and setting `Authorization: Bearer <token>` on every relay request. The token may be a **provider function resolved per request** (not just a static string) so a retained upload flow can be resumed with a fresh challenge signature — the injected `fetch` reads the current token on each call. Do **not** revert to passing `uploadRelay.headers`. Re-verify this wiring whenever `@mysten/walrus` is upgraded — if the SDK later adds a first-class `headers`/auth option, migrate deliberately and update `tests/client.test.ts`.
- **`./flow` never imports the package root statically.** It loads it through `loadWalrusClient`
  (a dynamic import by default), so apps keep `@mysten/walrus` wasm out of their eager bundle. It
  may import `./access.js` and `@meddleware/nft-gate-client` (no wasm). The flow's invariants:
  - register fresh on every attempt, never resumed across loads (the relay rejects an old register tx);
  - persist `{ digest, nftId, savedAt }` before register and validate it before reuse; clear it once
    the upload lands;
  - mint the signed token AFTER register, right before each upload attempt;
  - retry a failed upload on the same registration within `REGISTRATION_FRESH_MS`, bounded by
    `UPLOAD_ATTEMPTS`, with a fresh token each time; re-consume only on `isRedeemedConflict` (or a
    rejected resumed consume, once); attach `uploadRetry` when attempts run out;
  - a certify-only failure carries a retry and never repeats the upload;
  - the existing-copy precheck runs before register.
  The flow is access_gate-agnostic: the consume builder is injected.
- **`./http` imports nothing from `@mysten/*`.** It is plain `fetch` against a publisher and
  aggregator, https only (http only for localhost), and stores blobs permanent.
- **`LONG_TERM_EPOCHS` and `MAX_SINGLE_RESERVATION_EPOCHS` are not arbitrary.** They reflect Walrus protocol constraints. Update them only when the Walrus protocol changes `max_epochs_ahead`.
- **Browser storage through `browserStorage()`.** Apps pass it (never `window.localStorage`, whose access can throw) to the flow's storage ports.
- **No secrets in source.** Relay auth tokens, keypairs, and credentials are caller-supplied at runtime. Never hardcode them.
- **0BSD licence.** Do not change the licence.
- **`uploadRelayMaxTipMist` is a library default, not a hardcoded income value.** The `DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST` (50,000,000 MIST = 0.05 SUI) default in `client.ts` bounds relay tip payments: ~8× the worst-case tip of the operator's linear relay at the 100 MiB edge cap, so a hostile relay is bounded but no legitimate upload fails (the previous 1,000,000 default sat *below* the operator relay's minimum tip). Callers override it via `CreateWalrusClientOptions`. Do not treat it as a commission parameter — the on-chain commission is enforced by the `PlatformConfig` object in `access_gate`.
- **`access.ts` imports from `@meddleware/nft-gate-client`.** The Walrus-specific aliases (`RelayChallenge`, `AccessProofInput`, `buildAccessProofToken`, `fetchRelayChallenge`) are thin re-exports kept for API stability. The unique piece is `createRelayAccessToken` (one-shot: challenge → sign → encode).
- **No ABI-drift test here (workspace B8).** This package builds no Move calls of its own: every
  transaction comes from `@mysten/walrus`, which resolves the Walrus system and staking objects from
  `TESTNET_/MAINNET_WALRUS_PACKAGE_CONFIG` at run time and tracks their upgrades itself. Drift shows
  up as an `@mysten/walrus` release, so keep that dependency current instead. Add a drift test (as in
  access-gate-client) if a direct `tx.moveCall` is ever added.

---

## Deferred documentation — NOT for the `docs.` website (planned here per Part 0.4)

> Captured for the future **`dev.meddleware.co.uk`** subdomain and white-label offering; excluded
> from the user-facing `docs.` site. The user-facing Walrus Storage docs cover *what/how/when* only.

### `dev.` — developer integration (to write later)

- **Full SDK reference** (TypeDoc target — everything is exported from `src/index.ts` with doc
  comments): `createWalrusClient`, the upload flows (`uploadBytes`/`createUploadFlow`/…), lifetime
  management (`extendBlobLifetime`, `estimateStorageCost`, `setBlobAttributes`), `fetchOwnedWalrusBlobs`,
  and the relay access-proof helpers.
- **Integration recipes:** Node vs browser upload; the epoch/lifetime model and
  `LONG_TERM_EPOCHS`/`MAX_SINGLE_RESERVATION_EPOCHS` constraints; resuming a gated upload with a
  per-request `uploadRelayAuthToken` provider function.
- **Schemas:** `UploadResult`, `OwnedBlob`, `StorageCost`, `RelayChallenge`/`AccessProofInput` shapes;
  the `nft-gate:access:v2` proof wire format (source of truth: `@meddleware/nft-gate-client`).

### White-label (to write later)

- Running against an operator's **own upload relay** (`uploadRelayHost`) and RPC (`rpcUrl` overrides,
  never removes, `DEFAULT_RPC_URLS`); the `uploadRelayMaxTipMist` tip ceiling; how relay commission is
  enforced by `PlatformConfig`/`access_gate`, not by this library.
