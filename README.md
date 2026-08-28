# @meddleware/walrus-client

Walrus decentralised storage client and asset management utilities for Sui applications.

[![License: 0BSD](https://img.shields.io/badge/License-0BSD-blue.svg)](LICENSE)

This package provides configuration, upload helpers, and lifetime management for storing assets (images, metadata, documents) on Walrus — a decentralised storage network integrated with Sui. It works in both Node.js (scripts, deployment tools) and the browser (Vite apps with wallet signing).

## Product semantics

**Walrus is NOT permanent storage.** All blobs expire after their epoch count runs out. A Walrus epoch is approximately 2 weeks.

- Recommended default: **200 epochs** ≈ 7.7 years (exported as `LONG_TERM_EPOCHS`)
- **Before expiry:** Use `extendBlobLifetime()` to renew the blob
- **Deletable blobs:** Set `deletable: true` only if cleanup is guaranteed before expiry; otherwise blobs cannot be recovered

> A single Walrus reservation cannot exceed `max_epochs_ahead` (53 on testnet/mainnet, exported as `MAX_SINGLE_RESERVATION_EPOCHS`). Reaching `LONG_TERM_EPOCHS` requires periodic renewal via `extendBlobLifetime()`.

## Quick start

### Node.js (deployment script)

```typescript
import { createWalrusClient, uploadLocalFile, LONG_TERM_EPOCHS } from '@meddleware/walrus-client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import * as fs from 'node:fs'

const keypair = Ed25519Keypair.fromSecretKey(fs.readFileSync('.secrets/keypair', 'utf-8'))
const client = createWalrusClient({ network: 'mainnet' })

const { blobId } = await uploadLocalFile(
  client,
  'assets/icon.png',
  'icon.png',
  keypair,
  { epochs: LONG_TERM_EPOCHS, deletable: false },
)

console.log('Uploaded blob:', blobId)
```

### Browser (Vite app)

```typescript
// vite.config.ts or similar
import walrusWasmUrl from '@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url'

// In a composable or component
import { createWalrusClient, createUploadFlow } from '@meddleware/walrus-client'

const client = createWalrusClient({ network: 'testnet', wasmUrl: walrusWasmUrl })

// Step 1: Create the flow (can happen immediately when file is selected)
const flow = createUploadFlow(client, fileBytes, 'my-asset.png')

// Step 2: Register (user clicks a button, signs with wallet)
const registerTx = flow.register({ epochs: 200, owner: address })
const result = await signAndExecuteTransaction({ transaction: registerTx })

// Step 3: Upload to storage nodes
await flow.upload({ digest: result.digest })

// Step 4: Certify on-chain (user clicks another button, signs with wallet)
const certifyTx = flow.certify()
await signAndExecuteTransaction({ transaction: certifyTx })

const files = await flow.listFiles()
console.log('Uploaded blob ID:', files[0].blobId)
```

## API Reference

### Client Factory

**`createWalrusClient(options?): WalrusClient`**

Creates and configures a Walrus client. Called once per session.

```typescript
const client = createWalrusClient({
  network: 'testnet',             // 'testnet' | 'mainnet' (default: 'testnet')
  rpcUrl: '...',                  // Optional: override the Sui fullnode URL
  wasmUrl: '...',                 // Required for browser/Vite; ignored in Node.js
  uploadRelayHost: '...',         // Optional upload relay URL
  uploadRelayAuthToken: '...',    // Optional Bearer token for NFT-gated relay access
  uploadRelayMaxTipMist: 1000000, // Optional tip max in MIST (default: 1_000_000)
  disableUploadRelay: false,      // Bypass the relay entirely (direct to storage nodes)
})
```

### Upload (Node.js & Browser)

**`uploadBytes(client, contents, identifier, signer, options?): Promise<UploadResult>`**

Core upload function (stores a quilt). Works in Node.js and browser.

**`uploadLocalFile(client, filePath, identifier, signer, options?): Promise<UploadResult>`**

Node.js only. Reads a file from disk and uploads it.

**`createUploadFlow(client, contents, identifier, options?): WriteFilesFlow`**

Browser only. Returns a multi-step flow for wallet-popup-safe signing.

**`uploadImageBytes(client, contents, signer, options?): Promise<UploadResult>`** /
**`createBlobUploadFlow(client, contents): WriteBlobFlow`**

Raw-blob variants (Node.js / browser). Use these for assets that must be served directly by their blob URL (e.g. an image rendered by wallets/explorers): `GET /v1/blobs/<blobId>` returns the exact bytes. `uploadBytes`/`createUploadFlow` store a quilt instead, whose blob id does not resolve to the raw file.

**Options:**

```typescript
{
  epochs?: number               // Number of epochs to store (default: MAX_SINGLE_RESERVATION_EPOCHS)
  deletable?: boolean           // Deletable by owner (default: false)
  tags?: Record<string, string> // Optional metadata tags
}
```

**Constants:**

```typescript
export const MAX_SINGLE_RESERVATION_EPOCHS = 53 // Walrus `max_epochs_ahead`
export const LONG_TERM_EPOCHS = 200             // ~7.7 years target (needs renewal)
```

### Lifetime Extension

**`extendBlobLifetime(client, blobObjectId, signer, options): Promise<{ digest: string }>`**

Extend a blob's storage lifetime before expiry.

**`extendBlobLifetimeTransaction(client, blobObjectId, options): Transaction`**

Browser variant. Returns a transaction for wallet signing.

**Options:**

```typescript
{ epochs: number }      // Add N more epochs
// OR
{ endEpoch: number }    // Extend to a specific Sui epoch number
```

### Metadata (Attributes)

**`setBlobAttributes(client, blobObjectId, signer, attributes): Promise<{ digest: string }>`**

Set or update on-chain key-value metadata.

**`setBlobAttributesTransaction(client, blobObjectId, attributes): Transaction`**

Browser variant. Returns a transaction for wallet signing.

**`readBlobAttributes(client, blobObjectId): Promise<Record<string, string> | null>`**

Read current attributes.

### Query

**`fetchOwnedWalrusBlobs(suiClient, walrusClient, owner): Promise<OwnedBlob[]>`**

Enumerate all Walrus blobs owned by an address (resolves the Blob struct type dynamically, so no package addresses are hardcoded). Returns `{ objectId, blobId, size, endEpoch, certified }` entries.

### NFT-gated relay access

When the upload relay is protected by an `nft-gate` auth gateway, the caller must present a wallet-signed access proof. Use `createRelayAccessToken` to produce the Bearer token:

```typescript
import { createRelayAccessToken, createWalrusClient } from '@meddleware/walrus-client'

const token = await createRelayAccessToken({
  relayHost: 'https://sui-walrus-relay-testnet.meddleware.co.uk',
  address: walletAddress,
  sign: (msg) => wallet.signPersonalMessage({ message: msg }),
})

const client = createWalrusClient({
  network: 'testnet',
  uploadRelayAuthToken: token,
})
```

### Re-exports

- `WalrusFile` — Construct files from `Uint8Array`, `Blob`, or `string`
- `RetryableWalrusClientError` — For retry logic during epoch transitions

### Exported constants

| Export | Description |
|---|---|
| `DEFAULT_RPC_URLS` | Default Sui fullnode URLs per network |
| `PUBLIC_UPLOAD_RELAY_HOSTS` | Public Mysten-operated upload relay hosts (default when no `uploadRelayHost` is passed) |
| `WALRUS_AGGREGATOR_HOSTS` | Public Walrus aggregator hosts |
| `TESTNET_WALRUS_PACKAGE_CONFIG` | Walrus package config for testnet |
| `MAINNET_WALRUS_PACKAGE_CONFIG` | Walrus package config for mainnet |

## Prerequisites

### Sui Keypair (Node.js)

A `Signer` from `@mysten/sui/cryptography` with sufficient SUI to cover:

- Registration transaction gas
- Certification transaction gas
- WAL token balance to pay for blob storage duration (in MIST)

### Browser Wallet

A connected Sui wallet (`@mysten/dapp-kit-core`, Sui Wallet, Movemen) to sign transactions.

### Network

- **Testnet:** Walrus testnet storage nodes; standard Sui testnet RPC
- **Mainnet:** Walrus mainnet storage nodes; standard Sui mainnet RPC

Network endpoints are defined in `src/client.ts` and exported as `DEFAULT_RPC_URLS`.

### Upload relay

`createWalrusClient` falls back to the MeddleWare upload relay when no `uploadRelayHost` is supplied. An upload relay is REQUIRED for browser uploads (direct-to-storage-node writes fail from browsers). To upload directly to Walrus storage nodes with **no** relay (e.g. from Node.js, or when the relay infra is unavailable), pass `disableUploadRelay: true`:

```ts
const client = createWalrusClient({ network: 'testnet', disableUploadRelay: true })
```

`disableUploadRelay` overrides both an explicit `uploadRelayHost` and the default fallback. To point at a public Mysten relay instead, use `PUBLIC_UPLOAD_RELAY_HOSTS[network]` as the `uploadRelayHost`.

## Testing

```bash
npm run type-check   # tsc --noEmit (types only)
npm test             # vitest run (mocked-client unit tests)
```

The unit suite (`tests/`) uses a mocked `WalrusClient` to assert the behaviour type-checking cannot: safe-default threading (`deletable:false`, default epochs), options passthrough, the `ExtendOptions` XOR, the wallet-safe `*Transaction`/flow variants, the `disableUploadRelay` path, and owned-blob parsing. `vitest` is a **dev-only** dependency; its transitive `esbuild` advisories affect only the local test dev-server and do not reach the shipped source package (runtime deps `@mysten/sui` / `@mysten/walrus` are tilde-pinned — run `npm ci`, not `npm install`, in CI/deploy).

**Opt-in testnet integration check** (not automated — requires a funded testnet `Signer` + WAL): upload a small blob via `uploadBytes`, read it back via `readBlobAttributes`, then `extendBlobLifetime`, and confirm the digest/attributes. Run manually before relying on the package in a deploy pipeline.

## Maintenance

### Before blobs expire

Blobs expire after their epoch count. A maintenance script should periodically extend critical blobs:

```typescript
const client = createWalrusClient({ network: 'mainnet' })
const keypair = loadKeypair() // Your operational keypair

for (const blobId of criticalBlobs) {
  const { digest } = await extendBlobLifetime(
    client,
    blobId,
    keypair,
    { epochs: 50 }, // Extend by another 50 epochs (<= MAX_SINGLE_RESERVATION_EPOCHS)
  )
  console.log('Extended blob', blobId, 'in tx', digest)
}
```

Run this task on a schedule (e.g., weekly) to prevent expiry.

## Errors

**`RetryableWalrusClientError`** is thrown during Sui epoch transitions when the client's cached state becomes stale.

```typescript
try {
  await uploadBytes(...)
} catch (error) {
  if (error instanceof RetryableWalrusClientError) {
    client.walrus.reset()
    // Retry the operation
  }
}
```

## Further reading

- [Walrus SDK documentation](https://docs.walrus.space/)
- [Sui TypeScript SDK](https://sui-typescript-docs.vercel.app/)
- Package notes: [CLAUDE.md](CLAUDE.md) · agent policy: [AGENTS.md](AGENTS.md)
- Self-hosted relay: canonical location `infrastructure/k8s/walrus-relay` in the vault monorepo

## License

[0BSD](LICENSE)
