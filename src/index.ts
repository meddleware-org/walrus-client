// Public API barrel for @meddleware/walrus-client. Ships TypeScript source directly (no build
// step). Grouped by concern: client factory + network config (client.ts), upload flows
// (upload.ts), blob lifetime/attribute management (manage.ts), owned-blob queries (query.ts), and
// nft-gate relay access proofs (access.ts). Re-exports WalrusFile/RetryableWalrusClientError from
// @mysten/walrus for convenience.
export {
  createWalrusClient,
  getWalrusPackageConfig,
  walrusBlobUrl,
  DEFAULT_RPC_URLS,
  PUBLIC_UPLOAD_RELAY_HOSTS,
  WALRUS_AGGREGATOR_HOSTS,
  TESTNET_WALRUS_PACKAGE_CONFIG,
  MAINNET_WALRUS_PACKAGE_CONFIG,
} from './client.js'
export type { CreateWalrusClientOptions, WalrusClientNetwork, WalrusNetwork } from './client.js'

export {
  MAX_SINGLE_RESERVATION_EPOCHS,
  LONG_TERM_EPOCHS,
  uploadBytes,
  createUploadFlow,
  uploadImageBytes,
  createBlobUploadFlow,
} from './upload.js'
export type { WalrusClient, UploadOptions, UploadResult } from './upload.js'

export {
  extendBlobLifetime,
  extendBlobLifetimeTransaction,
  certifyBlobTransaction,
  estimateStorageCost,
  setBlobAttributes,
  setBlobAttributesTransaction,
  readBlobAttributes,
} from './manage.js'
export type { ExtendOptions, CertifyOptions, StorageCost } from './manage.js'

export { fetchOwnedWalrusBlobs } from './query.js'
export type { OwnedBlob } from './query.js'

export {
  personalMessageForNonce,
  buildAccessProofToken,
  fetchRelayChallenge,
  createRelayAccessToken,
} from './access.js'
export type { RelayChallenge, AccessProofInput, PersonalMessageSigner } from './access.js'

export { WalrusFile, RetryableWalrusClientError } from '@mysten/walrus'
