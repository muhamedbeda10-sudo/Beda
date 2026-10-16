// ============================================================================
// §20 — a chart as an image, saved on the device (lib/imageExport): its title
// above it, drawn light whatever the theme, at a width a slide or a report
// takes (CHART_IMAGE_WIDTH), at twice its size.
//
// The chart is drawn again off the screen at that width (./AiChart, as on
// screen), then written out as one SVG: its own SVG drawings as they are,
// each mark's colours and type read from the page and written on it; and the
// words around them (its title, legend, figures) as SVG text where the page
// laid them out, line by line, with the backgrounds and borders of the boxes
// they sit in. No HTML goes into the image (no foreignObject), so every
// browser can make a PNG of it, a phone's among them.
// ============================================================================

import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ImageDown, Loader2 } from 'lucide-react'
import { useApp } from '@/store/AppContext'
import { embeddedFaces, imageFileName, saveImageFile, svgToPng, withFaces } from '@/lib/imageExport'
import { AiChart } from './AiChart'
import { TableTool } from './AiTable'
import type { ChartModel } from './chartData'
import { textDirection } from './tables'

/** The width a chart is drawn at for its image: a slide's or a report's. */
export const CHART_IMAGE_WIDTH = 960
/** The white margin around it. */
const PAD = 24

const SVG_NS = 'http://www.w3.org/2000/svg'
/** What is read from the page onto each mark of a chart's own drawing. */
const MARK_STYLE = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
] as const

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => String(Math.round(n * 100) / 100)

/** A colour the page left transparent: nothing to draw. */
const clear = (c: string) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)

function shown(el: Element): boolean {
  const s = getComputedStyle(el)
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
}

/** A chart's own drawing, its marks' colours and type written on them, as an SVG placed where it is in the frame. */
function drawingAt(svg: SVGSVGElement, origin: DOMRect): string {
  const box = svg.getBoundingClientRect()
  const copy = svg.cloneNode(true) as SVGSVGElement
  const from = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const to = [copy, ...Array.from(copy.querySelectorAll('*'))]
  from.forEach((el, i) => {
    const out = to[i] as Element
    out.removeAttribute('class')
    if (!shown(el)) {
      out.setAttribute('display', 'none')
      return
    }
    const s = getComputedStyle(el)
    const style = MARK_STYLE.map((p) => `${p}:${s.getPropertyValue(p)}`).join(';')
    out.setAttribute('style', style)
  })
  copy.setAttribute('x', num(box.left - origin.left))
  copy.setAttribute('y', num(box.top - origin.top))
  copy.setAttribute('width', num(box.width))
  copy.setAttribute('height', num(box.height))
  copy.removeAttribute('role')
  return new XMLSerializer().serializeToString(copy)
}

/** A box's background and border, where it is in the frame. */
function boxAt(el: HTMLElement, origin: DOMRect): string {
  const s = getComputedStyle(el)
  const fill = clear(s.backgroundColor) ? 'none' : s.backgroundColor
  const width = parseFloat(s.borderTopWidth) || 0
  const stroke = width > 0 && !clear(s.borderTopColor) && s.borderTopStyle !== 'none' ? s.borderTopColor : 'none'
  if (fill === 'none' && stroke === 'none') return ''
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return ''
  const radius = parseFloat(s.borderTopLeftRadius) || 0
  return `<rect x="${num(r.left - origin.left + width / 2)}" y="${num(r.top - origin.top + width / 2)}" width="${num(r.width - width)}" height="${num(r.height - width)}" rx="${num(radius)}" fill="${fill}" stroke="${stroke}" stroke-width="${num(width)}"/>`
}

/** The lines a piece of text was laid out on: each its words and where it sits. */
function textLines(node: Text): { text: string; left: number; right: number; middle: number }[] {
  const value = node.data
  const range = document.createRange()
  const lines: { text: string; left: number; right: number; top: number; bottom: number }[] = []
  for (let i = 0; i < value.length; i++) {
    range.setStart(node, i)
    range.setEnd(node, i + 1)
    const r = range.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    // A line's ends are its first and last letters: the spaces around them are where the words start, not the words.
    const blank = /\s/.test(value[i])
    const line = lines.find((l) => Math.abs(l.top - r.top) < 2)
    if (line) {
      line.text += value[i]
      if (!blank) {
        line.left = Math.min(line.left, r.left)
        line.right = Math.max(line.right, r.right)
      }
      line.bottom = Math.max(line.bottom, r.bottom)
    } else lines.push({ text: value[i], left: blank ? Infinity : r.left, right: blank ? -Infinity : r.right, top: r.top, bottom: r.bottom })
  }
  range.detach()
  return lines
    .filter((l) => l.text.trim() !== '' && Number.isFinite(l.left))
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), left: l.left, right: l.right, middle: (l.top + l.bottom) / 2 }))
}

