// Unit tests for the headless upload orchestrator and its resume conventions. A fake root module is
// injected via `loadWalrusClient`, so no wasm, wallet or network is touched.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeAccessProof } from '@meddleware/nft-gate-client'
import {
  clearPendingCertify,
  consumeStorageKey,
  createGatedAccess,
  getCertifyRetry,
  getDuplicateExisting,
  isRedeemedConflict,
  loadPendingCertifies,
  browserStorage,
  pendingCertifyKey,
  runBlobUpload,
  savePendingCertify,
  type GatedAccess,
  type StorageLike,
  type UploadProgress,
  type WalrusClientModule,
} from '../src/flow.js'

function fakeStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function makeModule() {
  const steps: string[] = []
  const regTx = { setSenderIfNotSet: vi.fn(), build: vi.fn(async () => {}) }
  const certTx = { setSenderIfNotSet: vi.fn(), build: vi.fn(async () => {}) }
  const flow = {
    encode: vi.fn(async () => {
      steps.push('encode')
      return { blobId: 'BLOB123' }
    }),
    register: vi.fn(() => {
      steps.push('register')
      return regTx
    }),
    upload: vi.fn(async (_: { digest: string; deletable?: boolean }) => {
      steps.push('upload')
      return { blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64' }
    }),
    certify: vi.fn(() => {
      steps.push('certify')
      return certTx
    }),
    getBlob: vi.fn(async () => ({ blobId: 'BLOB123' })),
  }
  const mod = {
    createWalrusClient: vi.fn((_opts: unknown) => ({ __client: true })),
    createBlobUploadFlow: vi.fn(() => flow),
    walrusBlobUrl: (network: string, blobId: string) => `https://agg.example/${network}/${blobId}`,
  } satisfies WalrusClientModule
  return { mod, flow, regTx, certTx, steps }
}

function makeExecutor() {
  return {
    signAndExecute: vi.fn(async (_tx: unknown) => ({ digest: `dig-${Math.random().toString(16).slice(2)}` })),
    waitForTransaction: vi.fn(async () => {}),
  }
}

const baseDeps = {
  bytes: new Uint8Array([1, 2, 3]),
  network: 'testnet' as const,
  relayHost: 'https://relay.example',
  address: '0xabc',
  wasmUrl: 'wasm://bundle',
  maxTipMist: 50_000_000,
  epochs: 53,
  suiClient: { __sui: true } as never,
  onStatus: () => {},
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('runBlobUpload', () => {
  it('runs encode → register → upload → certify and resolves id + url + digest', async () => {
    const { mod, steps } = makeModule()
    const executor = makeExecutor()
    const progress: UploadProgress[] = []
    const res = await runBlobUpload({ ...baseDeps, executor, onStatus: (p) => progress.push(p), loadWalrusClient: async () => mod })
    expect(steps).toEqual(['encode', 'register', 'upload', 'certify'])
    expect(res).toEqual({ blobId: 'BLOB123', url: 'https://agg.example/testnet/BLOB123', digest: expect.stringMatching(/^dig-/) })
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // register + certify
    expect(executor.waitForTransaction).toHaveBeenCalledTimes(2)
    expect(progress.map((p) => p.step)).toEqual(['encode', 'register', 'upload', 'certify'])
    expect(progress.every((p) => typeof p.detail === 'string' && p.detail.length > 0)).toBe(true)
  })

  it('registers permanent by default and deletable when chosen', async () => {
    for (const [deletable, expected] of [[undefined, false], [true, true]] as const) {
      const { mod, flow } = makeModule()
      await runBlobUpload({ ...baseDeps, ...(deletable === undefined ? {} : { deletable }), executor: makeExecutor(), loadWalrusClient: async () => mod })
      expect(flow.register).toHaveBeenCalledWith(expect.objectContaining({ deletable: expected }))
      expect(flow.upload).toHaveBeenCalledWith(expect.objectContaining({ deletable: expected }))
    }
  })

  it('passes the chosen epochs to register', async () => {
    const { mod, flow } = makeModule()
    await runBlobUpload({ ...baseDeps, epochs: 20, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledWith({ owner: '0xabc', epochs: 20, deletable: false })
  })

  it('always registers fresh and uploads with this attempt\'s register digest', async () => {
    const { mod, flow } = makeModule()
    const executor = makeExecutor()
    await runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledTimes(1)
    const regDigest = (await executor.signAndExecute.mock.results[0]!.value).digest
    expect(flow.upload).toHaveBeenCalledWith({ digest: regDigest, deletable: false })
  })

  it('aborts before registering when an existing certified copy is found (offers Extend)', async () => {
    const { mod, flow } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'certified' as const, blobId: 'BLOB123', objectId: 'OBJ_EXISTING', endEpoch: 570 }))
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy }))
    expect(findExistingCopy).toHaveBeenCalledWith('BLOB123')
    expect(getDuplicateExisting(thrown)).toMatchObject({ kind: 'certified', objectId: 'OBJ_EXISTING' })
    expect(flow.register).not.toHaveBeenCalled()
  })

  it('surfaces a pending existing copy (offers Certify)', async () => {
    const { mod } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'pending' as const, blobId: 'BLOB123', objectId: 'OBJ_PENDING', endEpoch: 560 }))
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy }))
    expect(getDuplicateExisting(thrown)?.kind).toBe('pending')
  })

  it('force bypasses the existing-copy check', async () => {
    const { mod, flow } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'certified' as const, blobId: 'BLOB123', objectId: 'OBJ', endEpoch: 570 }))
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy, force: true })
    expect(findExistingCopy).not.toHaveBeenCalled()
    expect(flow.register).toHaveBeenCalledTimes(1)
  })

  it('persists the certificate on upload and clears it on certify', async () => {
    const { mod } = makeModule()
    const onUploaded = vi.fn()
    const onCertified = vi.fn()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, onUploaded, onCertified })
    expect(onUploaded).toHaveBeenCalledWith({ blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64', deletable: false })
    expect(onCertified).toHaveBeenCalledWith('OBJ123')
  })

  it('on a certify failure, throws with a retry that certifies without re-uploading', async () => {
    const { mod, flow } = makeModule()
    let calls = 0
    const executor = {
      signAndExecute: vi.fn(async () => {
        calls += 1
        if (calls === 2) throw new Error('user rejected certify')
        return { digest: `dig-${calls}` }
      }),
      waitForTransaction: vi.fn(async () => {}),
    }
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod }))
    const retry = getCertifyRetry<{ blobId: string }>(thrown)
    expect(retry).toBeTypeOf('function')
    expect((await retry!()).blobId).toBe('BLOB123')
    expect(flow.certify).toHaveBeenCalledTimes(2)
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(flow.upload).toHaveBeenCalledTimes(1)
  })

  it('sets the sender on both the register and certify transactions', async () => {
    const { mod, regTx, certTx } = makeModule()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(regTx.setSenderIfNotSet).toHaveBeenCalledWith('0xabc')
    expect(certTx.setSenderIfNotSet).toHaveBeenCalledWith('0xabc')
  })

  it('forwards an RPC endpoint when given', async () => {
    const { mod } = makeModule()
    await runBlobUpload({ ...baseDeps, rpcUrl: 'https://rpc.example', executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(mod.createWalrusClient.mock.calls[0]![0]).toMatchObject({ rpcUrl: 'https://rpc.example' })
  })

  it('forwards relay host, tip cap and wasm url, and no auth for an open relay', async () => {
    const { mod } = makeModule()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod })
    const opts = mod.createWalrusClient.mock.calls[0]![0] as Record<string, unknown>
    expect(opts).toMatchObject({ network: 'testnet', wasmUrl: 'wasm://bundle', uploadRelayHost: 'https://relay.example', uploadRelayMaxTipMist: 50_000_000 })
    expect(opts.uploadRelayAuthToken).toBeUndefined()
  })
})

