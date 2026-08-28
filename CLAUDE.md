# CLAUDE.md — @meddleware/walrus-client

## Invariants

- **No build step.** The package ships TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Vite apps that consume it resolve through their own bundler. Do not add a `build` script or `dist/` output.
- **No hardcoded package addresses.** Walrus object type resolution must remain dynamic (see `query.ts`). Never introduce hardcoded Walrus package IDs — they differ between testnet and mainnet.
- **`disableUploadRelay` is a safety valve, not the default.** The relay is required for browser uploads. Direct-to-storage-node only works from Node.js (or when the relay is explicitly unavailable). Default relay fallback must remain `PUBLIC_UPLOAD_RELAY_HOSTS[network]` (Mysten public relay — correct for any operator; operators with their own relay pass `uploadRelayHost` explicitly).
- **`rpcUrl` overrides `DEFAULT_RPC_URLS`, never removes them.** The default URLs must always be present so the client works out-of-the-box without configuration.
- **Access proof format is the wire format.** The challenge/proof helpers in `access.ts` must stay compatible with the `nft-gate` gateway wire protocol (`nft-gate:access:<nonce>` personal message prefix). Do not change the encoding without coordinating with the gateway.
- **`LONG_TERM_EPOCHS` and `MAX_SINGLE_RESERVATION_EPOCHS` are not arbitrary.** They reflect Walrus protocol constraints. Update them only when the Walrus protocol changes `max_epochs_ahead`.
- **No secrets in source.** Relay auth tokens, keypairs, and credentials are caller-supplied at runtime. Never hardcode them.
- **0BSD licence.** Do not change the licence.

## Deferred work

- `access.ts` TODO: once `@meddleware/nft-gate-client` is published, import `fetchChallenge`/`buildAccessProof`/`personalMessageForNonce` from it and delete the duplicated helpers (keep `access.ts` as the thin Walrus-facing wrapper only).
