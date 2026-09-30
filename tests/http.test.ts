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
    expect(id).toBe('B1')
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
    expect(await storeBlobViaPublisher(new Uint8Array([1]), opts)).toBe('B2')
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
    await expect(storeBlobViaPublisher(new Uint8Array([1]), opts(async () => Response.json({})))).rejects.toThrow(/no blob id/)
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
