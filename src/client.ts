import { SuiGrpcClient } from '@mysten/sui/grpc'
import { walrus, TESTNET_WALRUS_PACKAGE_CONFIG, MAINNET_WALRUS_PACKAGE_CONFIG } from '@mysten/walrus'

export { TESTNET_WALRUS_PACKAGE_CONFIG, MAINNET_WALRUS_PACKAGE_CONFIG }

export type WalrusNetwork = 'testnet' | 'mainnet'

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

export function getWalrusPackageConfig(network: WalrusNetwork) {
  return network === 'mainnet' ? MAINNET_WALRUS_PACKAGE_CONFIG : TESTNET_WALRUS_PACKAGE_CONFIG
}

export type CreateWalrusClientOptions = {
  network?: WalrusNetwork
  /** Override the Sui JSON-RPC/gRPC fullnode URL. Defaults to the public Mysten endpoint for the network. */
  rpcUrl?: string
  wasmUrl?: string
  uploadRelayHost?: string
  uploadRelayAuthToken?: string
  uploadRelayMaxTipMist?: number
  /**
   * When true, build a client with NO upload relay (direct-to-storage-node).
   * Overrides `uploadRelayHost` and the default MeddleWare relay fallback, so a
   * deployer is never hard-blocked on relay infra. Uploads then talk directly to
   * Walrus storage nodes.
   */
  disableUploadRelay?: boolean
}

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
