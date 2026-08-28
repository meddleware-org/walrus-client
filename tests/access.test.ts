import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  personalMessageForNonce,
  buildAccessProofToken,
  fetchRelayChallenge,
  createRelayAccessToken,
} from '../src/access.js'

afterEach(() => vi.restoreAllMocks())

function decode(token: string) {
  return JSON.parse(Buffer.from(token, 'base64').toString('utf-8'))
}

describe('relay access proof', () => {
  it('derives the shared personal message', () => {
    expect(new TextDecoder().decode(personalMessageForNonce('abc'))).toBe('nft-gate:access:abc')
  })

  it('encodes a proof token without consumeDigest by default', () => {
    const token = buildAccessProofToken({ address: '0x1', nonce: 'n', signature: 'sig' })
    expect(decode(token)).toEqual({ address: '0x1', nonce: 'n', signature: 'sig' })
  })

  it('includes consumeDigest when supplied', () => {
    const token = buildAccessProofToken({ address: '0x1', nonce: 'n', signature: 'sig', consumeDigest: 'd' })
    expect(decode(token).consumeDigest).toBe('d')
  })

  it('fetchRelayChallenge parses and strips trailing slash', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ nonce: 'x', expiresAt: 9 }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    expect(await fetchRelayChallenge('https://relay.example/')).toEqual({ nonce: 'x', expiresAt: 9 })
    expect(spy).toHaveBeenCalledWith('https://relay.example/v1/challenge', expect.anything())
  })

  it('fetchRelayChallenge throws on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    await expect(fetchRelayChallenge('https://relay.example')).rejects.toThrow(/500/)
  })

  it('createRelayAccessToken fetches, signs the nonce, and encodes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ nonce: 'the-nonce', expiresAt: 1 }), { status: 200 })),
    )
    const sign = vi.fn(async (message: Uint8Array) => {
      expect(new TextDecoder().decode(message)).toBe('nft-gate:access:the-nonce')
      return { signature: 'SIG64' }
    })
    const token = await createRelayAccessToken({
      relayHost: 'https://relay.example',
      address: '0xabc',
      sign,
      consumeDigest: 'digest',
    })
    expect(sign).toHaveBeenCalledOnce()
    expect(decode(token)).toEqual({
      address: '0xabc',
      nonce: 'the-nonce',
      signature: 'SIG64',
      consumeDigest: 'digest',
    })
  })
})
