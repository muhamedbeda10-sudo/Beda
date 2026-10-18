// ============================================================================
// Pictures saved as files: a photo as it was taken, and the pictures the app
// makes (a chart, a diagram): an SVG drawn on a
// canvas, on white, at twice its size (sharp on a phone and on paper), as a
// PNG; with the page's own typefaces carried inside it (the Latin and Arabic
// faces it has loaded), so its words keep the size their boxes were made for.
//
// Saved as an image on the device, never opened in a tab: on a computer the
// browser downloads it; on a phone or a tablet the share sheet offers "Save
// image" (to the photos), as a download there would open it in the browser.
// ============================================================================

import { saveBlob } from './utils'

/** A picture is drawn at twice its size: sharp on a phone and on paper. */
export const PNG_SCALE = 2
/** The faces carried: the answer's Latin and Arabic text, in the weights its pictures use. */
const FACE_FILE = /(?:^|[/-])(?:inter-latin|ibm-plex-sans-arabic-arabic)-(?:400|500|600|700|800)-normal[^/]*\.woff2$/

/** A file's name from a title: the title (marks a file name cannot hold taken out), then when; `fallback` for an empty title. */
export function imageFileName(title: string, at: Date, ext: 'png' | 'svg', fallback = 'Chart'): string {
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || fallback
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${name} ${stamp}.${ext}`
}

const PHOTO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' }

/**
 * A photo's file name: the name it is known by (its own extension, and marks a file name cannot hold, taken out),
 * with the extension of what it is; "Photo" for none.
 */
export function photoFileName(name: string, mimeType: string): string {
  const base =
    name
      .replace(/\.(jpe?g|png|webp|heic|heif|gif)$/i, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'Photo'
  return `${base}.${PHOTO_EXT[mimeType.toLowerCase()] ?? 'jpg'}`
}

/** The page's @font-face rules for the faces carried, with where each file is. */
function faceRules(): { rule: CSSFontFaceRule; url: string }[] {
  const out: { rule: CSSFontFaceRule; url: string }[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // Another site's stylesheet: not ours to read.
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const src = rule.style.getPropertyValue('src')
      const url = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(src)?.[1]
      if (url && FACE_FILE.test(url.split('?')[0])) out.push({ rule, url: new URL(url, sheet.href ?? document.baseURI).href })
    }
  }
  return out
}

const toBase64 = (bytes: ArrayBuffer): string => {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The faces as @font-face rules with their files inside; empty when none can be read (the picture is still made, in the reader's typeface). */
export async function embeddedFaces(): Promise<string> {
  const faces = await Promise.all(
    faceRules().map(async ({ rule, url }) => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (!res.ok) return ''
        const data = toBase64(await res.arrayBuffer())
        const s = rule.style
        const range = s.getPropertyValue('unicode-range')
        return `@font-face{font-family:${s.getPropertyValue('font-family')};font-style:${s.getPropertyValue('font-style') || 'normal'};font-weight:${s.getPropertyValue('font-weight')};${range ? `unicode-range:${range};` : ''}src:url(data:font/woff2;base64,${data}) format('woff2');}`
      } catch {
        return ''
      }
    }),
  )
  return faces.filter(Boolean).join('')
}

/** An SVG file's text with the faces put inside it, after its opening tag. */
export function withFaces(svg: string, faces: string): string {
  return faces ? svg.replace(/^<svg([^>]*)>/, `<svg$1><style>${faces}</style>`) : svg
}

/** The SVG drawn on a canvas at `scale` times its size, on white, as a PNG. */
export async function svgToPng(svg: string, width: number, height: number, scale = PNG_SCALE): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('The picture could not be drawn as an image.'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot make an image of it.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('The image could not be made. Try again.')
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A phone or a tablet: a finger, and no mouse. */
export function onTouchDevice(): boolean {
  if (typeof matchMedia !== 'function') return false
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches
}

/**
 * An image saved on the device: on a phone or a tablet through the share sheet ("Save image" puts it with the
 * photos), else — or when the sheet cannot take it — downloaded as a file. Closing the sheet saves nothing.
 */
export async function saveImageFile(filename: string, blob: Blob): Promise<void> {
  if (onTouchDevice() && typeof navigator.share === 'function' && typeof File === 'function') {
    const file = new File([blob], filename, { type: blob.type || 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        // Not allowed here (the tap too long ago): downloaded instead.
      }
    }
  }
  saveBlob(filename, blob)
}