describe('runBlobUpload with gated access', () => {
  function access(tokens: string[]) {
    let i = 0
    return {
      token: vi.fn(async (_forceFresh: boolean) => tokens[i++] ?? 'none'),
      uploaded: vi.fn(() => {}),
    } satisfies GatedAccess
  }

  it('resolves a token first and threads it into the relay per request', async () => {
    const { mod } = makeModule()
    const gate = access(['tok-1'])
    const progress: UploadProgress[] = []
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), onStatus: (p) => progress.push(p), loadWalrusClient: async () => mod })
    expect(gate.token).toHaveBeenCalledWith(false)
    const provider = (mod.createWalrusClient.mock.calls[0]![0] as { uploadRelayAuthToken: () => string }).uploadRelayAuthToken
    expect(provider()).toBe('tok-1')
    expect(progress[0]!.step).toBe('access')
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
  })

  it('after a redeemed conflict, spends a new use and retries the upload on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 409'), { status: 409, error: { code: 'redeemed' } }))
    const gate = access(['tok-1', 'tok-2'])
    const executor = makeExecutor()
    await runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod })
    expect(gate.token.mock.calls).toEqual([[false], [true]])
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(flow.upload).toHaveBeenCalledTimes(2)
    expect(flow.upload.mock.calls[1]![0].digest).toBe(flow.upload.mock.calls[0]![0].digest)
    const provider = (mod.createWalrusClient.mock.calls[0]![0] as { uploadRelayAuthToken: () => string }).uploadRelayAuthToken
    expect(provider()).toBe('tok-2')
  })

  it('does not re-consume on other upload failures', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(new Error('network down'))
    const gate = access(['tok-1'])
    await expect(runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })).rejects.toThrow('network down')
    expect(gate.token).toHaveBeenCalledTimes(1)
    expect(gate.uploaded).not.toHaveBeenCalled()
  })

  it('marks access spent once the upload lands, even if certify then fails', async () => {
    const { mod } = makeModule()
    let calls = 0
    const executor = {
      signAndExecute: vi.fn(async () => {
        calls += 1
        if (calls === 2) throw new Error('rejected')
        return { digest: `d${calls}` }
      }),
      waitForTransaction: vi.fn(async () => {}),
    }
    const gate = access(['tok'])
    await rejection(runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod }))
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
  })
})