/** The words of an element outside the chart's drawings, as SVG text where they were laid out. */
function wordsAt(node: Text, origin: DOMRect): string {
  const el = node.parentElement
  if (!el) return ''
  const s = getComputedStyle(el)
  const upper = s.textTransform === 'uppercase'
  const rtl = s.direction === 'rtl' || textDirection(node.data) === 'rtl'
  const font = `font-family:${s.fontFamily};font-size:${s.fontSize};font-weight:${s.fontWeight};letter-spacing:${s.letterSpacing === 'normal' ? '0' : s.letterSpacing}`
  return textLines(node)
    .map((l) => {
      const words = upper ? l.text.toUpperCase() : l.text
      const x = rtl ? l.right - origin.left : l.left - origin.left
      return `<text x="${num(x)}" y="${num(l.middle - origin.top)}" dominant-baseline="central" direction="${rtl ? 'rtl' : 'ltr'}" text-anchor="start" fill="${s.color}" style="${esc(font)}">${esc(words)}</text>`
    })
    .join('')
}

/** The frame as one SVG: boxes, words and drawings in the order the page paints them. */
export function frameSvg(frame: HTMLElement): { svg: string; width: number; height: number } {
  const origin = frame.getBoundingClientRect()
  const out: string[] = []
  const walk = (el: Element) => {
    if (!shown(el)) return
    if (el instanceof SVGSVGElement) {
      out.push(drawingAt(el, origin))
      return
    }
    if (el instanceof HTMLElement && el !== frame) out.push(boxAt(el, origin))
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out.push(wordsAt(child as Text, origin))
      else if (child.nodeType === Node.ELEMENT_NODE) walk(child as Element)
    }
  }
  walk(frame)
  const width = Math.ceil(origin.width)
  const height = Math.ceil(origin.height)
  const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/>${out.join('')}</svg>`
  return { svg, width, height }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** The chart drawn off the screen, light, at CHART_IMAGE_WIDTH, under its title; written out as SVG. */
async function chartSvg(model: ChartModel, title: string): Promise<{ svg: string; width: number; height: number }> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${CHART_IMAGE_WIDTH}px;background:#fff;`
  document.body.appendChild(host)
  const root = createRoot(host)
  const html = document.documentElement
  const dark = html.classList.contains('dark')
  try {
    flushSync(() =>
      root.render(
        <div className="ai-type bg-white text-slate-900" style={{ padding: PAD }}>
          {title && (
            <p dir={textDirection(title) ?? 'ltr'} className="mb-3 text-start text-lg font-bold leading-snug text-slate-900">
              {title}
            </p>
          )}
          <AiChart model={model} />
        </div>,
      ),
    )
    // Drawn at its width (the charts measure it), in its typefaces.
    await nextFrame()
    await nextFrame()
    await document.fonts?.ready.catch(() => undefined)
    // Read in the light theme, all at once: the page is not painted in between, so nothing on screen changes.
    if (dark) html.classList.remove('dark')
    try {
      return frameSvg(host.firstElementChild as HTMLElement)
    } finally {
      if (dark) html.classList.add('dark')
    }
  } finally {
    root.unmount()
    host.remove()
  }
}

/** The chart as a PNG, saved on the device under its title. */
export async function downloadChartImage(model: ChartModel, title: string): Promise<void> {
  const { svg, width, height } = await chartSvg(model, title)
  const png = await svgToPng(withFaces(svg, await embeddedFaces()), width, height)
  await saveImageFile(imageFileName(title, new Date(), 'png', 'Chart'), png)
}

/** Download image under a chart: the chart saved on the device as a PNG, under its title. */
export function ChartImageTool({ model, title, className }: { model: ChartModel; title: string; className?: string }) {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await downloadChartImage(model, title)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The chart could not be saved as an image. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className={className}>
      <TableTool onClick={() => void save()} disabled={busy} icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageDown className="h-3.5 w-3.5" />} tip="Save the chart on this device as an image (PNG)">
        Download image
      </TableTool>
    </span>
  )
}
