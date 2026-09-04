// ============================================================================
// §10 — image handling on the device.
//
// A phone photo is validated (by magic bytes, never by extension), downscaled,
// re-encoded as JPEG, thumbnailed and hashed here, before a single byte leaves
// the device. The API re-checks the bytes and the hash on arrival, and stores
// them in Azure Blob Storage (or on disk in development).
// ============================================================================


/** Maximum accepted upload before compression. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** Long-edge target after on-device compression (§10.1). */
export const COMPRESS_LONG_EDGE = 1600
export const THUMBNAIL_LONG_EDGE = 240

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageRejected'
  }
}

// ---- Content sniffing ------------------------------------------------------

/** Detect the real type from magic bytes — never trust the file extension. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp'
  // HEIC/HEIF: 'ftyp' box at offset 4
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (['heic', 'heix', 'hevc', 'mif1', 'heim'].includes(brand)) return 'image/heic'
  }
  return null
}

// ---- Hashing ---------------------------------------------------------------

/** SHA-256 of the stored bytes. Not optional — it is what proves years later
 *  that a photo is the file that was originally uploaded (§10). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---- Compression -----------------------------------------------------------

export interface PreparedImage {
  blob: Blob
  mimeType: string
  width: number
  height: number
  byteSize: number
  sha256: string
  thumbnailDataUrl: string
  originalFilename: string
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new ImageRejected('The file could not be decoded as an image.'))
    img.src = src
  })
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new ImageRejected('The file could not be read.'))
    r.readAsDataURL(blob)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new ImageRejected('Image encoding failed.'))),
      type,
      quality,
    )
  })
}

function drawScaled(img: HTMLImageElement, longEdge: number): HTMLCanvasElement {
  let { naturalWidth: w, naturalHeight: h } = img
  if (w > longEdge || h > longEdge) {
    const scale = longEdge / Math.max(w, h)
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageRejected('Canvas is unavailable in this browser.')
  ctx.drawImage(img, 0, 0, w, h)
  return canvas
}

/**
 * Validate, compress and hash a picked file, entirely on the device.
 * A multi-megabyte phone photo is never sent raw (§10.1).
 */
export async function prepareImage(file: File, quality = 0.72): Promise<PreparedImage> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ImageRejected(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    )
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const sniffed = sniffImageMime(head)
  if (!sniffed) {
    throw new ImageRejected('That file is not an image. Only JPEG, PNG, GIF, WebP and HEIC are accepted.')
  }

  const dataUrl = await readAsDataUrl(file)
  const img = await loadImage(dataUrl)

  const canvas = drawScaled(img, COMPRESS_LONG_EDGE)
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  const thumbCanvas = drawScaled(img, THUMBNAIL_LONG_EDGE)
  const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.6)

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const hash = await sha256Hex(bytes)

  return {
    blob,
    mimeType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height,
    byteSize: blob.size,
    sha256: hash,
    thumbnailDataUrl,
    originalFilename: file.name || 'photo.jpg',
  }
}