describe('createGatedAccess', () => {
  function ports(storage: StorageLike, singleUse = true) {
    return {
      storage,
      key: 'k',
      relayHost: 'https://relay',
      address: '0xabc',
      nftId: '0xnft',
      singleUse,
      buildConsume: vi.fn((_id: string, nonce: string) => ({ nonce })),
      signAndExecute: vi.fn(async (_tx: { nonce: string }) => ({ digest: 'fresh-digest' })),
      waitForTransaction: vi.fn(async () => {}),
      sign: vi.fn(async (_m: Uint8Array) => ({ signature: 'sig' })),
      fetchChallenge: vi.fn(async () => ({ nonce: 'nonce-xyz' })),
    }
  }

  it('consumes a use bound to the challenge nonce and persists the digest before returning', async () => {
    const storage = fakeStorage()
    const p = ports(storage)
    const token = await createGatedAccess(p).token(false)
    expect(p.buildConsume).toHaveBeenCalledWith('0xnft', 'nonce-xyz')
    expect(storage.getItem('k')).toBe('fresh-digest')
    expect(decodeAccessProof(token)).toMatchObject({ address: '0xabc', nonce: 'nonce-xyz', signature: 'sig', consumeDigest: 'fresh-digest' })
  })

  it('reuses a stored digest without consuming another use', async () => {
    const storage = fakeStorage({ k: 'stored-digest' })
    const p = ports(storage)
    const token = await createGatedAccess(p).token(false)
    expect(p.signAndExecute).not.toHaveBeenCalled()
    expect(p.fetchChallenge).toHaveBeenCalledTimes(1) // a fresh challenge is still signed (free)
    expect(decodeAccessProof(token)?.consumeDigest).toBe('stored-digest')
  })

  it('forceFresh drops a stored digest and consumes anew', async () => {
    const storage = fakeStorage({ k: 'stored-digest' })
    const p = ports(storage)
    const token = await createGatedAccess(p).token(true)
    expect(p.signAndExecute).toHaveBeenCalledTimes(1)
    expect(decodeAccessProof(token)?.consumeDigest).toBe('fresh-digest')
  })

  it('an unlimited pass only signs', async () => {
    const storage = fakeStorage()
    const p = ports(storage, false)
    const token = await createGatedAccess(p).token(false)
    expect(p.buildConsume).not.toHaveBeenCalled()
    expect(decodeAccessProof(token)?.consumeDigest).toBeUndefined()
  })

  it('uploaded() clears the stored digest', () => {
    const storage = fakeStorage({ k: 'd' })
    createGatedAccess(ports(storage)).uploaded()
    expect(storage.getItem('k')).toBeNull()
  })

  it('does not block on an indexing delay after the consume', async () => {
    const p = ports(fakeStorage())
    p.waitForTransaction.mockRejectedValueOnce(new Error('not indexed yet'))
    await expect(createGatedAccess(p).token(false)).resolves.toBeTypeOf('string')
  })
})

