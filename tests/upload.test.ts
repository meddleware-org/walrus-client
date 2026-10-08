import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the args WalrusFile.from receives, and stub writeFilesFlow.
const walrusFileFrom = vi.fn((x: unknown) => ({ __file: x }))
vi.mock('@mysten/walrus', () => ({
  WalrusFile: { from: (x: unknown) => walrusFileFrom(x) },
}))

// node:fs/promises readFile stub for uploadLocalFile.
const readFileMock = vi.fn(async (_path: unknown) => Buffer.from('local-bytes'))
vi.mock('node:fs/promises', () => ({ readFile: (...a: unknown[]) => readFileMock(a[0]) }))

import {
  uploadBytes,
  uploadLocalFile,
  uploadImageBytes,
  createBlobUploadFlow,
  maxEpochsAhead,
  createUploadFlow,
  LONG_TERM_EPOCHS,
  MAX_SINGLE_RESERVATION_EPOCHS,
} from '../src/upload.js'

// Minimal fake WalrusClient capturing the writeFiles/writeFilesFlow calls.
function fakeClient() {
  const calls: { writeFiles: any[]; writeFilesFlow: any[] } = { writeFiles: [], writeFilesFlow: [] }
  const client = {
    walrus: {
      writeFiles: vi.fn(async (arg: any) => {
        calls.writeFiles.push(arg)
        return [{ blobId: 'BLOB', id: 'OBJ' }]
      }),
      writeBlob: vi.fn(async (arg: any) => ({ blobId: 'RAW', blobObject: { id: 'RAWOBJ' }, arg })),
      writeBlobFlow: vi.fn((arg: any) => ({ __blobFlow: arg })),
      systemState: vi.fn(async () => ({ max_epochs_ahead: 60 })),
      writeFilesFlow: vi.fn((arg: any) => {
        calls.writeFilesFlow.push(arg)
        return { __flow: true }
      }),
    },
  }
  return { client: client as any, calls }
}

const signer = { __signer: true } as any

beforeEach(() => {
  walrusFileFrom.mockClear()
  readFileMock.mockClear()
})

describe('uploadBytes', () => {
  it('applies safe defaults: epochs=MAX_SINGLE_RESERVATION_EPOCHS, deletable=false', async () => {
    const { client, calls } = fakeClient()
    const res = await uploadBytes(client, new Uint8Array([1, 2, 3]), 'id-1', signer)
    // Default must be a value Walrus actually accepts in one reservation; the
    // LONG_TERM target (200) exceeds max_epochs_ahead and is reached via renewal.
    expect(calls.writeFiles[0].epochs).toBe(60) // the live max_epochs_ahead from the system state
    expect(MAX_SINGLE_RESERVATION_EPOCHS).toBe(53)
    expect(LONG_TERM_EPOCHS).toBe(200)
    expect(calls.writeFiles[0].deletable).toBe(false)
    expect(calls.writeFiles[0].signer).toBe(signer)
    // UploadResult maps blobId + object id.
    expect(res).toEqual({ blobId: 'BLOB', blobObjectId: 'OBJ' })
  })

  it('passes options through (epochs, deletable, tags)', async () => {
    const { client, calls } = fakeClient()
    await uploadBytes(client, new Uint8Array([9]), 'id-2', signer, {
      epochs: 5,
      deletable: true,
      tags: { kind: 'icon' },
    })
    expect(calls.writeFiles[0].epochs).toBe(5)
    expect(calls.writeFiles[0].deletable).toBe(true)
    // tags are threaded into WalrusFile.from
    expect(walrusFileFrom).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'id-2', tags: { kind: 'icon' } }),
    )
  })
})

describe('uploadLocalFile', () => {
  it('reads the file then delegates to uploadBytes (defaults preserved)', async () => {
    const { client, calls } = fakeClient()
    const res = await uploadLocalFile(client, '/tmp/icon.png', 'id-3', signer)
    expect(readFileMock).toHaveBeenCalledWith('/tmp/icon.png')
    expect(calls.writeFiles[0].deletable).toBe(false)
    expect(calls.writeFiles[0].epochs).toBe(60)
    expect(res).toEqual({ blobId: 'BLOB', blobObjectId: 'OBJ' })
  })
})

describe('epochs validation (before any wallet prompt or gas)', () => {
  it('rejects 0, negatives, fractions, NaN and values above the live maximum', async () => {
    const { client } = fakeClient()
    for (const epochs of [0, -3, 2.5, Number.NaN, 61]) {
      await expect(uploadBytes(client, new Uint8Array([1]), 'x', signer, { epochs })).rejects.toThrow(/epochs must be/)
    }
    expect(client.walrus.writeFiles).not.toHaveBeenCalled()
  })

  it('falls back to 53 when the system state cannot be read', async () => {
    const { client } = fakeClient()
    client.walrus.systemState.mockRejectedValue(new Error('rpc down'))
    expect(await maxEpochsAhead(client)).toBe(MAX_SINGLE_RESERVATION_EPOCHS)
    client.walrus.systemState.mockResolvedValue({ max_epochs_ahead: 'x' })
    expect(await maxEpochsAhead(client)).toBe(MAX_SINGLE_RESERVATION_EPOCHS)
  })
})

describe('raw blob uploads', () => {
  it('uploadImageBytes writes a raw blob with safe defaults and maps the ids', async () => {
    const { client } = fakeClient()
    const res = await uploadImageBytes(client, new Uint8Array([1]), signer)
    expect(res).toEqual({ blobId: 'RAW', blobObjectId: 'RAWOBJ' })
    expect(client.walrus.writeBlob).toHaveBeenCalledWith(expect.objectContaining({ deletable: false, epochs: 60 }))
    await expect(uploadImageBytes(client, new Uint8Array([1]), signer, { epochs: 0 })).rejects.toThrow(/epochs/)
  })

  it('createBlobUploadFlow returns the SDK flow without signing', () => {
    const { client } = fakeClient()
    expect(createBlobUploadFlow(client, new Uint8Array([2]))).toEqual({ __blobFlow: { blob: new Uint8Array([2]) } })
  })
})

describe('createUploadFlow', () => {
  it('returns a writeFilesFlow object without signing (wallet-safe)', () => {
    const { client, calls } = fakeClient()
    const flow = createUploadFlow(client, new Uint8Array([7]), 'id-4', { tags: { a: 'b' } })
    expect(calls.writeFilesFlow.length).toBe(1)
    expect(flow).toEqual({ __flow: true })
    // no signer is involved in the browser flow
    expect(client.walrus.writeFiles).not.toHaveBeenCalled()
  })
})
