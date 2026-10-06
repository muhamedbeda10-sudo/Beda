// ============================================================================
// A profile photo from any picture the device offers: the centre square,
// scaled to 192 px (sharp in a 36 px circle on a 3× screen, and in the 64 px
// one of the account panel), as a JPEG data URL small enough for the API —
// and a 64 px copy of it for the chat's circles, so its lists stay light.
// A photo from a phone camera keeps its orientation (EXIF is applied).
// ============================================================================

import { AVATAR_MAX_CHARS, AVATAR_THUMB_MAX_CHARS, type SetAvatarRequest } from '@qc/shared/api'

const SIDE = 192
const THUMB_SIDE = 64
/** Tried in turn until the photo fits under the API's limit. */
const QUALITIES = [0.86, 0.75, 0.62, 0.5]

/** The square drawn at `side` px and encoded at the best quality that fits `max` characters. */
function encode(bitmap: ImageBitmap, side: number, max: number): string {
  const crop = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - crop) / 2
  const sy = (bitmap.height - crop) / 2
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This device cannot prepare the picture.')
  // A transparent PNG would turn black as a JPEG: paint it on white first.
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, side, side)
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, sx, sy, crop, crop, 0, 0, side, side)
  for (const q of QUALITIES) {
    const url = canvas.toDataURL('image/jpeg', q)
    if (url.length <= max) return url
  }
  throw new Error('This picture is too detailed to use. Try another one.')
}

export async function avatarFromFile(file: File): Promise<SetAvatarRequest> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (JPEG, PNG, HEIC…).')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This picture could not be read. Try another one.')
  }
  try {
    return { dataUrl: encode(bitmap, SIDE, AVATAR_MAX_CHARS), thumbDataUrl: encode(bitmap, THUMB_SIDE, AVATAR_THUMB_MAX_CHARS) }
  } finally {
    bitmap.close()
  }
}
