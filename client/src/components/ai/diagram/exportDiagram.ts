// ============================================================================
// §20 — a diagram as a file: SVG (sharp at any size, opens in a browser,
// Word or PowerPoint) or PNG (an image for a message or a slide). Both are
// the paper drawing — fixed light colours, whatever the theme — with the
// answer's own typefaces carried inside the file (the Latin and Arabic faces
// the page has loaded), so its words keep the size their boxes were made for
// on a computer that does not have them. A face that cannot be read is left
// out; the file is still made, in the reader's own typeface.
// ============================================================================

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { saveBlob } from '@/lib/utils'
import { aiStamp } from '../exportAiResult'
import { DiagramDrawing } from './DiagramDrawing'
import type { DiagramLayout } from './layout'

/** A PNG is drawn at twice the diagram's size: sharp on a phone and on paper. */
const PNG_SCALE = 2
/** The faces carried: the answer's Latin and Arabic text, in the weights a diagram uses. */
const FACE_FILE = /(?:^|[/-])(?:inter-latin|ibm-plex-sans-arabic-arabic)-(?:400|600|700)-normal[^/]*\.woff2$/

/** A file name a browser keeps: the title, then when. */
export function diagramFileName(title: string, at: Date, ext: 'svg' | 'png'): string {
  const name = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'Diagram'
  return `${name} ${aiStamp(at.toISOString()).replace(':', '')}.${ext}`
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

/** The page's @font-face rules for the faces a diagram uses, with where each file is. */
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

/** The faces as @font-face rules with their files inside; empty when none can be read. */
async function embeddedFaces(): Promise<string> {
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

/** The SVG file's text: the paper drawing with its faces inside. */
export async function diagramSvgFile(layout: DiagramLayout, title: string): Promise<string> {
  const svg = paperSvg(layout, title)
  const faces = await embeddedFaces()
  const withFaces = faces ? svg.replace(/^<svg([^>]*)>/, `<svg$1><style>${faces}</style>`) : svg
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withFaces}`
}

export async function downloadDiagramSvg(layout: DiagramLayout, title: string): Promise<void> {
  const text = await diagramSvgFile(layout, title)
  saveBlob(diagramFileName(title, new Date(), 'svg'), new Blob([text], { type: 'image/svg+xml' }))
}

/** The SVG drawn on a canvas at twice its size, on white, as a PNG. */
export async function downloadDiagramPng(layout: DiagramLayout, title: string): Promise<void> {
  const text = await diagramSvgFile(layout, title)
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('The diagram could not be drawn as an image.'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(layout.width * PNG_SCALE)
    canvas.height = Math.ceil(layout.height * PNG_SCALE)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot make an image of the diagram. Download it as SVG instead.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('The image could not be made. Download the diagram as SVG instead.')
    saveBlob(diagramFileName(title, new Date(), 'png'), png)
  } finally {
    URL.revokeObjectURL(url)
  }
}
