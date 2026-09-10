// Shared setup for the localnet integration suites. Reads the `.env.localnet` contract produced by
// localnet/scripts/bootstrap-localnet.sh (export it first: `set -a && source .env.localnet`).
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { NotEnoughBlobConfirmationsError } from '@mysten/walrus'
import { createWalrusClient, type WalrusPackageConfig } from '../../src/client.js'
import { uploadImageBytes } from '../../src/upload.js'

/** True when the localnet env contract is present — used to skip suites when it is not. */
export const LOCALNET_READY =
  process.env.WALRUS_LOCALNET === '1' &&
  !!process.env.WALRUS_RPC_URL &&
  !!process.env.WALRUS_SYSTEM_OBJECT_ID &&
  !!process.env.WALRUS_STAKING_POOL_ID &&
  !!process.env.WALRUS_TEST_SECRET_KEY

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`localnet integration: missing env ${name} (did you source .env.localnet?)`)
  return v
}

/** The harvested Walrus package config for the running testbed. */
export function localnetPackageConfig(): WalrusPackageConfig {
  const exchangeIds = (process.env.WALRUS_EXCHANGE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    systemObjectId: required('WALRUS_SYSTEM_OBJECT_ID'),
    stakingPoolId: required('WALRUS_STAKING_POOL_ID'),
    ...(exchangeIds.length ? { exchangeIds } : {}),
  }
}

/** A Walrus client wired to the localnet testbed. Uploads go through the localnet relay
 * (WALRUS_RELAY_HOST, default http://127.0.0.1:57391) rather than directly to storage nodes.
 * Storage nodes only advertise their internal Docker-network addresses (10.0.0.10-13) in the
 * on-chain committee — the host cannot reach them directly. The relay runs on the testbed network
 * and CAN reach the nodes; it is configured with tip_config: !no_tip so no WAL auth is needed. */
export function localnetWalrusClient() {
  return createWalrusClient({
    network: 'localnet',
    rpcUrl: required('WALRUS_RPC_URL'),
    walrusPackageConfig: localnetPackageConfig(),
    uploadRelayHost: required('WALRUS_RELAY_HOST'),
  })
}

/** A Sui gRPC client for owned-object queries against localnet (`ClientWithCoreApi`). */
export function localnetSuiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: 'localnet', baseUrl: required('WALRUS_RPC_URL') })
}

/** The funded localnet test keypair (Node signer). */
export function localnetSigner(): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(required('WALRUS_TEST_SECRET_KEY'))
}

export const localnetAddress = (): string => required('WALRUS_TEST_ADDRESS')

/**
 * Wraps uploadImageBytes with a single retry for the localnet.
 * Storage nodes ingest Sui blob-registration events via a polling loop; if that loop hasn't run by
 * the time the SDK writes slivers, nodes return NOT_REGISTERED and the upload fails. Waiting ~10s
 * (one poll cycle) then retrying resolves it: the second call re-registers the same bytes (same
 * content-addressed blobId, new BlobObject), and nodes now recognise the blobId.
 */
export async function uploadImageBytesWithRetry(
  ...args: Parameters<typeof uploadImageBytes>
): ReturnType<typeof uploadImageBytes> {
  try {
    return await uploadImageBytes(...args)
  } catch (e) {
    if (!(e instanceof NotEnoughBlobConfirmationsError)) throw e
    await new Promise((r) => setTimeout(r, 10_000))
    return uploadImageBytes(...args)
  }
}

/** GET a blob's raw bytes from the localnet aggregator. */
export async function aggregatorRead(blobId: string): Promise<Uint8Array> {
  const host = required('WALRUS_AGGREGATOR_HOST')
  const res = await fetch(`${host}/v1/blobs/${blobId}`)
  if (!res.ok) throw new Error(`aggregator read ${blobId} → HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
