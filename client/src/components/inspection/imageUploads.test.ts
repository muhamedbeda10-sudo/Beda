import { describe, expect, it } from 'vitest'
import type { ImageAsset } from '@qc/shared/types'
import { SAVED_AND_CLOSED, appendIds, intakeRefusal, nextUploadCount, putBackId, removeId, uploadEach, type ImageIdsEdit } from './imageUploads'

/** The record's list, changed the way React applies a functional update: to the list as it stands. */
function record(initial: string[]) {
  let ids = initial
  return {
    apply: (edit: ImageIdsEdit) => {
      ids = edit(ids)
    },
    get ids() {
      return ids
    },
  }
}

/** An upload the test lets finish when it chooses. */
function slowUploads() {
  const waiting = new Map<string, (asset: ImageAsset) => void>()
  const upload = (file: File) => new Promise<ImageAsset>((resolve) => waiting.set(file.name, resolve))
  const finish = async (name: string) => {
    waiting.get(name)?.({ id: `img-${name}` } as ImageAsset)
    // Let the picker's await carry on.
    await new Promise((r) => setTimeout(r, 0))
  }
  return { upload, finish }
}

const photo = (name: string) => ({ name }) as File

describe('photos added while others upload', () => {
  it('keeps both of two photos taken one after another, whichever is stored first', async () => {
    const list = record(['img-old'])
    const { upload, finish } = slowUploads()
    const first = uploadEach([photo('a')], upload, (asset) => list.apply(appendIds([asset.id])), () => undefined)
    const second = uploadEach([photo('b')], upload, (asset) => list.apply(appendIds([asset.id])), () => undefined)
    await finish('b')
    await finish('a')
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(list.ids).toEqual(['img-old', 'img-b', 'img-a'])
  })

  it('does not bring back a photo removed while another was uploading', async () => {
    const list = record(['img-old', 'img-keep'])
    const { upload, finish } = slowUploads()
    const batch = uploadEach([photo('new')], upload, (asset) => list.apply(appendIds([asset.id])), () => undefined)
    list.apply(removeId('img-old'))
    await finish('new')
    await batch
    expect(list.ids).toEqual(['img-keep', 'img-new'])
  })

  it('stores the rest of a batch when one file is refused, and says which', async () => {
    const list = record([])
    const refused: string[] = []
    const stored = await uploadEach(
      [photo('a'), photo('huge'), photo('c')],
      async (file) => (file.name === 'huge' ? Promise.reject(new Error('too big')) : ({ id: `img-${file.name}` } as ImageAsset)),
      (asset) => list.apply(appendIds([asset.id])),
      (file) => refused.push(file.name),
    )
    expect(stored).toBe(2)
    expect(list.ids).toEqual(['img-a', 'img-c'])
    expect(refused).toEqual(['huge'])
  })

  it('adds a photo once, and puts a removed one back where it stood', () => {
    expect(appendIds(['x', 'x'])(['x'])).toEqual(['x'])
    expect(putBackId('b', 1)(['a', 'c'])).toEqual(['a', 'b', 'c'])
    expect(putBackId('b', 1)(['a', 'b'])).toEqual(['a', 'b'])
    expect(removeId('z')(['a'])).toEqual(['a'])
  })
})

describe('photos picked while the record is being saved, or after', () => {
  const saving = 'The sample is being saved: photos can be added again if the save does not go through.'

  it('are refused with the reason while it is being saved, rather than landing after it was written', () => {
    expect(intakeRefusal(saving, true)).toBe(saving)
  })

  it('are refused once the record is saved and its screen gone, rather than said to be added', () => {
    expect(intakeRefusal(undefined, false)).toBe(SAVED_AND_CLOSED)
    expect(intakeRefusal(saving, false)).toBe(SAVED_AND_CLOSED)
  })

  it('are taken otherwise', () => {
    expect(intakeRefusal(undefined, true)).toBeNull()
  })
})

describe('uploads counted for a record’s Save', () => {
  it('holds while any of two overlapping uploads is still running', () => {
    let n = 0
    n = nextUploadCount(n, true) // the first photo
    n = nextUploadCount(n, true) // the second, before the first is stored
    n = nextUploadCount(n, false) // the first is stored
    expect(n).toBe(1)
    n = nextUploadCount(n, false)
    expect(n).toBe(0)
    // Never below nought, whatever order the ends arrive in.
    expect(nextUploadCount(0, false)).toBe(0)
  })
})
