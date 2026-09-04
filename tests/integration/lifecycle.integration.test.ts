// Real blob lifecycle against the localnet testbed: upload → aggregator read-back → extend →
// attributes → owned-blob query. Gated by WALRUS_LOCALNET (see localnet/README.md); the whole
// suite is skipped when the env contract is absent, so `npm test` stays green offline.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  LOCALNET_READY,
  localnetWalrusClient,
  localnetSuiClient,
  localnetSigner,
  localnetAddress,
  aggregatorRead,
  uploadImageBytesWithRetry,
} from './harness.js'
import {
  extendBlobLifetime,
  setBlobAttributes,
  readBlobAttributes,
} from '../../src/manage.js'
import { fetchOwnedWalrusBlobs } from '../../src/query.js'

describe.skipIf(!LOCALNET_READY)('walrus-client localnet blob lifecycle', () => {
  let client: ReturnType<typeof localnetWalrusClient>
  let signer: ReturnType<typeof localnetSigner>
  const payload = new TextEncoder().encode(`meddleware-localnet-${Date.now()}`)
  let blobId: string
  let blobObjectId: string

  beforeAll(() => {
    client = localnetWalrusClient()
    signer = localnetSigner()
  })

  it('uploads a raw blob and reads identical bytes back from the aggregator', async () => {
    const res = await uploadImageBytesWithRetry(client, payload, signer, { epochs: 3 })
    expect(res.blobId).toBeTruthy()
    expect(res.blobObjectId).toBeTruthy()
    blobId = res.blobId
    blobObjectId = res.blobObjectId

    const readBack = await aggregatorRead(blobId)
    expect(Array.from(readBack)).toEqual(Array.from(payload))
  })

  it('is content-addressed: re-uploading the same bytes yields the same blobId', async () => {
    const again = await uploadImageBytesWithRetry(client, payload, signer, { epochs: 3 })
    expect(again.blobId).toBe(blobId)
  })

  it('extends the blob lifetime (endEpoch increases)', async () => {
    const before = await fetchOwnedWalrusBlobs(localnetSuiClient(), client, localnetAddress())
    const mineBefore = before.find((b) => b.objectId === blobObjectId)
    expect(mineBefore, 'uploaded blob should be owned').toBeDefined()

    const { digest } = await extendBlobLifetime(client, blobObjectId, signer, { epochs: 2 })
    expect(digest).toBeTruthy()

    const after = await fetchOwnedWalrusBlobs(localnetSuiClient(), client, localnetAddress())
    const mineAfter = after.find((b) => b.objectId === blobObjectId)
    expect(mineAfter).toBeDefined()
    expect(mineAfter!.endEpoch).toBeGreaterThan(mineBefore!.endEpoch)
  })

  it('writes and reads back on-chain blob attributes; null deletes', async () => {
    await setBlobAttributes(client, blobObjectId, signer, { label: 'integration', kind: 'raw' })
    let attrs = await readBlobAttributes(client, blobObjectId)
    expect(attrs).toMatchObject({ label: 'integration', kind: 'raw' })

    await setBlobAttributes(client, blobObjectId, signer, { kind: null })
    attrs = await readBlobAttributes(client, blobObjectId)
    expect(attrs?.kind).toBeUndefined()
    expect(attrs?.label).toBe('integration')
  })

  it('lists the certified blob among the address\'s owned blobs', async () => {
    const owned = await fetchOwnedWalrusBlobs(localnetSuiClient(), client, localnetAddress())
    const mine = owned.find((b) => b.objectId === blobObjectId)
    expect(mine).toBeDefined()
    expect(mine!.blobId).toBe(blobId)
    expect(mine!.certified).toBe(true)
  })
})
