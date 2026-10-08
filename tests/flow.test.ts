// Unit tests for the headless upload orchestrator and its resume conventions. A fake root module is
// injected via `loadWalrusClient`, so no wasm, wallet or network is touched.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeAccessProof } from '@meddleware/nft-gate-client'
import {
  CONSUME_RESUME_MAX_AGE_MS,
  REGISTRATION_FRESH_MS,
  UPLOAD_ATTEMPTS,
  clearPendingCertify,
  consumeStorageKey,
  createGatedAccess,
  getCertifyRetry,
  getDuplicateExisting,
  getUploadRetry,
  httpStatusOf,
  isConsumeRejected,
  isLeasedConflict,
  isRedeemedConflict,
  isStaleProof,
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

const GATE = '0x' + 'a1'.repeat(32)
const DIGEST = '5Wq9tE4gXz8hEvFhYt8KkTJb2Pp6qXqj8cRk3xN1mYdL'
const DIGEST2 = '3ucNSQzgjYgSNxS9cM3ZHSc3zLyLEWd9mT4pYiiyqKQ4'
const noSleep = async () => {}

const baseDeps = {
  sleep: noSleep,
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
      prepare: vi.fn(async () => {}),
      token: vi.fn(async (_opts?: { forceFresh?: boolean }) => tokens[i++] ?? `tok-${i}`),
      resumed: vi.fn(() => false),
      uploaded: vi.fn(() => {}),
    } satisfies GatedAccess
  }
  const providerOf = (mod: ReturnType<typeof makeModule>['mod']) =>
    (mod.createWalrusClient.mock.calls[0]![0] as { uploadRelayAuthToken: () => string }).uploadRelayAuthToken

  it('spends the consume before register, mints the token AFTER register, and threads it into the relay', async () => {
    const { mod, steps } = makeModule()
    const gate = access(['tok-1'])
    gate.prepare.mockImplementation(async () => void steps.push('prepare'))
    gate.token.mockImplementation(async () => {
      steps.push('token')
      return 'tok-1'
    })
    const progress: UploadProgress[] = []
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), onStatus: (p) => progress.push(p), loadWalrusClient: async () => mod })
    expect(steps).toEqual(['prepare', 'encode', 'register', 'token', 'upload', 'certify'])
    expect(providerOf(mod)()).toBe('tok-1')
    expect(progress[0]!.step).toBe('access')
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
  })

  it('after a redeemed conflict, spends a new use and retries on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 409'), { status: 409, error: { code: 'redeemed' } }))
    const gate = access(['tok-1', 'tok-2'])
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(gate.token.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: true }]])
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(flow.upload).toHaveBeenCalledTimes(2)
    expect(flow.upload.mock.calls[1]![0].digest).toBe(flow.upload.mock.calls[0]![0].digest)
    expect(providerOf(mod)()).toBe('tok-2')
  })

  it('a relay 5xx or a network error retries on the same registration with a fresh token, no new consume', async () => {
    for (const failure of [Object.assign(new Error('relay 503'), { status: 503 }), new Error('network down')]) {
      const { mod, flow } = makeModule()
      flow.upload.mockRejectedValueOnce(failure)
      const gate = access(['tok-1', 'tok-2'])
      const executor = makeExecutor()
      await runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod })
      expect(gate.token.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: false }]])
      expect(flow.register).toHaveBeenCalledTimes(1)
      expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // one register + one certify: not paid twice
    }
  })

  it('an expired-challenge rejection retries on the same registration with a fresh token', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 403: challenge nonce invalid, expired, or already used'), { status: 403 }))
    const gate = access(['tok-1', 'tok-2'])
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(gate.token).toHaveBeenCalledTimes(2)
  })

  it('a rejected RESUMED consume is dropped and consumed anew, once', async () => {
    const { mod, flow } = makeModule()
    const rejected = Object.assign(new Error('relay 403: no matching single-use consume for this address'), { status: 403 })
    flow.upload.mockRejectedValueOnce(rejected).mockRejectedValueOnce(rejected)
    const gate = access(['tok-1', 'tok-2', 'tok-3'])
    gate.resumed.mockReturnValue(true)
    await expect(runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })).rejects.toThrow(/single-use consume/)
    // First retry re-consumes; a second rejection is final (bounded).
    expect(gate.token.mock.calls[1]).toEqual([{ forceFresh: true }])
    expect(gate.token).toHaveBeenCalledTimes(2)
  })

  it('does not retry a rejection that is not about the proof (e.g. 400, 403 not an owner)', async () => {
    for (const failure of [Object.assign(new Error('relay 400 bad request'), { status: 400 }), Object.assign(new Error('relay 403 address does not hold the required access NFT'), { status: 403 })]) {
      const { mod, flow } = makeModule()
      flow.upload.mockRejectedValue(failure)
      const gate = access(['tok-1'])
      await expect(runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })).rejects.toThrow()
      expect(flow.upload).toHaveBeenCalledTimes(1)
      expect(gate.uploaded).not.toHaveBeenCalled()
    }
  })

  it('bounds the retries and hands the caller an uploadRetry on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValue(Object.assign(new Error('relay 502'), { status: 502 }))
    const gate = access([])
    const executor = makeExecutor()
    const err = await rejection(runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod }))
    expect(flow.upload).toHaveBeenCalledTimes(UPLOAD_ATTEMPTS)
    expect(flow.register).toHaveBeenCalledTimes(1)
    const retry = getUploadRetry<{ digest?: string }>(err)
    expect(retry).toBeTypeOf('function')
    // The relay recovers: the retry uploads on the SAME registration, then certifies.
    flow.upload.mockResolvedValue({ blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64' })
    const res = await retry!()
    expect(res).toMatchObject({ blobId: 'BLOB123' })
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // register once, certify once
  })

  it('does not retry once the registration is too old for the relay', async () => {
    const { mod, flow } = makeModule()
    let clock = 1_000_000
    flow.upload.mockImplementation(async () => {
      clock += REGISTRATION_FRESH_MS + 1
      throw Object.assign(new Error('relay 502'), { status: 502 })
    })
    const err = await rejection(runBlobUpload({ ...baseDeps, access: access([]), executor: makeExecutor(), now: () => clock, loadWalrusClient: async () => mod }))
    expect(flow.upload).toHaveBeenCalledTimes(1)
    expect(getUploadRetry(err)).toBeNull()
  })

  it('an open relay also retries transient failures on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 503'), { status: 503 }))
    const executor = makeExecutor()
    await runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod })
    expect(flow.upload).toHaveBeenCalledTimes(2)
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid epochs before any wallet prompt', async () => {
    const { mod } = makeModule()
    const executor = makeExecutor()
    for (const epochs of [0, -1, 1.5, 54, Number.NaN]) {
      await expect(runBlobUpload({ ...baseDeps, epochs, executor, loadWalrusClient: async () => mod })).rejects.toThrow(/epochs must be/)
    }
    expect(executor.signAndExecute).not.toHaveBeenCalled()
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
    const err = await rejection(runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod }))
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
    expect(getCertifyRetry(err)).toBeTypeOf('function')
    expect(getUploadRetry(err)).toBeNull()
  })
})

