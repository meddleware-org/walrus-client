# CLAUDE.md — @meddleware/walrus-client

## Invariants

- **No build step.** The package ships TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Vite apps that consume it resolve through their own bundler. Do not add a `build` script or `dist/` output.
- **No hardcoded package addresses.** Walrus object type resolution must remain dynamic (see `query.ts`). Never introduce hardcoded Walrus package IDs — they differ between testnet and mainnet.
- **`disableUploadRelay` is a safety valve, not the default.** The relay is required for browser uploads. Direct-to-storage-node only works from Node.js (or when the relay is explicitly unavailable). Default relay fallback must remain `PUBLIC_UPLOAD_RELAY_HOSTS[network]` (Mysten public relay — correct for any operator; operators with their own relay pass `uploadRelayHost` explicitly).
- **`rpcUrl` overrides `DEFAULT_RPC_URLS`, never removes them.** The default URLs must always be present so the client works out-of-the-box without configuration.
- **Access proof format is the wire format.** The challenge/proof helpers in `access.ts` must stay compatible with the `nft-gate` gateway wire protocol (`nft-gate:access:<nonce>` personal message prefix). Do not change the encoding without coordinating with the gateway.
- **Relay auth is injected via `fetch`, not `headers`.** `@mysten/walrus`'s `UploadRelayClient` options are only `{ host, fetch, timeout, onError }` — there is **no `headers` option** (a `headers` key is silently dropped, so a gated relay never sees the token and returns `401 missing access proof`). `createWalrusClient` therefore threads `uploadRelayAuthToken` by wrapping `globalThis.fetch` and setting `Authorization: Bearer <token>` on every relay request. Do **not** revert to passing `uploadRelay.headers`. Re-verify this wiring whenever `@mysten/walrus` is upgraded — if the SDK later adds a first-class `headers`/auth option, migrate deliberately and update `tests/client.test.ts`.
- **`LONG_TERM_EPOCHS` and `MAX_SINGLE_RESERVATION_EPOCHS` are not arbitrary.** They reflect Walrus protocol constraints. Update them only when the Walrus protocol changes `max_epochs_ahead`.
- **No secrets in source.** Relay auth tokens, keypairs, and credentials are caller-supplied at runtime. Never hardcode them.
- **0BSD licence.** Do not change the licence.
- **`uploadRelayMaxTipMist` is a library default, not a hardcoded income value.** The 1,000,000 MIST default in `client.ts` is a sensible cap on relay tip payments. Callers override it via `CreateWalrusClientOptions`. Do not treat it as a commission parameter — the on-chain commission is enforced by the `PlatformConfig` object in `access_gate`.
- **`access.ts` imports from `@meddleware/nft-gate-client`.** The Walrus-specific aliases (`RelayChallenge`, `AccessProofInput`, `buildAccessProofToken`, `fetchRelayChallenge`) are thin re-exports kept for API stability. The unique piece is `createRelayAccessToken` (one-shot: challenge → sign → encode).
