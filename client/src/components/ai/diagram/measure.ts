// ============================================================================
// §20 — how wide a diagram's words are, so its boxes fit them: measured on a
// canvas in the typeface the answer is written in (Inter, and IBM Plex Sans
// Arabic for Arabic letters), each text once. Where there is no canvas (a
// test, a server render) it is estimated from the characters, generously.
// ============================================================================

import type { Measure } from './layout'

/** The answer's typefaces (.ai-type in index.css). */
export const DIAGRAM_FONT_FAMILY = "Inter, 'IBM Plex Sans Arabic', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/** A measured width is padded by this share: a typeface still loading is drawn a little wider when it arrives. */
const SLACK = 1.04

/** An estimate where nothing can be measured: about half the size per character, more for a bold one. */
export const estimateMeasure: Measure = (text, size, weight) => Array.from(text).length * size * (weight >= 600 ? 0.58 : 0.54)

/** Widths measured on a canvas in the answer's typefaces; the estimate where there is no canvas. */
export function canvasMeasure(family = DIAGRAM_FONT_FAMILY): Measure {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ctx) return estimateMeasure
  const known = new Map<string, number>()
  return (text, size, weight) => {
    const key = `${weight}|${size}|${text}`
    const hit = known.get(key)
    if (hit !== undefined) return hit
    ctx.font = `${weight} ${size}px ${family}`
    const width = ctx.measureText(text).width * SLACK
    // A canvas that measures nothing (jsdom's) is no measure.
    const out = width > 0 || text === '' ? width : estimateMeasure(text, size, weight)
    known.set(key, out)
    return out
  }
}
