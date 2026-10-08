// Hermetic proof that the REAL @mysten/walrus UploadRelayClient calls the `fetch` we hand it. The
// gated relay depends on it: the SDK has no `headers` option, so the Authorization header can only
// ride on this hook. If an SDK upgrade stops calling it, this test fails instead of production.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWalrusClient } from '../src/client.js'

afterEach(() => vi.unstubAllGlobals())

describe('the SDK honours the relay fetch hook', () => {
  it('sends Authorization: Bearer <current token> on the relay request, and only to the relay', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response('{}', { status: 404 }) // the SDK treats a missing tip config as "no tip"
    })
    const client = createWalrusClient({
      network: 'testnet',
      uploadRelayHost: 'https://relay.example',
      uploadRelayAuthToken: () => 'tok-1',
    })
    const send = client.walrus.sendUploadRelayTip({ size: 1, blobDigest: new Uint8Array(32), nonce: new Uint8Array(32) })
    await send({} as never).catch(() => {}) // the fake transaction fails after the tip config is read
    const relay = seen.filter((s) => s.url.startsWith('https://relay.example'))
    expect(relay.length).toBeGreaterThan(0)
    expect(relay[0]!.auth).toBe('Bearer tok-1')
    expect(seen.filter((s) => !s.url.startsWith('https://relay.example') && s.auth)).toEqual([])
  })
})
