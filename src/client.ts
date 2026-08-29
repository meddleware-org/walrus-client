import { SuiGrpcClient } from '@mysten/sui/grpc'
import { walrus, TESTNET_WALRUS_PACKAGE_CONFIG, MAINNET_WALRUS_PACKAGE_CONFIG } from '@mysten/walrus'

export { TESTNET_WALRUS_PACKAGE_CONFIG, MAINNET_WALRUS_PACKAGE_CONFIG }

/** Supported Walrus network environments. */
export type WalrusNetwork = 'testnet' | 'mainnet'

/** Default Sui full-node RPC URLs, keyed by network. */
export const DEFAULT_RPC_URLS: Record<WalrusNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
}

/**
 * Public Mysten-operated upload relays. Used as the default when no `uploadRelayHost`
 * is specified. An upload relay is REQUIRED for browser uploads — direct-to-storage-node
 * writes fail from browsers and constrained networks. Operators who run their own relay
 * should pass `uploadRelayHost` to `createWalrusClient` instead.
 */
export const PUBLIC_UPLOAD_RELAY_HOSTS: Record<WalrusNetwork, string> = {
  testnet: 'https://upload-relay.testnet.walrus.space',
  mainnet: 'https://upload-relay.mainnet.walrus.space',
}

/** Public Walrus aggregators (serve raw blob bytes at `/v1/blobs/<blobId>`). */
export const WALRUS_AGGREGATOR_HOSTS: Record<WalrusNetwork, string> = {
  testnet: 'https://aggregator.walrus-testnet.walrus.space',
  mainnet: 'https://aggregator.walrus-mainnet.walrus.space',
}

/**
 * Public URL that serves a RAW blob's bytes (e.g. a token icon). Only meaningful
 * for blobs written with `uploadImageBytes` / `writeBlob` (raw), NOT quilts.
 */
export function walrusBlobUrl(
  network: WalrusNetwork,
  blobId: string,
  aggregatorHost?: string,
): string {
  const host = aggregatorHost ?? WALRUS_AGGREGATOR_HOSTS[network]
  return `${host}/v1/blobs/${blobId}`
}

/** Return the Walrus on-chain package config for the given network. */
export function getWalrusPackageConfig(network: WalrusNetwork) {
  return network === 'mainnet' ? MAINNET_WALRUS_PACKAGE_CONFIG : TESTNET_WALRUS_PACKAGE_CONFIG
}

/** Options accepted by {@link createWalrusClient}. */
export type CreateWalrusClientOptions = {
  /** Target network (default `'testnet'`). */
  network?: WalrusNetwork
  /** Override the Sui JSON-RPC/gRPC fullnode URL. Defaults to the public Mysten endpoint for the network. */
  rpcUrl?: string
  /** Optional WASM bundle URL for the Walrus WASM client. */
  wasmUrl?: string
  /**
   * Upload relay host URL. Defaults to the public Mysten relay for the network.
   * Operators running their own relay (e.g. Meddleware's NFT-gated relay) should
   * pass their relay URL here alongside `uploadRelayAuthToken`.
   */
  uploadRelayHost?: string
  /**
   * Bearer token for the upload relay `Authorization` header. Obtain via
   * `createRelayAccessToken` from the `access` module when the relay is NFT-gated.
   */
  uploadRelayAuthToken?: string
  /**
   * Maximum tip payment to the upload relay in MIST (default 1,000,000 = 0.001 SUI).
   * The relay may request less; this cap prevents the client from overpaying.
   */
  uploadRelayMaxTipMist?: number
  /**
   * When true, build a client with NO upload relay (direct-to-storage-node).
   * Overrides `uploadRelayHost` and the default relay fallback. Useful for
   * server-side Node.js scripts where relay infra is unnecessary.
   */
  disableUploadRelay?: boolean
}

/**
 * Create a Walrus client pre-configured for the given network and relay options.
 *
 * @example
 * ```ts
 * const client = createWalrusClient({ network: 'testnet' })
 * ```
 */
export function createWalrusClient({
  network = 'testnet',
  rpcUrl,
  wasmUrl,
  uploadRelayHost,
  uploadRelayAuthToken,
  uploadRelayMaxTipMist = 1_000_000,
  disableUploadRelay = false,
}: CreateWalrusClientOptions = {}) {
  const baseUrl = rpcUrl ?? DEFAULT_RPC_URLS[network]
  // disableUploadRelay wins over both an explicit host and the default fallback.
  const relayHost = disableUploadRelay ? undefined : (uploadRelayHost ?? PUBLIC_UPLOAD_RELAY_HOSTS[network])
  return new SuiGrpcClient({
    network,
    baseUrl,
  }).$extend(
    walrus({
      ...(wasmUrl ? { wasmUrl } : {}),
      ...(relayHost
        ? {
            uploadRelay: {
              host: relayHost,
              sendTip: { max: uploadRelayMaxTipMist },
              ...(uploadRelayAuthToken
                ? { headers: { Authorization: `Bearer ${uploadRelayAuthToken}` } }
                : {}),
            },
          }
        : {}),
    }),
  )
}
