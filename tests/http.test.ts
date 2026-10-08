import { describe, it, expect, vi } from 'vitest'
import { readBlob, requireHttpsEndpoint, storeBlobViaPublisher } from '../src/http.js'

const OWNER = '0x' + 'ab'.repeat(32)
const PUBLISHER = 'https://publisher.example.com'

describe('storeBlobViaPublisher', () => {
  it('stores permanent, sends the Blob object to the owner, and returns the blob id', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ newlyCreated: { blobObject: { blobId: 'B1' } } }))
    const id = await storeBlobViaPublisher(new Uint8Array([1, 2]), {
      publisher: PUBLISHER,
      epochs: 5,
      sendObjectTo: OWNER,
      fetch: fetchSpy as unknown as typeof fetch,
    })
    expect(id).toEqual({ blobId: 'B1', kind: 'newlyCreated' })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe(`${PUBLISHER}/v1/blobs`)
    expect(url.searchParams.get('epochs')).toBe('5')
    expect(url.searchParams.get('permanent')).toBe('true')
    expect(url.searchParams.get('send_object_to')).toBe(OWNER)
    expect(init.method).toBe('PUT')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts an already-certified response', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ alreadyCertified: { blobId: 'B2' } }))
    const opts = { publisher: PUBLISHER, epochs: 1, sendObjectTo: OWNER, fetch: fetchSpy as unknown as typeof fetch }
    expect(await storeBlobViaPublisher(new Uint8Array([1]), opts)).toEqual({ blobId: 'B2', kind: 'alreadyCertified' })
  })

  it('reports the details a caller needs: object id and end epoch, and that an already-certified blob created no object', async () => {
    const created = vi.fn(async () =>
      Response.json({ newlyCreated: { blobObject: { blobId: 'B1', id: '0xabc' }, resource: { endEpoch: 80 } } }),
    )
    const certified = vi.fn(async () => Response.json({ alreadyCertified: { blobId: 'B2', endEpoch: 61 } }))
    const base = { publisher: PUBLISHER, epochs: 53, sendObjectTo: OWNER }
    expect(await storeBlobViaPublisher(new Uint8Array([1]), { ...base, fetch: created as unknown as typeof fetch })).toEqual({
      blobId: 'B1',
      kind: 'newlyCreated',
      blobObjectId: '0xabc',
      endEpoch: 80,
    })
    expect(await storeBlobViaPublisher(new Uint8Array([1]), { ...base, fetch: certified as unknown as typeof fetch })).toEqual({
      blobId: 'B2',
      kind: 'alreadyCertified',
      endEpoch: 61,
    })
  })

  it('refuses redirects and bounds the response', async () => {
    const spy = vi.fn(async () => Response.json({ newlyCreated: { blobObject: { blobId: 'B1' } } }))
    const base = { publisher: PUBLISHER, epochs: 1, sendObjectTo: OWNER }
    await storeBlobViaPublisher(new Uint8Array([1]), { ...base, fetch: spy as unknown as typeof fetch })
    expect((spy.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('error')
    const huge = vi.fn(async () => new Response('x'.repeat(100_000), { status: 500 }))
    await expect(storeBlobViaPublisher(new Uint8Array([1]), { ...base, fetch: huge as unknown as typeof fetch })).rejects.toThrow(/larger than/)
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(storeBlobViaPublisher(new Uint8Array([1]), { ...base, fetch: notJson as unknown as typeof fetch })).rejects.toThrow(/not JSON/)
  })

  it('refuses a payload over maxBytes before any request', async () => {
    const fetchSpy = vi.fn()
    await expect(
      storeBlobViaPublisher(new Uint8Array(17), {
        publisher: PUBLISHER,
        epochs: 1,
        sendObjectTo: OWNER,
        maxBytes: 16,
        fetch: fetchSpy as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/at most 16/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces a publisher error and a missing blob id', async () => {
    const opts = (f: () => Promise<Response>) => ({
      publisher: PUBLISHER,
      epochs: 1,
      sendObjectTo: OWNER,
      fetch: vi.fn(f) as unknown as typeof fetch,
    })
    await expect(storeBlobViaPublisher(new Uint8Array([1]), opts(async () => new Response('nope', { status: 500 })))).rejects.toThrow(
      /publisher error 500: nope/,
    )
    await expect(storeBlobViaPublisher(new Uint8Array([1]), opts(async () => Response.json({})))).rejects.toThrow(/no valid blob id/)
  })

  it('refuses a plain-http publisher', async () => {
    await expect(
      storeBlobViaPublisher(new Uint8Array([1]), { publisher: 'http://publisher.example.com', epochs: 1, sendObjectTo: OWNER }),
    ).rejects.toThrow(/https/)
  })
})

describe('readBlob', () => {
  it('asks the aggregator for a strict consistency check', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([7])))
    const bytes = await readBlob('abc/def', { aggregator: 'https://aggregator.example.com', fetch: fetchSpy as unknown as typeof fetch })
    expect(bytes).toEqual(new Uint8Array([7]))
    const [url] = fetchSpy.mock.calls[0] as unknown as [URL]
    expect(url.pathname).toBe('/v1/blobs/abc%2Fdef')
    expect(url.searchParams.get('strict_consistency_check')).toBe('true')
  })

  it('refuses a blob over maxBytes, by declared length or by bytes read', async () => {
    const big = new Uint8Array(10)
    const declared = vi.fn(async () => new Response(big, { headers: { 'content-length': '10' } }))
    await expect(
      readBlob('x', { aggregator: 'https://a.example', maxBytes: 5, fetch: declared as unknown as typeof fetch }),
    ).rejects.toThrow(/10 bytes; at most 5/)
    // No (or a false) Content-Length: the stream is counted.
    const streamed = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(4))
          c.enqueue(new Uint8Array(4))
          c.close()
        },
      })
      return new Response(body)
    })
    await expect(
      readBlob('x', { aggregator: 'https://a.example', maxBytes: 5, fetch: streamed as unknown as typeof fetch }),
    ).rejects.toThrow(/exceeds 5 bytes/)
    const ok = await readBlob('x', { aggregator: 'https://a.example', maxBytes: 8, fetch: streamed as unknown as typeof fetch })
    expect(ok.length).toBe(8)
  })

  it('surfaces an aggregator error', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 404 }))
    await expect(readBlob('x', { aggregator: 'https://a.example', fetch: fetchSpy as unknown as typeof fetch })).rejects.toThrow(
      /aggregator error 404/,
    )
  })
})

describe('requireHttpsEndpoint', () => {
  it('allows https anywhere and http only on localhost', () => {
    expect(requireHttpsEndpoint('https://x.example', 'X').origin).toBe('https://x.example')
    expect(requireHttpsEndpoint('http://localhost:8080', 'X').port).toBe('8080')
    expect(() => requireHttpsEndpoint('http://x.example', 'X')).toThrow(/must use https/)
    expect(() => requireHttpsEndpoint('not a url', 'X')).toThrow(/not valid/)
  })
})
