// ============================================================================
// §20 — a query's result shaped for a chart. The model asks for a chart with
// the query (`AiQueryPart.chart`: a type, the x column, one to four y
// columns, and perhaps a column to split by); the server has checked the
// columns are there. Here the rows become what the dashboard's charts draw:
// categories along x, and a series per y column — or, with `series`, one per
// value of that column (a long result turned wide). What cannot be drawn
// honestly is not drawn: the table below it says it all anyway.
// ============================================================================

import type { AiCell, AiChartSpec, AiChartType, AiQueryPart } from '@qc/shared/ai'
import { monthLabel, shortDay } from '@/components/dashboard/period'
import { cellNumber, cellText } from './tables'

/** The most series one chart draws; beyond it, the largest are drawn and the figure says so. */
export const AI_CHART_MAX_SERIES = 8
/** The most y columns a chart takes, as the tool allows. */
export const AI_CHART_MAX_Y = 4
/** A pie takes at most this many slices; with more, it is drawn as bars. */
export const AI_PIE_MAX_SLICES = 8
/** The most categories bars are drawn for; more would be slivers. */
export const AI_BAR_MAX_CATEGORIES = 60

export interface ChartSeries {
  label: string
  /** One per category; null where the result has no value (a gap in a line, nothing on a bar). */
  values: (number | null)[]
}

export interface ChartModel {
  /** What is drawn: a pie of too many slices is drawn as bars. */
  type: AiChartType
  title?: string
  /** The x column's values, in the order the query returned them, as shown. */
  labels: string[]
  series: ChartSeries[]
  /** '%' when the figures are percentages (by the y column's name), else ''. */
  unit: string
  /** Series left out (the smallest), when there were more than a chart draws. */
  omitted: number
  /** The y column the values come from, when one column is split into series (for the legend's heading). */
  measure?: string
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/
const YM = /^(\d{4})-(\d{2})$/

/**
 * The x values as labels: days as "Sep 8" (with the year when the days span
 * more than one), months as "Sep" or "Sep 2026", anything else as written.
 */
export function chartLabels(values: readonly AiCell[]): string[] {
  const texts = values.map((v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : cellText(v).trim()))
  const known = texts.filter((t) => t !== '')
  if (known.length > 0 && known.every((t) => YMD.test(t))) {
    const years = new Set(known.map((t) => t.slice(0, 4)))
    return texts.map((t) => {
      if (!t) return '(blank)'
      const day = t.slice(0, 10)
      return years.size > 1 ? `${shortDay(day)}, ${day.slice(0, 4)}` : shortDay(day)
    })
  }
  if (known.length > 0 && known.every((t) => YM.test(t) && Number(t.slice(5)) >= 1 && Number(t.slice(5)) <= 12)) {
    const years = new Set(known.map((t) => t.slice(0, 4)))
    return texts.map((t) => (t ? monthLabel(t, years.size > 1) : '(blank)'))
  }
  return texts.map((t) => t || '(blank)')
}

/** Labels made unique (the charts key their marks by label): a repeat gets " (2)", " (3)"… */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  return labels.map((l) => {
    let label = l
    for (let k = 2; seen.has(label); k++) label = `${l} (${k})`
    seen.add(label)
    return label
  })
}

/** A column's name as a legend shows it: "defect_pieces" as "defect pieces". */
export const humanizeColumn = (name: string): string => name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || name

/** Percentages by name: "reject_rate_pct", "share %", "Defect percent". */
const isPercentName = (name: string) => /%|٪|pct|percent/i.test(name)

/**
 * The chart a query asked for, shaped for drawing, or null when it cannot be
 * drawn honestly: a column it names is missing, a value is not a number, a
 * figure is below zero (the dashboard's charts stand on zero), there is
 * nothing to draw, or there are more categories than bars can show.
 */
