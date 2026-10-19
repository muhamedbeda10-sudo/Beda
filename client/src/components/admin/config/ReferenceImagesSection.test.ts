import { describe, expect, it } from 'vitest'
import { nextUploadCount } from '@/components/inspection/imageUploads'
import { referenceImageProblem } from './ReferenceImagesSection'

const entry = { itemCode: 'LM-2040', item: '', workCenterCode: '', caption: '', imageId: 'img-old' }

describe('saving a reference image', () => {
  it('waits for both of two photos taken back to back, not just the first to finish', () => {
    let uploads = nextUploadCount(nextUploadCount(0, true), true)
    expect(referenceImageProblem(entry, uploads)).toBe('Wait for the image to finish uploading.')
    uploads = nextUploadCount(uploads, false)
    // One is stored, the other still on its way: the entry would be saved with the image before it.
    expect(referenceImageProblem(entry, uploads)).toBe('Wait for the image to finish uploading.')
    uploads = nextUploadCount(uploads, false)
    expect(referenceImageProblem(entry, uploads)).toBeNull()
  })

  it('still asks for an item code and an image', () => {
    expect(referenceImageProblem({ ...entry, imageId: '' }, 0)).toBe('Choose a reference image.')
    expect(referenceImageProblem({ ...entry, itemCode: ' ' }, 0)).not.toBeNull()
  })
})
