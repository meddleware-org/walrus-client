import { describe, it, expect, vi } from 'vitest'

// blobIdFromInt is deterministic in the real SDK; stub it to a readable form so
// the test asserts wiring (owned-object parsing) rather than the encoding itself.
vi.mock('@mysten/walrus', () => ({
  blobIdFromInt: (n: bigint) => `blobid-${n.toString()}`,
}))

import { fetchOwnedWalrusBlobs } from '../src/query.js'

function makeWalrusClient() {
  return {
    walrus: { getBlobType: vi.fn().mockResolvedValue('0xpkg::blob::Blob') },
  } as any
}

describe('fetchOwnedWalrusBlobs', () => {
  it('maps owned Blob objects to OwnedBlob entries', async () => {
    const walrusClient = makeWalrusClient()
    const suiClient = {
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [
          {
            data: {
              objectId: '0xobj1',
              content: {
                fields: {
                  blob_id: '123',
                  size: '2048',
                  certified_epoch: 42,
                  storage: { fields: { end_epoch: 100 } },
                },
              },
            },
          },
        ],
      }),
    } as any

    const blobs = await fetchOwnedWalrusBlobs(suiClient, walrusClient, '0xowner')

    expect(suiClient.getOwnedObjects).toHaveBeenCalledWith({
      owner: '0xowner',
      filter: { StructType: '0xpkg::blob::Blob' },
      options: { showContent: true },
    })
    expect(blobs).toEqual([
      { objectId: '0xobj1', blobId: 'blobid-123', size: 2048, endEpoch: 100, certified: true },
    ])
  })

  it('marks blobs with a null certified_epoch as uncertified', async () => {
    const suiClient = {
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [
          {
            data: {
              objectId: '0xobj2',
              content: {
                fields: { blob_id: '7', size: '10', certified_epoch: null, storage: { fields: {} } },
              },
            },
          },
        ],
      }),
    } as any

    const [blob] = await fetchOwnedWalrusBlobs(suiClient, makeWalrusClient(), '0xowner')
    expect(blob.certified).toBe(false)
    expect(blob.endEpoch).toBe(0)
  })

  it('skips entries with missing data or unparseable fields', async () => {
    const suiClient = {
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [
          { data: null },
          { data: { objectId: '0xobj3', content: { fields: undefined } } },
          {
            data: {
              objectId: '0xobj4',
              content: { fields: { blob_id: 'not-a-bigint', size: '1', storage: { fields: {} } } },
            },
          },
        ],
      }),
    } as any

    const blobs = await fetchOwnedWalrusBlobs(suiClient, makeWalrusClient(), '0xowner')
    expect(blobs).toEqual([])
  })
})
