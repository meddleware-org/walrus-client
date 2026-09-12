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
        json: { blob_id: '123', size: '2048', certified_epoch: 42, storage: { end_epoch: 100 } },
      },
    ])

    const blobs = await fetchOwnedWalrusBlobs(client, walrusClient, '0xowner')

    expect(listOwnedObjects).toHaveBeenCalledWith({
      owner: '0xowner',
      type: '0xpkg::blob::Blob',
      include: { json: true },
    })
    expect(blobs).toEqual([
      { objectId: '0xobj1', blobId: 'blobid-123', size: 2048, endEpoch: 100, certified: true },
    ])
  })

  it('tolerates the nested `.fields` shape (transport robustness)', async () => {
    const { client } = makeSuiClient([
      {
        objectId: '0xobj1b',
        type: '0xpkg::blob::Blob',
        json: { fields: { blob_id: '9', size: '5', certified_epoch: 1, storage: { fields: { end_epoch: 50 } } } },
      },
    ])
    const [blob] = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blob).toEqual({ objectId: '0xobj1b', blobId: 'blobid-9', size: 5, endEpoch: 50, certified: true })
  })

  it('marks blobs with a null certified_epoch as uncertified', async () => {
    const { client } = makeSuiClient([
      {
        objectId: '0xobj2',
        type: '0xpkg::blob::Blob',
        json: { blob_id: '7', size: '10', certified_epoch: null, storage: {} },
      },
    ])
    const [blob] = await fetchOwnedWalrusBlobs(client, makeWalrusClient(), '0xowner')
    expect(blob.certified).toBe(false)
    expect(blob.endEpoch).toBe(0)
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
