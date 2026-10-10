import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the options passed to the walrus() extension so we can assert the
// upload-relay wiring without a real network client.
const walrusArgs: any[] = []
vi.mock('@mysten/walrus', () => ({
  walrus: (opts: any) => {
    walrusArgs.push(opts)
    return { __walrusExtension: true }
  },
  TESTNET_WALRUS_PACKAGE_CONFIG: { __testnet: true },
  MAINNET_WALRUS_PACKAGE_CONFIG: { __mainnet: true },
}))

// SuiGrpcClient stub whose $extend just returns a marker (createWalrusClient uses gRPC).
vi.mock('@mysten/sui/grpc', () => ({
  SuiGrpcClient: class {
    constructor(public cfg: any) {}
    $extend(ext: unknown) {
      return { __client: true, ext, cfg: this.cfg }
    }
  },
}))

import { createWalrusClient, relayAuthFetch } from '../src/client.js'

beforeEach(() => {
  walrusArgs.length = 0
})

describe('createWalrusClient upload-relay wiring', () => {
  it('defaults to the public Mysten relay fallback when no host given', () => {
    createWalrusClient({ network: 'testnet' })
    expect(walrusArgs[0].uploadRelay).toBeDefined()
    expect(walrusArgs[0].uploadRelay.host).toContain('walrus.space')
  })

  it('uses an explicit uploadRelayHost when provided', () => {
    createWalrusClient({ network: 'mainnet', uploadRelayHost: 'https://relay.example.com' })
    expect(walrusArgs[0].uploadRelay.host).toBe('https://relay.example.com')
  })

  it('disableUploadRelay builds a relay-less client (walrus-audit F2)', () => {
    createWalrusClient({ network: 'testnet', disableUploadRelay: true })
    expect(walrusArgs[0].uploadRelay).toBeUndefined()
  })

  it('disableUploadRelay overrides an explicit host', () => {
    createWalrusClient({
      network: 'testnet',
      uploadRelayHost: 'https://relay.example.com',
      disableUploadRelay: true,
    })
    expect(walrusArgs[0].uploadRelay).toBeUndefined()
  })

  it('injects a Bearer auth header via the relay fetch hook when a token is supplied', async () => {
    // The @mysten/walrus UploadRelayClient has no `headers` option (only host/fetch/timeout/
    // onError), so the token must be threaded through a custom `fetch`. Assert the wrapper
    // exists and actually sets the Authorization header on the outgoing request.
    createWalrusClient({
      network: 'testnet',
      uploadRelayHost: 'https://relay.example.com',
      uploadRelayAuthToken: 'secret-token',
    })
    expect(walrusArgs[0].uploadRelay.headers).toBeUndefined()
    const relayFetch = walrusArgs[0].uploadRelay.fetch
    expect(relayFetch).toBeTypeOf('function')

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    try {
      await relayFetch('https://relay.example.com/v1/blob-upload-relay', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      })
      const [, init] = spy.mock.calls[0]!
      const sent = new Headers((init as RequestInit).headers)
      expect(sent.get('authorization')).toBe('Bearer secret-token')
      // Pre-existing headers are preserved.
      expect(sent.get('content-type')).toBe('application/octet-stream')
    } finally {
      spy.mockRestore()
    }
  })

  it('resolves a token PROVIDER per request (fresh token on resume)', async () => {
    // A provider function is called on each relay request, so a retained flow resumed after an
    // interrupted upload presents the current token rather than a stale baked-in one.
    let current: string | undefined = 'token-1'
    createWalrusClient({
      network: 'testnet',
      uploadRelayHost: 'https://relay.example.com',
      uploadRelayAuthToken: () => current,
    })
    const relayFetch = walrusArgs[0].uploadRelay.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      await relayFetch('https://relay.example.com/v1/blob-upload-relay', { method: 'POST' })
      expect(new Headers((spy.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toBe(
        'Bearer token-1',
      )
      current = 'token-2' // e.g. a fresh challenge signed on retry
      await relayFetch('https://relay.example.com/v1/blob-upload-relay', { method: 'POST' })
      expect(new Headers((spy.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe(
        'Bearer token-2',
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('adds no relay fetch hook when no token is supplied', () => {
    createWalrusClient({ network: 'testnet' })
    expect(walrusArgs[0].uploadRelay.fetch).toBeUndefined()
  })

  it('F4: relay fetch hook throws when auth token would be sent over http (non-https URL)', () => {
    // createWalrusClient now refuses such a host outright; the hook keeps its own check as the last line.
    const relayFetch = relayAuthFetch('http://relay.example.com', 'secret')
    expect(() => relayFetch('http://relay.example.com/v1/blob-upload-relay', { method: 'POST' })).toThrow('non-https')
  })

  it('F14: a non-loopback http relay is refused, with or without a token', () => {
    for (const uploadRelayAuthToken of [undefined, 'secret']) {
      expect(() =>
        createWalrusClient({ network: 'testnet', uploadRelayHost: 'http://relay.example.com', uploadRelayAuthToken }),
      ).toThrow(/uploadRelayHost must be https/)
    }
    expect(() => createWalrusClient({ network: 'testnet', uploadRelayHost: 'ftp://relay.example.com' })).toThrow(
      /must be https/,
    )
    expect(() => createWalrusClient({ network: 'testnet', uploadRelayHost: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('F14: http is accepted for a loopback relay only', () => {
    for (const host of ['http://127.0.0.1:57391', 'http://localhost:57391', 'http://[::1]:57391', 'https://relay.example.com']) {
      expect(() => createWalrusClient({ network: 'testnet', uploadRelayHost: host })).not.toThrow()
    }
  })

  it('F14: the relay call keeps a Request\'s own headers and never follows a redirect', async () => {
    const relayFetch = relayAuthFetch('https://relay.example.com', 'secret')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      const request = new Request('https://relay.example.com/v1/blob-upload-relay', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-trace': 'a' },
      })
      await relayFetch(request)
      let init = spy.mock.calls[0]![1] as RequestInit
      let headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer secret')
      expect(headers.get('content-type')).toBe('application/octet-stream')
      expect(headers.get('x-trace')).toBe('a')
      expect(init.redirect).toBe('error')

      // init.headers adds to and overrides the Request's, as fetch would; the token wins over both
      await relayFetch(request, { headers: { 'x-trace': 'b', authorization: 'Bearer other' } })
      init = spy.mock.calls[1]![1] as RequestInit
      headers = new Headers(init.headers)
      expect(headers.get('x-trace')).toBe('b')
      expect(headers.get('authorization')).toBe('Bearer secret')
      expect(headers.get('content-type')).toBe('application/octet-stream')
    } finally {
      spy.mockRestore()
    }
  })

  it('never attaches the token to a request for another origin', async () => {
    createWalrusClient({
      network: 'testnet',
      uploadRelayHost: 'https://relay.example.com',
      uploadRelayAuthToken: 'secret',
    })
    const relayFetch = walrusArgs[0].uploadRelay.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      await relayFetch('https://aggregator.example.com/v1/blobs/x')
      expect(new Headers((spy.mock.calls[0]![1] as RequestInit | undefined)?.headers).get('authorization')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('defaults the tip ceiling to 0.05 SUI', () => {
    createWalrusClient({ network: 'testnet' })
    expect(walrusArgs[0].uploadRelay.sendTip.max).toBe(50_000_000)
  })

  it('F6: auth token is scoped to the relay fetch hook only — globalThis.fetch is not patched', () => {
    const originalFetch = globalThis.fetch
    createWalrusClient({ network: 'testnet', uploadRelayAuthToken: 'secret' })
    // The injected fetch is confined to uploadRelay.fetch; global fetch is untouched.
    expect(globalThis.fetch).toBe(originalFetch)
  })
})

describe('relay tip cap validation', () => {
  it('rejects NaN, zero, negatives, fractions and unsafe integers', () => {
    for (const cap of [Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      expect(() => createWalrusClient({ network: 'testnet', uploadRelayMaxTipMist: cap })).toThrow(/uploadRelayMaxTipMist/)
    }
    expect(() => createWalrusClient({ network: 'testnet', uploadRelayMaxTipMist: 1 })).not.toThrow()
  })
})

describe('createWalrusClient localnet targeting', () => {
  const pkgConfig = { systemObjectId: '0xsys', stakingPoolId: '0xstake', exchangeIds: [] }

  it("throws when network is 'localnet' without an explicit rpcUrl", () => {
    expect(() => createWalrusClient({ network: 'localnet', walrusPackageConfig: pkgConfig })).toThrow(
      /localnet.*rpcUrl/,
    )
  })

  it('passes a caller-supplied packageConfig + http scheme to the walrus extension', () => {
    createWalrusClient({
      network: 'localnet',
      rpcUrl: 'http://127.0.0.1:9000',
      walrusPackageConfig: pkgConfig,
      storageNodeUrlScheme: 'http',
      uploadRelayHost: 'http://127.0.0.1:57391',
    })
    expect(walrusArgs[0].packageConfig).toBe(pkgConfig)
    expect(walrusArgs[0].storageNodeUrlScheme).toBe('http')
    // no bundled localnet relay default — the explicit host is used
    expect(walrusArgs[0].uploadRelay.host).toBe('http://127.0.0.1:57391')
  })

  it("F14: storageNodeUrlScheme 'http' is refused off localnet", () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      expect(() => createWalrusClient({ network, storageNodeUrlScheme: 'http' })).toThrow(/only for the 'localnet' network/)
      expect(() => createWalrusClient({ network, storageNodeUrlScheme: 'https' })).not.toThrow()
    }
  })

  it('localnet without an explicit relay host builds no upload relay (no public fallback)', () => {
    createWalrusClient({
      network: 'localnet',
      rpcUrl: 'http://127.0.0.1:9000',
      walrusPackageConfig: pkgConfig,
    })
    expect(walrusArgs[0].uploadRelay).toBeUndefined()
  })
})