describe('createGatedAccess', () => {
  const NOW = 1_800_000_000_000
  function ports(storage: StorageLike, singleUse = true) {
    return {
      storage,
      key: 'k',
      relayHost: 'https://relay.example',
      address: '0xabc',
      gateId: GATE,
      network: 'testnet' as const,
      nftId: '0xnft',
      singleUse,
      buildConsume: vi.fn((_id: string, nonce: string) => ({ nonce })),
      signAndExecute: vi.fn(async (_tx: { nonce: string }) => ({ digest: DIGEST })),
      waitForTransaction: vi.fn(async () => {}),
      sign: vi.fn(async (_m: Uint8Array) => ({ signature: 'U0lH' })),
      fetchChallenge: vi.fn(async () => ({ nonce: 'nonce-xyz' })),
      now: () => NOW,
    }
  }
  const stored = (over: Record<string, unknown> = {}) => JSON.stringify({ digest: DIGEST2, nftId: '0xnft', savedAt: NOW - 1000, ...over })

  it('consumes a use bound to the challenge nonce and persists {digest, nftId, savedAt} before signing', async () => {
    const storage = fakeStorage()
    const p = ports(storage)
    const gate = createGatedAccess(p)
    await gate.prepare()
    expect(p.buildConsume).toHaveBeenCalledWith('0xnft', 'nonce-xyz')
    expect(JSON.parse(storage.getItem('k')!)).toEqual({ digest: DIGEST, nftId: '0xnft', savedAt: NOW })
    expect(p.sign).not.toHaveBeenCalled() // preparing never signs
    const token = await gate.token()
    expect(p.signAndExecute).toHaveBeenCalledTimes(1) // token() reuses the prepared consume
    expect(decodeAccessProof(token)).toMatchObject({ address: '0xabc', nonce: 'nonce-xyz', signature: 'U0lH', consumeDigest: DIGEST })
  })

  it('signs the audience-bound message: relay origin, gate, network, nonce and the consume', async () => {
    const p = ports(fakeStorage())
    await createGatedAccess(p).token()
    expect(new TextDecoder().decode(p.sign.mock.calls[0]![0])).toBe(
      `nft-gate:access:v2\norigin:https://relay.example\ngate:${GATE}\nnetwork:testnet\nnonce:nonce-xyz\nconsume:${DIGEST}`,
    )
  })

  it('reuses a valid stored digest without consuming another use', async () => {
    const p = ports(fakeStorage({ k: stored() }))
    const gate = createGatedAccess(p)
    const token = await gate.token()
    expect(p.signAndExecute).not.toHaveBeenCalled()
    expect(gate.resumed()).toBe(true)
    expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST2)
  })

  it('drops a stored value that is malformed, for another pass, stale, or from the future, and consumes anew', async () => {
    for (const bad of [
      'plain-old-digest-string',
      '{"digest":"not base58!","nftId":"0xnft","savedAt":1}',
      stored({ nftId: '0xother' }),
      stored({ savedAt: NOW - CONSUME_RESUME_MAX_AGE_MS - 1 }),
      stored({ savedAt: NOW + 3_600_000 }),
      stored({ digest: 7 }),
      '[]',
      'x'.repeat(5000),
    ]) {
      const p = ports(fakeStorage({ k: bad }))
      const gate = createGatedAccess(p)
      const token = await gate.token()
      expect(p.signAndExecute, bad.slice(0, 40)).toHaveBeenCalledTimes(1)
      expect(gate.resumed()).toBe(false)
      expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST)
    }
  })

  it('forceFresh drops a stored digest and consumes anew', async () => {
    const p = ports(fakeStorage({ k: stored() }))
    const token = await createGatedAccess(p).token({ forceFresh: true })
    expect(p.signAndExecute).toHaveBeenCalledTimes(1)
    expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST)
  })

  it('refuses a consume result without a valid digest instead of storing it', async () => {
    const storage = fakeStorage()
    const p = ports(storage)
    for (const digest of [undefined, '', 'DIGEST-1']) {
      p.signAndExecute.mockResolvedValueOnce({ digest } as never)
      await expect(createGatedAccess(p).prepare()).rejects.toThrow(/no valid digest/)
      expect(storage.getItem('k')).toBeNull()
    }
  })

  it('an unlimited pass only signs', async () => {
    const p = ports(fakeStorage(), false)
    const gate = createGatedAccess(p)
    await gate.prepare()
    const token = await gate.token()
    expect(p.buildConsume).not.toHaveBeenCalled()
    expect(decodeAccessProof(token).consumeDigest).toBeUndefined()
  })

  it('uploaded() clears the stored digest', () => {
    const storage = fakeStorage({ k: stored() })
    createGatedAccess(ports(storage)).uploaded()
    expect(storage.getItem('k')).toBeNull()
  })

  it('does not block on an indexing delay after the consume', async () => {
    const p = ports(fakeStorage())
    p.waitForTransaction.mockRejectedValueOnce(new Error('not indexed yet'))
    await expect(createGatedAccess(p).token()).resolves.toBeTypeOf('string')
  })
})

