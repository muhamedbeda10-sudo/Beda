// ============================================================================
// §20 — a diagram as an image (PNG, for a message, a slide or a report),
// saved on the device (lib/imageExport: downloaded on a computer, "Save
// image" on a phone). It is the paper drawing — fixed light colours,
// whatever the theme — with the answer's own typefaces carried inside (the
// Latin and Arabic faces the page has loaded), so its words keep the size
// their boxes were made for. A face that cannot be read is left out; the
// image is still made, in the reader's own typeface.
// ============================================================================

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { embeddedFaces, imageFileName, saveImageFile, svgToPng, withFaces } from '@/lib/imageExport'
import { DiagramDrawing } from './DiagramDrawing'
import type { DiagramLayout } from './layout'

/** A file name a browser keeps: the title, then when. */
export function diagramFileName(title: string, at: Date, ext: 'svg' | 'png'): string {
  return imageFileName(title, at, ext, 'Diagram')
}

/** The paper drawing, as the text of an SVG file. */
function paperSvg(layout: DiagramLayout, title: string): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() => root.render(createElement(DiagramDrawing, { layout, title, paper: true })))
  const svg = host.innerHTML
  root.unmount()
  return svg
}

/** The SVG file's text: the paper drawing with its faces inside. */
export async function diagramSvgFile(layout: DiagramLayout, title: string): Promise<string> {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withFaces(paperSvg(layout, title), await embeddedFaces())}`
}

/** The diagram as a PNG at twice its size, on white, saved on the device. */
export async function downloadDiagramPng(layout: DiagramLayout, title: string): Promise<void> {
  const png = await svgToPng(await diagramSvgFile(layout, title), layout.width, layout.height)
  await saveImageFile(diagramFileName(title, new Date(), 'png'), png)
}
