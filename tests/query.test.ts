import { describe, it, expect, vi } from 'vitest'

// blobIdFromInt is deterministic in the real SDK; stub it to a readable form so
// the test asserts wiring (owned-object parsing) rather than the encoding itself.
vi.mock('@mysten/walrus', () => ({
  blobIdFromInt: (n: bigint) => `blobid-${n.toString()}`,
}))

import { fetchOwnedWalrusBlobs } from '../src/query.js'

function makeWalrusClient() {
  return {
    walrus: {
      getBlobType: vi.fn().mockResolvedValue('0xpkg::blob::Blob'),
    },
  } as any
}

/** Build a mock core client whose `listOwnedObjects` returns the given objects. */
function makeSuiClient(objects: unknown[]) {
  const listOwnedObjects = vi.fn().mockResolvedValue({ objects, hasNextPage: false, cursor: null })
  return { client: { core: { listOwnedObjects } } as any, listOwnedObjects }
}

describe('fetchOwnedWalrusBlobs (gRPC core API)', () => {
  it('maps owned Blob objects (flat gRPC json shape) to OwnedBlob entries', async () => {
    const walrusClient = makeWalrusClient()
    const { client, listOwnedObjects } = makeSuiClient([
      {
        objectId: '0xobj1',
        type: '0xpkg::blob::Blob',
        // gRPC/core returns Move struct fields flat under `json`.
        json: { blob_id: '123', size: '2048', certified_epoch: 42, deletable: false, storage: { start_epoch: 1, end_epoch: 100 } },
      },
    ])

    const blobs = await fetchOwnedWalrusBlobs(client, walrusClient, '0xowner')

    expect(listOwnedObjects).toHaveBeenCalledWith({
      owner: '0xowner',
      type: '0xpkg::blob::Blob',
      include: { json: true },
    })
    expect(blobs).toEqual([
      { objectId: '0xobj1', blobId: 'blobid-123', size: 2048, startEpoch: 1, endEpoch: 100, certified: true, deletable: false },
    ])
  })

  it('lists a blob whose id is a real u256 (up to 78 digits), not only small test ids', async () => {
    // A blob id is a 32-byte value shown as a decimal u256. Capping every integer field at u64's 20 digits
    // dropped every real blob (the owned-blob list was empty on a live network).
    const realId = ((1n << 255n) + 123456789n).toString() // 77 digits
    const maxId = ((1n << 256n) - 1n).toString() // 78 digits
    expect(realId.length).toBe(77)
    expect(maxId.length).toBe(78)
    const blob = (objectId: string, id: string) => ({
      objectId,
      type: '0xpkg::blob::Blob',
      json: { blob_id: id, size: '2048', certified_epoch: 1, deletable: false, storage: { start_epoch: 1, end_epoch: 100 } },
    })
    const { client } = makeSuiClient([blob('0xa', realId), blob('0xb', maxId), blob('0xc', maxId + '0'), blob('0xd', '1'.repeat(79))])
    const blobs = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    // The two valid ids are listed; an id above u256::MAX (or longer than 78 digits) is not.
    expect(blobs.map((b) => b.objectId)).toEqual(['0xa', '0xb'])
    expect(blobs[0]!.blobId).toBe(`blobid-${realId}`)
  })

  it('pages through every owned blob with the cursor', async () => {
    const blob = (id: string) => ({
      objectId: id,
      type: '0xpkg::blob::Blob',
      json: { blob_id: '1', size: '1', certified_epoch: 1, deletable: false, storage: { start_epoch: 1, end_epoch: 9 } },
    })
    const listOwnedObjects = vi
      .fn()
      .mockResolvedValueOnce({ objects: [blob('0xa')], hasNextPage: true, cursor: 'c1' })
      .mockResolvedValueOnce({ objects: [blob('0xb')], hasNextPage: false, cursor: null })
    const client = { core: { listOwnedObjects } } as any
    const blobs = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blobs.map((b) => b.objectId)).toEqual(['0xa', '0xb'])
    expect(listOwnedObjects).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }))
  })

  it('tolerates the nested `.fields` shape (transport robustness)', async () => {
    const { client } = makeSuiClient([
      {
        objectId: '0xobj1b',
        type: '0xpkg::blob::Blob',
        json: { fields: { blob_id: '9', size: '5', certified_epoch: 1, deletable: false, storage: { fields: { start_epoch: 40, end_epoch: 50 } } } },
      },
    ])
    const [blob] = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blob).toEqual({ objectId: '0xobj1b', blobId: 'blobid-9', size: 5, startEpoch: 40, endEpoch: 50, certified: true, deletable: false })
  })

  it('marks blobs with a null certified_epoch as uncertified', async () => {
    const { client } = makeSuiClient([
      {
        objectId: '0xobj2',
        type: '0xpkg::blob::Blob',
        json: { blob_id: '7', size: '10', certified_epoch: null, deletable: false, storage: { start_epoch: 1, end_epoch: '5' } },
      },
    ])
    const [blob] = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blob!.certified).toBe(false)
    expect(blob!.endEpoch).toBe(5)
  })

  it('lists the epochs and deletability of a blob exactly as a live testnet object reports them', async () => {
    // Captured from a real testnet Blob object (gRPC json): u64 fields are strings, u32 epochs numbers.
    const { client } = makeSuiClient([
      {
        objectId: '0x0000050b53d7416f86404c649224f3cdc9846d544c2d4e921601baa8c0df00e7',
        type: '0xpkg::blob::Blob',
        json: {
          blob_id: '80825333549667643570597252035902256285625078742945962467090534703841599275567',
          certified_epoch: 204,
          deletable: true,
          encoding_type: 1,
          id: '0x0000050b53d7416f86404c649224f3cdc9846d544c2d4e921601baa8c0df00e7',
          registered_epoch: 204,
          size: '1048576',
          storage: { end_epoch: 205, id: '0x1198f107c6adce87a6251fe0a648b4e5d939c1526d43858d42e8068f8d645d5d', start_epoch: 204, storage_size: '70038000' },
        },
      },
    ])
    const [blob] = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blob).toMatchObject({ size: 1048576, startEpoch: 204, endEpoch: 205, certified: true, deletable: true })
  })

  it('never invents deletability: a blob whose deletable flag is missing or not a boolean is skipped', async () => {
    const entry = (objectId: string, deletable: unknown) => ({
      objectId,
      type: '0xpkg::blob::Blob',
      json: { blob_id: '1', size: '1', certified_epoch: 1, ...(deletable === undefined ? {} : { deletable }), storage: { start_epoch: 1, end_epoch: 9 } },
    })
    const { client } = makeSuiClient([entry('0xa', undefined), entry('0xb', 'true'), entry('0xc', 1), entry('0xd', true), entry('0xe', false)])
    const blobs = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blobs.map((b) => [b.objectId, b.deletable])).toEqual([['0xd', true], ['0xe', false]])
  })

  it('never invents a value: a blob missing its size or end epoch is skipped', async () => {
    const { client } = makeSuiClient([
      { objectId: '0xa', type: '0xpkg::blob::Blob', json: { blob_id: '7', size: '10', storage: {} } },
      { objectId: '0xb', type: '0xpkg::blob::Blob', json: { blob_id: '7', storage: { start_epoch: 1, end_epoch: '5' } } },
      { objectId: '0xc', type: '0xpkg::blob::Blob', json: { blob_id: '7', size: 'ten', storage: { start_epoch: 1, end_epoch: '5' } } },
    ])
    expect(await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')).toEqual([])
  })

  it('skips objects that are not exactly the Blob type, comparing normalised types', async () => {
    const { client } = makeSuiClient([
      { objectId: '0xa', type: '0xevil::blob::Blob', json: { blob_id: '7', size: '1', storage: { start_epoch: 1, end_epoch: '5' } } },
      { objectId: '0xb', type: `0x${'0'.repeat(61)}pkg::blob::Blob`.replace('pkg', 'abc'), json: { blob_id: '7', size: '1', storage: { start_epoch: 1, end_epoch: '5' } } },
      { objectId: '0xc', type: '0xPKG::blob::Blob', json: { blob_id: '8', size: '1', deletable: false, storage: { start_epoch: 1, end_epoch: '5' } } },
    ])
    const blobs = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blobs.map((b) => b.objectId)).toEqual(['0xc'])
  })

  it('throws instead of paging forever', async () => {
    const listOwnedObjects = vi.fn().mockResolvedValue({ objects: [], hasNextPage: true, cursor: 'again' })
    const client = { core: { listOwnedObjects } } as any
    await expect(fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')).rejects.toThrow(/more than 100 pages/)
    expect(listOwnedObjects).toHaveBeenCalledTimes(100)
  })

  it('skips entries with missing json or unparseable fields', async () => {
    const { client } = makeSuiClient([
      { objectId: '0xobj3', type: '0xpkg::blob::Blob', json: null },
      {
        objectId: '0xobj4',
        type: '0xpkg::blob::Blob',
        json: { blob_id: 'not-a-bigint', size: '1', storage: {} },
      },
    ])
    const blobs = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blobs).toEqual([])
  })
})
