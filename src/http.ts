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

/** Largest publisher response (success or error) that is read; a hostile endpoint cannot exhaust memory. */
export const MAX_PUBLISHER_RESPONSE_BYTES = 64 * 1024

/** What the publisher did with the payload. */
export interface PublishResult {
  blobId: string
  /**
   * `newlyCreated`: the publisher stored it and sent a `Blob` object to `sendObjectTo`, whose
   * lifetime that address controls. `alreadyCertified`: the content was already stored on Walrus;
   * the publisher created NO object for `sendObjectTo`, so the caller owns nothing it can extend, and
   * the blob lives only until `endEpoch` (which may be sooner than the requested epochs).
   */
  kind: 'newlyCreated' | 'alreadyCertified'
  /** Last storage epoch of the blob, when the publisher reports it. */
  endEpoch?: number
  /** The created `Blob` object, for `newlyCreated`. */
  blobObjectId?: string
}

/** Read at most `max` bytes of a response body as text; throws past the cap. */
async function readTextCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel()
    throw new Error(`The response is larger than ${max} bytes.`)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error(`The response is larger than ${max} bytes.`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const BLOB_ID = /^[A-Za-z0-9_-]{1,128}$/

function recordOf(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Store `bytes` as a **permanent** blob through a publisher and describe the result. Permanent
 * because pointers and manifests rely on the blob staying readable until it expires. Redirects are
 * refused and the response is size-capped.
 *
 * Check `kind`: for `alreadyCertified` the publisher sends nothing to `sendObjectTo` (see
 * {@link PublishResult}).
 *
 * @throws {Error} for a non-https publisher, an oversized payload, a redirect, a publisher error or
 *   timeout, or a response without a valid blob id.
 */
export async function storeBlobViaPublisher(bytes: Uint8Array, opts: StoreViaPublisherOptions): Promise<PublishResult> {
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
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  })
  const text = await readTextCapped(res, MAX_PUBLISHER_RESPONSE_BYTES)
  if (!res.ok) throw new Error(`Walrus publisher error ${res.status}: ${text.slice(0, 300)}`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Walrus publisher returned a response that is not JSON.')
  }
  const root = recordOf(json)
  const created = recordOf(root?.newlyCreated)
  const createdBlob = recordOf(created?.blobObject)
  const certified = recordOf(root?.alreadyCertified)
  const blobId = createdBlob?.blobId ?? certified?.blobId
  if (typeof blobId !== 'string' || !BLOB_ID.test(blobId)) {
    throw new Error('Walrus publisher returned no valid blob id.')
  }
  const endEpoch = created ? recordOf(created.resource)?.endEpoch : certified?.endEpoch
  return {
    blobId,
    kind: createdBlob ? 'newlyCreated' : 'alreadyCertified',
    ...(typeof endEpoch === 'number' && Number.isSafeInteger(endEpoch) ? { endEpoch } : {}),
    ...(typeof createdBlob?.id === 'string' ? { blobObjectId: createdBlob.id } : {}),
  }
}

/** Default cap on a blob read through {@link readBlob}: the operator relay's edge cap (100 MiB). */
export const DEFAULT_READ_MAX_BYTES = 100 * 1024 * 1024

export interface ReadBlobOptions {
  /** Aggregator base URL (https). */
  aggregator: string
  /** Default 60 000 ms. */
  timeoutMs?: number
  /** Largest blob accepted, checked on the declared length and on the bytes read (default 100 MiB). */
  maxBytes?: number
  fetch?: typeof fetch
}

/**
 * Read a blob's bytes from an aggregator, with `strict_consistency_check` so the aggregator verifies
 * the blob was encoded consistently before serving it. Redirects are refused.
 *
 * **Trust.** The aggregator is trusted for the bytes it returns: no blob id is re-derived locally, so
 * a hostile or compromised aggregator can serve arbitrary bytes for a blob id. Sealed (encrypted)
 * content is protected downstream by its authenticated encryption; for plaintext that matters, verify
 * the content by other means (a hash recorded elsewhere, or a read through the full Walrus SDK).
 *
 * @throws {Error} for a non-https aggregator, an aggregator error, a redirect, a timeout or a blob over `maxBytes`.
 */
export async function readBlob(blobId: string, opts: ReadBlobOptions): Promise<Uint8Array> {
  const url = new URL(`/v1/blobs/${encodeURIComponent(blobId)}`, requireHttpsEndpoint(opts.aggregator, 'Walrus aggregator'))
  url.searchParams.set('strict_consistency_check', 'true')
  const res = await (opts.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
  if (!res.ok) throw new Error(`Walrus aggregator error ${res.status}`)
  const max = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > max) throw new Error(`The blob is ${declared} bytes; at most ${max} are read.`)
  if (!res.body) return new Uint8Array(0)
  // Count while reading: a missing or false Content-Length must not let an unbounded body through.
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error(`The blob exceeds ${max} bytes.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}
