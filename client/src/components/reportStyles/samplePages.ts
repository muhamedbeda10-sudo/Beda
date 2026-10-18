// ============================================================================
// A sample report as the assistant reads it, made on the device: a PDF's
// first pages drawn as pictures (pdf.js, loaded only when one is picked), or
// a photo of a report as it is, each at most SAMPLE_LONG_EDGE pixels on its
// long side, as JPEG — small enough to send, sharp enough to read. The logo
// is cut out of the first page where the assistant says it is, and a logo
// picked on its own is shrunk to what a style keeps (REPORT_STYLE_LOGO_MAX_CHARS).
// ============================================================================

import { REPORT_STYLE_LOGO_MAX_CHARS, REPORT_STYLE_SAMPLE_MAX_IMAGES, REPORT_STYLE_SAMPLE_MAX_CHARS } from '@qc/shared/reportStyles'

/** A sample page's long side, in pixels: a page's small print still reads. */
export const SAMPLE_LONG_EDGE = 1600
const SAMPLE_QUALITY = 0.82
/** A logo's long side, in pixels: sharp on paper at the largest size a style prints it. */
const LOGO_LONG_EDGE = 600

export class SampleError extends Error {}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new SampleError('This browser cannot draw pictures.')
  return { canvas, ctx }
}

/** A canvas on white (a PDF page or a transparent logo has none of its own), as a JPEG data URL. */
function jpeg(source: CanvasImageSource, width: number, height: number, quality = SAMPLE_QUALITY): string {
  const { canvas, ctx } = canvasOf(width, height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new SampleError('This picture could not be read. Use a PNG or JPEG.'))
    img.src = src
  })
}

const readAsDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new SampleError('The file could not be read.'))
    reader.readAsDataURL(file)
  })

/** The size a picture is drawn at so its long side is at most `edge`. */
const fit = (w: number, h: number, edge: number) => {
  const scale = Math.min(1, edge / Math.max(w, h))
  return { width: w * scale, height: h * scale }
}

async function pdfPages(file: File): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  try {
    const pages: string[] = []
    for (let n = 1; n <= Math.min(doc.numPages, REPORT_STYLE_SAMPLE_MAX_IMAGES); n++) {
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const { width } = fit(base.width, base.height, SAMPLE_LONG_EDGE)
      const viewport = page.getViewport({ scale: width / base.width })
      const { canvas, ctx } = canvasOf(viewport.width, viewport.height)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      pages.push(canvas.toDataURL('image/jpeg', SAMPLE_QUALITY))
      page.cleanup()
    }
    return pages
  } finally {
    void doc.destroy()
  }
}

async function photoPage(file: File): Promise<string> {
  const img = await loadImage(await readAsDataUrl(file))
  const { width, height } = fit(img.naturalWidth, img.naturalHeight, SAMPLE_LONG_EDGE)
  return jpeg(img, width, height)
}

/** A sample's pages as pictures: a PDF's first pages, or the photos picked (at most REPORT_STYLE_SAMPLE_MAX_IMAGES in all). */
export async function samplePages(files: readonly File[]): Promise<string[]> {
  const pages: string[] = []
  for (const file of files) {
    if (pages.length >= REPORT_STYLE_SAMPLE_MAX_IMAGES) break
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) pages.push(...(await pdfPages(file)))
    else if (file.type.startsWith('image/')) pages.push(await photoPage(file))
    else throw new SampleError(`“${file.name}” is not a PDF or a picture.`)
  }
  const kept = pages.slice(0, REPORT_STYLE_SAMPLE_MAX_IMAGES)
  if (kept.length === 0) throw new SampleError('Pick a PDF of a report, or photos of its pages.')
  if (kept.reduce((n, p) => n + p.length, 0) > REPORT_STYLE_SAMPLE_MAX_CHARS) throw new SampleError('The sample is too large to send: pick fewer pages.')
  return kept
}

/** A logo as a style keeps it: PNG (its transparency kept) when small enough, else JPEG on white; shrunk until it fits. */
async function logoFrom(source: CanvasImageSource, w: number, h: number): Promise<string> {
  let edge = LOGO_LONG_EDGE
  for (let attempt = 0; attempt < 6; attempt++, edge = Math.round(edge * 0.75)) {
    const { width, height } = fit(w, h, edge)
    const { canvas, ctx } = canvasOf(width, height)
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    const png = canvas.toDataURL('image/png')
    if (png.length <= REPORT_STYLE_LOGO_MAX_CHARS) return png
    const jpg = jpeg(source, width, height, 0.9)
    if (jpg.length <= REPORT_STYLE_LOGO_MAX_CHARS) return jpg
  }
  throw new SampleError('This logo is too detailed to keep. Use a simpler picture of it.')
}

/** A logo picked on its own. */
export async function logoFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new SampleError('A logo is a picture: PNG or JPEG.')
  const img = await loadImage(await readAsDataUrl(file))
  return logoFrom(img, img.naturalWidth, img.naturalHeight)
}

/** The logo cut out of a sample page where the assistant found it (fractions of the page), a little room kept around it. */
export async function logoFromPage(page: string, box: { x: number; y: number; w: number; h: number }): Promise<string> {
  const img = await loadImage(page)
  const pad = 0.006
  const x = Math.max(0, box.x - pad) * img.naturalWidth
  const y = Math.max(0, box.y - pad) * img.naturalHeight
  const w = Math.min(1 - Math.max(0, box.x - pad), box.w + 2 * pad) * img.naturalWidth
  const h = Math.min(1 - Math.max(0, box.y - pad), box.h + 2 * pad) * img.naturalHeight
  if (w < 8 || h < 8) throw new SampleError('The logo on the sample is too small to cut out.')
  const { canvas, ctx } = canvasOf(w, h)
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
  return logoFrom(canvas, w, h)
}
