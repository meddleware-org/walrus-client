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

// SuiGrpcClient stub whose $extend just returns a marker.
vi.mock('@mysten/sui/grpc', () => ({
  SuiGrpcClient: class {
    constructor(public cfg: any) {}
    $extend(ext: unknown) {
      return { __client: true, ext, cfg: this.cfg }
    }
  },
}))

import { createWalrusClient } from '../src/client.js'

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

  it('attaches a Bearer auth header only when a token is supplied', () => {
    createWalrusClient({ network: 'testnet', uploadRelayAuthToken: 'secret-token' })
    expect(walrusArgs[0].uploadRelay.headers).toEqual({ Authorization: 'Bearer secret-token' })
  })
})
