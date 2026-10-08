import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeAccessProof } from '@meddleware/nft-gate-client'
import {
  personalMessage,
  buildAccessProofToken,
  fetchRelayChallenge,
  createRelayAccessToken,
} from '../src/access.js'

afterEach(() => vi.restoreAllMocks())

const GATE = '0x' + 'a1'.repeat(32)
const DIGEST = '5Wq9tE4gXz8hEvFhYt8KkTJb2Pp6qXqj8cRk3xN1mYdL'
const text = (b: Uint8Array) => new TextDecoder().decode(b)

function decode(token: string) {
  return JSON.parse(Buffer.from(token, 'base64').toString('utf-8'))
}

describe('relay access proof', () => {
  it('derives the audience-bound v2 message', () => {
    expect(
      text(personalMessage({ origin: 'https://relay.example', gateId: GATE, network: 'testnet', nonce: 'abc' })),
    ).toBe(`nft-gate:access:v2\norigin:https://relay.example\ngate:${GATE}\nnetwork:testnet\nnonce:abc`)
  })

  it('encodes a proof token without consumeDigest by default', () => {
    const token = buildAccessProofToken({ address: '0x1', nonce: 'n', signature: 'AAAA' })
    expect(decode(token)).toEqual({ address: '0x1', nonce: 'n', signature: 'AAAA' })
  })

  it('includes consumeDigest when supplied', () => {
    const token = buildAccessProofToken({ address: '0x1', nonce: 'n', signature: 'AAAA', consumeDigest: DIGEST })
    expect(decode(token).consumeDigest).toBe(DIGEST)
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

  it('createRelayAccessToken signs the message bound to the relay, gate and network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ nonce: 'the-nonce', expiresAt: 1 }), { status: 200 })),
    )
    const sign = vi.fn(async (message: Uint8Array) => {
      expect(text(message)).toBe(
        `nft-gate:access:v2\norigin:https://relay.example\ngate:${GATE}\nnetwork:testnet\nnonce:the-nonce\nconsume:${DIGEST}`,
      )
      return { signature: 'U0lHNjQ=' }
    })
    const token = await createRelayAccessToken({
      relayHost: 'https://relay.example/',
      address: '0xabc',
      gateId: GATE,
      network: 'testnet',
      sign,
      consumeDigest: DIGEST,
    })
    expect(sign).toHaveBeenCalledOnce()
    expect(decodeAccessProof(token)).toEqual({
      address: '0xabc',
      nonce: 'the-nonce',
      signature: 'U0lHNjQ=',
      consumeDigest: DIGEST,
    })
  })

  it('refuses a non-canonical gate before asking the wallet to sign', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nonce: 'n', expiresAt: 1 }), { status: 200 })))
    const sign = vi.fn(async () => ({ signature: 'QQ==' }))
    await expect(
      createRelayAccessToken({ relayHost: 'https://relay.example', address: '0x1', gateId: '0x1', network: 'testnet', sign }),
    ).rejects.toThrow()
    expect(sign).not.toHaveBeenCalled()
  })
})
