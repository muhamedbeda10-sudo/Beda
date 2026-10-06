// ============================================================================
// A profile photo from any picture the device offers: the centre square,
// scaled to 192 px (sharp in a 36 px circle on a 3× screen, and in the 64 px
// one of the account panel), as a JPEG data URL small enough for the API.
// A photo from a phone camera keeps its orientation (EXIF is applied).
// ============================================================================

import { AVATAR_MAX_CHARS } from '@qc/shared/api'

const SIDE = 192
/** Tried in turn until the photo fits under the API's limit. */
const QUALITIES = [0.86, 0.75, 0.62, 0.5]

export async function avatarFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (JPEG, PNG, HEIC…).')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This picture could not be read. Try another one.')
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    const canvas = document.createElement('canvas')
    canvas.width = SIDE
    canvas.height = SIDE
    const g = canvas.getContext('2d')
    if (!g) throw new Error('This device cannot prepare the picture.')
    // A transparent PNG would turn black as a JPEG: paint it on white first.
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, SIDE, SIDE)
    g.imageSmoothingQuality = 'high'
    g.drawImage(bitmap, sx, sy, side, side, 0, 0, SIDE, SIDE)
    for (const q of QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', q)
      if (url.length <= AVATAR_MAX_CHARS) return url
    }
    throw new Error('This picture is too detailed to use. Try another one.')
  } finally {
    bitmap.close()
  }
}
