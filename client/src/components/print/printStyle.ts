// ============================================================================
// A report style (shared/src/reportStyles.ts) as the printed sheet reads it:
// its colours as CSS custom properties on the sheet (index.css draws the
// rule, the section numbers, the figures and the tables from them), its
// typeface as a font stack that holds on any device (Arabic always in IBM
// Plex Sans Arabic, which the app ships), and its choices as data attributes
// the stylesheet keys on. Every value comes from a checked style — a #RRGGBB
// colour, a typeface from the list — so nothing written here can carry CSS
// of its own.
// ============================================================================

import type { CSSProperties } from 'react'
import { BUILTIN_RESOLVED_STYLE, isHexColor, type ReportStyleFont, type ReportStyleOrientation, type ReportStyleSpec, type ResolvedReportStyle } from '@qc/shared/reportStyles'

/** The width a sheet is laid out at before it prints: A4 less the page's margins (12 mm each side). */
export const PRINT_WIDTH: Record<ReportStyleOrientation, string> = { portrait: '186mm', landscape: '273mm' }

const ARABIC = "'IBM Plex Sans Arabic'"

/** Each typeface with the look-alikes a device without it has (Carlito and Caladea are metric twins of Calibri and Cambria). */
const FONT_STACK: Record<ReportStyleFont, string> = {
  Inter: `Inter, ${ARABIC}, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`,
  Arial: `Arial, 'Liberation Sans', Helvetica, ${ARABIC}, sans-serif`,
  Calibri: `Calibri, Carlito, 'Segoe UI', ${ARABIC}, sans-serif`,
  Cambria: `Cambria, Caladea, Georgia, ${ARABIC}, serif`,
  'Times New Roman': `'Times New Roman', 'Liberation Serif', Times, ${ARABIC}, serif`,
}

export const fontStack = (font: ReportStyleFont): string => FONT_STACK[font] ?? FONT_STACK.Inter

/** A colour of the style, or the built-in's when it is not one (a style from an older app). */
const colour = (value: string, fallback: string) => (isHexColor(value) ? value : fallback)

/** The sheet's custom properties and typeface. */
export function sheetStyle(spec: ReportStyleSpec): CSSProperties {
  const c = spec.colors
  const b = BUILTIN_RESOLVED_STYLE.spec.colors
  return {
    '--ps-primary': colour(c.primary, b.primary),
    '--ps-accent': colour(c.accent, b.accent),
    '--ps-heading': colour(c.heading, b.heading),
    '--ps-text': colour(c.text, b.text),
    '--ps-th-bg': colour(c.tableHeaderBg, b.tableHeaderBg),
    '--ps-th-text': colour(c.tableHeaderText, b.tableHeaderText),
    '--ps-stripe': colour(c.tableStripe, b.tableStripe),
    '--ps-border': colour(c.tableBorder, b.tableBorder),
    fontFamily: fontStack(spec.font),
  } as CSSProperties
}

/** The choices the stylesheet keys on, as data attributes of the sheet. */
export function sheetAttributes(spec: ReportStyleSpec): Record<string, string> {
  return {
    'data-rule': spec.header.rule,
    'data-borders': spec.table.borders,
    'data-stripes': String(spec.table.stripes),
    'data-compact': String(spec.table.compact),
    'data-figures': spec.figures,
    'data-numbering': String(spec.numbering),
  }
}

/** The style a print is drawn in: the one given, else the built-in look. */
export const printStyleOf = (style: ResolvedReportStyle | null | undefined): ResolvedReportStyle => style ?? BUILTIN_RESOLVED_STYLE
