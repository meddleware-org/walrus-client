// `@meddleware/walrus-client/http` — store and read blobs through a Walrus HTTP publisher and
// aggregator. No wallet, no wasm, no `@mysten/walrus`: for opaque bytes (e.g. Seal ciphertext) where
// the publisher pays for storage and sends the `Blob` object to the user.

/** Parse an endpoint and require https (http only for localhost, in development). */
export function requireHttpsEndpoint(raw: string, what: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what} URL is not valid: ${raw}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${what} must use https: ${url.origin}`)
  }
  return url
}

export interface StoreViaPublisherOptions {
  /** Publisher base URL (https). */
  publisher: string
  /** Storage epochs. */
  epochs: number
  /** Sui address that receives the created `Blob` object, so the user — not the publisher — owns it. */
  sendObjectTo: string
  /** Refuse larger payloads before sending (the publisher's own limit still applies). */
  maxBytes?: number
  /** Default 120 000 ms. */
  timeoutMs?: number
  fetch?: typeof fetch
}

interface PublishResponse {
  newlyCreated?: { blobObject?: { blobId?: string } }
  alreadyCertified?: { blobId?: string }
}

/**
 * Store `bytes` as a **permanent** blob through a publisher and return its blob id. Permanent
 * because pointers and manifests rely on the blob staying readable until it expires.
 *
 * @throws {Error} for a non-https publisher, an oversized payload, a publisher error or timeout, or
 *   a response without a blob id.
 */
export async function storeBlobViaPublisher(bytes: Uint8Array, opts: StoreViaPublisherOptions): Promise<string> {
  if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
    throw new Error(`The payload is ${bytes.length} bytes; the publisher accepts at most ${opts.maxBytes}.`)
  }
  const url = new URL('/v1/blobs', requireHttpsEndpoint(opts.publisher, 'Walrus publisher'))
  url.searchParams.set('epochs', String(opts.epochs))
  url.searchParams.set('permanent', 'true')
  url.searchParams.set('send_object_to', opts.sendObjectTo)
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'PUT',
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  })
  if (!res.ok) throw new Error(`Walrus publisher error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = (await res.json()) as PublishResponse
  const blobId = json.newlyCreated?.blobObject?.blobId ?? json.alreadyCertified?.blobId
  if (!blobId) throw new Error('Walrus publisher returned no blob id.')
  return blobId
}

export interface ReadBlobOptions {
  /** Aggregator base URL (https). */
  aggregator: string
  /** Default 60 000 ms. */
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * Read a blob's bytes from an aggregator, with `strict_consistency_check` so the aggregator verifies
 * the blob was encoded consistently before serving it.
 *
 * @throws {Error} for a non-https aggregator, an aggregator error or a timeout.
 */
export async function readBlob(blobId: string, opts: ReadBlobOptions): Promise<Uint8Array> {
  const url = new URL(`/v1/blobs/${encodeURIComponent(blobId)}`, requireHttpsEndpoint(opts.aggregator, 'Walrus aggregator'))
  url.searchParams.set('strict_consistency_check', 'true')
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
  if (!res.ok) throw new Error(`Walrus aggregator error ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