export function shapeChart(spec: AiChartSpec | undefined, columns: readonly string[], rows: readonly (readonly AiCell[])[]): ChartModel | null {
  if (!spec || rows.length === 0) return null
  const xi = columns.indexOf(spec.x)
  const ys = [...new Set(spec.y)].slice(0, AI_CHART_MAX_Y).map((y) => columns.indexOf(y))
  if (xi < 0 || ys.length === 0 || ys.some((i) => i < 0)) return null
  const si = spec.series ? columns.indexOf(spec.series) : -1
  if (spec.series && si < 0) return null

  // Every value read once: a value that is not a number means the column is not one.
  const num = (v: AiCell | undefined): number | null | undefined => (v === null || v === undefined ? null : (cellNumber(v) ?? undefined))

  // The categories in the order the query returned them; a category met again adds to its own (a total per category).
  const order: string[] = []
  const at = new Map<string, number>()
  const keyOf = (v: AiCell | undefined) => (v === null || v === undefined ? '\u0000null' : typeof v === 'string' ? v : JSON.stringify(v))
  const xValues: AiCell[] = []
  const category = (v: AiCell | undefined): number => {
    const key = keyOf(v)
    let i = at.get(key)
    if (i === undefined) {
      i = order.length
      at.set(key, i)
      order.push(key)
      xValues.push(v ?? null)
    }
    return i
  }

  let series: { label: string; sums: (number | null)[] }[]
  if (si >= 0) {
    // Long to wide: one series per value of the split column, of the first y column.
    const yi = ys[0]
    const bySeries = new Map<string, { label: string; sums: (number | null)[] }>()
    for (const r of rows) {
      const c = category(r[xi])
      const v = num(r[yi])
      if (v === undefined) return null
      const name = r[si] === null || r[si] === undefined ? '(blank)' : cellText(r[si]).trim() || '(blank)'
      let s = bySeries.get(name)
      if (!s) bySeries.set(name, (s = { label: name, sums: [] }))
      if (v !== null) s.sums[c] = (s.sums[c] ?? 0) + v
    }
    series = [...bySeries.values()]
  } else {
    const names = uniqueLabels(ys.map((yi) => humanizeColumn(columns[yi])))
    series = ys.map((yi, k) => ({ label: names[k], sums: [] as (number | null)[] }))
    for (const r of rows) {
      const c = category(r[xi])
      for (let k = 0; k < ys.length; k++) {
        const v = num(r[ys[k]])
        if (v === undefined) return null
        if (v !== null) series[k].sums[c] = (series[k].sums[c] ?? 0) + v
      }
    }
  }

  const n = order.length
  const values = series.map((s) => ({ label: s.label, values: Array.from({ length: n }, (_, i) => s.sums[i] ?? null) }))
  const all = values.flatMap((s) => s.values).filter((v): v is number => v !== null)
  if (all.length === 0 || all.some((v) => v < 0)) return null

  // The largest series first when one column is split; the y columns keep the order asked for.
  const total = (s: ChartSeries) => s.values.reduce<number>((t, v) => t + (v ?? 0), 0)
  const ranked = si >= 0 ? [...values].sort((a, b) => total(b) - total(a)) : values
  const kept = ranked.slice(0, AI_CHART_MAX_SERIES)
  const omitted = ranked.length - kept.length

  let type = spec.type
  if (type === 'pie' && (kept.length > 1 || n > AI_PIE_MAX_SLICES)) type = 'bar'
  // Bars and slices of nothing draw nothing; a line along zero still says something.
  const drawable = kept.flatMap((s) => s.values).some((v) => v !== null && v > 0)
  if (type !== 'line' && type !== 'area' && !drawable) return null
  if ((type === 'bar' || type === 'stacked-bar') && n > AI_BAR_MAX_CATEGORIES) return null

  const yNames = si >= 0 ? [columns[ys[0]]] : ys.map((i) => columns[i])
  return {
    type,
    ...(spec.title?.trim() ? { title: spec.title.trim() } : {}),
    labels: uniqueLabels(chartLabels(xValues)),
    series: kept,
    unit: yNames.every(isPercentName) ? '%' : '',
    omitted,
    ...(si >= 0 ? { measure: humanizeColumn(columns[ys[0]]) } : {}),
  }
}

/** A query's chart, when it asked for one and its result can be drawn. */
export function queryChart(part: AiQueryPart): ChartModel | null {
  if (!part.ok || !part.chart) return null
  return shapeChart(part.chart, part.columns, part.rows)
}
