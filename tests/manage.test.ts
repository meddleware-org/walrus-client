import { describe, it, expect, vi } from 'vitest'
import {
  extendBlobLifetime,
  extendBlobLifetimeTransaction,
  certifyBlobTransaction,
  estimateStorageCost,
  setBlobAttributes,
  setBlobAttributesTransaction,
  readBlobAttributes,
} from '../src/manage.js'

function fakeClient() {
  const calls: Record<string, any[]> = {}
  const record = (k: string) => (arg: any) => {
    ;(calls[k] ||= []).push(arg)
    if (k === 'readBlobAttributes') return { color: 'blue' }
    // execute* methods sign and return a digest; the plain *Transaction
    // builders return an unsigned transaction object.
    if (k.startsWith('execute')) return { digest: `DIGEST_${k}` }
    return { __tx: k }
  }
  const client = {
    walrus: {
      executeExtendBlobTransaction: vi.fn(record('executeExtendBlobTransaction')),
      extendBlobTransaction: vi.fn(record('extendBlobTransaction')),
      certifyBlobTransaction: vi.fn(record('certifyBlobTransaction')),
      storageCost: vi.fn(async (_size: number, _epochs: number) => ({
        storageCost: 900n,
        writeCost: 100n,
        totalCost: 1000n,
      })),
      executeWriteBlobAttributesTransaction: vi.fn(record('executeWriteBlobAttributesTransaction')),
      writeBlobAttributesTransaction: vi.fn(record('writeBlobAttributesTransaction')),
      readBlobAttributes: vi.fn(record('readBlobAttributes')),
    },
  }
  return { client: client as any, calls }
}

const signer = { __signer: true } as any

describe('extendBlobLifetime', () => {
  it('threads ExtendOptions (epochs form) and returns the digest', async () => {
    const { client, calls } = fakeClient()
    const res = await extendBlobLifetime(client, 'OBJ', signer, { epochs: 10 })
    expect(calls.executeExtendBlobTransaction[0]).toMatchObject({
      blobObjectId: 'OBJ',
      signer,
      epochs: 10,
    })
    expect(res).toEqual({ digest: 'DIGEST_executeExtendBlobTransaction' })
  })

  it('threads ExtendOptions (endEpoch form)', async () => {
    const { client, calls } = fakeClient()
    await extendBlobLifetime(client, 'OBJ', signer, { endEpoch: 500 })
    expect(calls.executeExtendBlobTransaction[0]).toMatchObject({ endEpoch: 500 })
  })
})

describe('extendBlobLifetimeTransaction', () => {
  it('returns an unsigned transaction (wallet-safe)', () => {
    const { client } = fakeClient()
    const tx = extendBlobLifetimeTransaction(client, 'OBJ', { epochs: 3 })
    expect(tx).toEqual({ __tx: 'extendBlobTransaction' })
  })
})

describe('certifyBlobTransaction', () => {
  it('passes the base64 certificate + ids through and returns an unsigned tx', () => {
    const { client, calls } = fakeClient()
    const tx = certifyBlobTransaction(client, {
      blobId: 'BLOB',
      blobObjectId: 'OBJ',
      certificate: 'CERT_B64',
    })
    expect(calls.certifyBlobTransaction[0]).toEqual({
      blobId: 'BLOB',
      blobObjectId: 'OBJ',
      certificate: 'CERT_B64',
      deletable: false,
    })
    expect(tx).toEqual({ __tx: 'certifyBlobTransaction' })
  })
})

describe('estimateStorageCost', () => {
  it('passes size + epochs to the SDK and returns its cost breakdown', async () => {
    const { client } = fakeClient()
    const cost = await estimateStorageCost(client, 2048, 10)
    expect(client.walrus.storageCost).toHaveBeenCalledWith(2048, 10)
    expect(cost).toEqual({ storageCost: 900n, writeCost: 100n, totalCost: 1000n })
  })
})

describe('setBlobAttributes / readBlobAttributes', () => {
  it('executes attribute write with signer and returns digest', async () => {
    const { client, calls } = fakeClient()
    const res = await setBlobAttributes(client, 'OBJ', signer, { color: 'blue', old: null })
    expect(calls.executeWriteBlobAttributesTransaction[0]).toMatchObject({
      blobObjectId: 'OBJ',
      signer,
      attributes: { color: 'blue', old: null },
    })
    expect(res).toEqual({ digest: 'DIGEST_executeWriteBlobAttributesTransaction' })
  })

  it('setBlobAttributesTransaction returns an unsigned tx', () => {
    const { client } = fakeClient()
    const tx = setBlobAttributesTransaction(client, 'OBJ', { a: 'b' })
    expect(tx).toEqual({ __tx: 'writeBlobAttributesTransaction' })
  })

  it('readBlobAttributes returns the attribute map', async () => {
    const { client } = fakeClient()
    const attrs = await readBlobAttributes(client, 'OBJ')
    expect(attrs).toEqual({ color: 'blue' })
  })
})