describe('isRedeemedConflict', () => {
  it('matches a structured 409 redeemed', () => {
    expect(isRedeemedConflict({ status: 409, error: { code: 'redeemed' } })).toBe(true)
    expect(isRedeemedConflict({ status: 409, error: { code: 'leased' } })).toBe(false)
    expect(isRedeemedConflict({ status: 500, error: { code: 'redeemed' } })).toBe(false)
  })

  it('matches the message form and a wrapped cause', () => {
    expect(isRedeemedConflict(new Error('Upload relay responded 409: consume already redeemed'))).toBe(true)
    expect(isRedeemedConflict(new Error('outer', { cause: { status: 409, error: { code: 'redeemed' } } }))).toBe(true)
    expect(isRedeemedConflict(new Error('409 conflict'))).toBe(false)
  })

  it('is false for other values', () => {
    expect(isRedeemedConflict(new Error('network'))).toBe(false)
    expect(isRedeemedConflict(null)).toBe(false)
    const loop: { cause?: unknown } = {}
    loop.cause = { cause: loop }
    expect(isRedeemedConflict(loop)).toBe(false)
  })
})

describe('persistence keys and pending certifications', () => {
  it('keys are namespaced', () => {
    expect(consumeStorageKey('testnet', '0xgate', '0xaddr')).toBe('mw:walrus:consume:testnet:0xgate:0xaddr')
    expect(pendingCertifyKey('testnet', '0xabc')).toBe('mw:walrus:pendingCertify:testnet:0xabc')
  })

  const entry = { blobId: 'BLOB1', blobObjectId: 'OBJ1', certificate: 'CERT_B64', deletable: false }

  it('saves, loads and clears a pending certification', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    savePendingCertify(storage, key, entry)
    const map = loadPendingCertifies(storage, key)
    expect(map.OBJ1).toMatchObject(entry)
    expect(typeof map.OBJ1!.savedAt).toBe('number')
    clearPendingCertify(storage, key, 'OBJ1')
    expect(storage.getItem(key)).toBeNull()
  })

  it('keeps other entries when clearing one', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    savePendingCertify(storage, key, entry)
    savePendingCertify(storage, key, { ...entry, blobId: 'BLOB2', blobObjectId: 'OBJ2' })
    clearPendingCertify(storage, key, 'OBJ1')
    expect(Object.keys(loadPendingCertifies(storage, key))).toEqual(['OBJ2'])
  })

  it('drops malformed or mis-keyed stored entries (browser storage is untrusted)', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    const good = { ...entry, savedAt: 1 }
    storage.setItem(
      key,
      JSON.stringify({
        OBJ1: good,
        OBJ2: { ...good, blobObjectId: 'OTHER' }, // key and object id disagree
        OBJ3: { ...good, blobObjectId: 'OBJ3', deletable: 'no' },
        OBJ4: { ...good, blobObjectId: 'OBJ4', extra: '<script>' },
      }),
    )
    const map = loadPendingCertifies(storage, key)
    expect(Object.keys(map).sort()).toEqual(['OBJ1', 'OBJ4'])
    expect(map.OBJ4).toEqual({ ...good, blobObjectId: 'OBJ4' }) // copied field by field
  })

  it('returns an empty map for missing or corrupt data', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    expect(loadPendingCertifies(storage, key)).toEqual({})
    storage.setItem(key, 'not json')
    expect(loadPendingCertifies(storage, key)).toEqual({})
    storage.setItem(key, '[1]')
    expect(loadPendingCertifies(storage, key)).toEqual({})
  })
})

describe('browserStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps values in memory when localStorage is unavailable (blocked site data)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    const storage = browserStorage()
    expect(storage.getItem('k')).toBeNull()
    storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
  })

  it('uses localStorage when it works', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    })
    const storage = browserStorage()
    storage.setItem('k', 'v')
    expect(map.get('k')).toBe('v')
    expect(browserStorage().getItem('k')).toBe('v') // survives a new instance (a reload)
  })
})