describe('upload error classification', () => {
  it('reads an HTTP status from the error, its message or its cause', () => {
    expect(httpStatusOf({ status: 503 })).toBe(503)
    expect(httpStatusOf(new Error('relay responded 429 slow down'))).toBe(429)
    expect(httpStatusOf(new Error('outer', { cause: { status: 401 } }))).toBe(401)
    expect(httpStatusOf(new Error('network down'))).toBeNull()
    expect(httpStatusOf(null)).toBeNull()
  })

  it('names the gateway rejections the flow reacts to', () => {
    expect(isConsumeRejected(Object.assign(new Error('403 no matching single-use consume for this address'), { status: 403 }))).toBe(true)
    expect(isConsumeRejected(new Error('403 address does not hold the required access NFT'))).toBe(false)
    expect(isLeasedConflict({ status: 409, error: { code: 'leased' } })).toBe(true)
    expect(isLeasedConflict(new Error('409 an upload for this consume is already in progress'))).toBe(true)
    expect(isLeasedConflict({ status: 409, error: { code: 'redeemed' } })).toBe(false)
    expect(isStaleProof(new Error('401 missing access proof'))).toBe(true)
    expect(isStaleProof(new Error('403 challenge nonce invalid, expired, or already used'))).toBe(true)
    expect(isStaleProof(new Error('403 the gate is paused'))).toBe(false)
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

