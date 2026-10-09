// ============================================================================
// §20 — a query's result shaped for a chart. The model asks for a chart with
// the query (`AiQueryPart.chart`: a type, the x column, one to four y
// columns, and perhaps a column to split by); the server has checked it
// against the result (server/src/ai/charts.ts: the columns are there, y
// holds numbers, one row per point, at most eight series, and a pie of at
// most eight slices, none below zero) and its word is final: what it let
// through is drawn. Here the rows become what the dashboard's charts draw:
// categories along x, and a series per y column — or, with `series`, one per
// value of that column (a long result turned wide). Stacked bars with a
// figure below zero are drawn side by side instead: a stack cannot add up
// across zero. What cannot be drawn at all (a reply this client cannot
// read) is not drawn: the table under it says it all anyway.
// ============================================================================

import type { AiCell, AiChartSpec, AiChartType, AiQueryPart } from '@qc/shared/ai'
import { monthLabel, shortDay } from '@/components/dashboard/period'
import { cellNumber, cellText } from './tables'

/** The most series one chart draws (the server's limit too); beyond it, the largest are drawn and the figure says so. */
export const AI_CHART_MAX_SERIES = 8
/** The most y columns a chart takes, as the tool allows. */
export const AI_CHART_MAX_Y = 4
/** A pie takes at most this many slices; with more, it is drawn as bars. */
export const AI_PIE_MAX_SLICES = 8

/** The narrowest and the widest a chart is drawn: shown narrower or wider, it is scaled. */
export const AI_CHART_MIN_WIDTH = 340
export const AI_CHART_MAX_WIDTH = 820

/**
 * The width a chart is drawn at, for the width it is shown at: the same, so
 * its words keep their size, within bounds — on a phone it is scaled down a
 * little rather than crammed, on a wide page scaled up rather than spread
 * thin — in steps of 20. Not yet known (or not shown at all), the
 * dashboard's 720.
 */
export function aiChartWidth(shown: number | null): number {
  if (shown === null || !Number.isFinite(shown) || shown <= 0) return 720
  return Math.round(Math.min(AI_CHART_MAX_WIDTH, Math.max(AI_CHART_MIN_WIDTH, shown)) / 20) * 20
}

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
  /** When one column is split into series: the y column the values come from, and the column that splits it. */
  measure?: string
  splitBy?: string
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/
const YM = /^(\d{4})-(\d{2})$/

/**
 * The x values as labels: days as "Sep 8" (with the year when the days span
 * more than one), months as "Sep" or "Sep 2026" — written as months, or as
 * the first day of each (date_trunc('month', …)) — anything else as written.
 */
export function chartLabels(values: readonly AiCell[]): string[] {
  const texts = values.map((v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : cellText(v).trim()))
  const known = texts.filter((t) => t !== '')
  if (known.length > 0 && known.every((t) => YMD.test(t))) {
    const days = known.map((t) => t.slice(0, 10))
    const years = new Set(days.map((d) => d.slice(0, 4)))
    // Each the first of a different month, and more than one: a month apiece.
    const months = new Set(days.map((d) => d.slice(0, 7)))
    if (months.size > 1 && months.size === new Set(days).size && days.every((d) => d.endsWith('-01'))) {
      return texts.map((t) => (t ? monthLabel(t.slice(0, 7), years.size > 1) : '(blank)'))
    }
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

/**
 * A figure as a chart of the assistant writes it, on its axis, its marks and
 * its read-outs: grouped by thousands, as the answer and its cards write
 * them ("1,284", "-1,250"), to two decimals at most — and below one to three
 * significant digits, since a query may return any figure: 0.0012 is not
 * written 0, nor the steps of a small axis (0.005, 0.01, 0.015) alike.
 */
export function chartFigure(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  // Zero once: never "-0".
  if (n === 0) return '0'
  return Math.abs(n) < 1 ? n.toLocaleString('en-US', { maximumSignificantDigits: 3 }) : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** A column's name as a legend shows it: "defect_pieces" as "defect pieces". */
export const humanizeColumn = (name: string): string => name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || name

/**
 * The order the points are drawn in along x, when it is not the rows' own:
 * days and months in time's order (a long result is often ordered by its
 * series first, which would scramble the axis), and numbers along a line or
 * an area in their own. Null keeps the order the query returned — bars of
 * categories come ordered by their value. Blanks go last.
 */
export function axisOrder(xs: readonly AiCell[], type: AiChartType): number[] | null {
  const known = xs.filter((v): v is Exclude<AiCell, null> => v !== null && v !== undefined)
  if (known.length < 2) return null
  let key: ((v: AiCell) => string | number) | null = null
  // ISO days, months and midnight timestamps read in time's order as text.
  if (known.every((v) => typeof v === 'string' && (YMD.test(v.trim()) || YM.test(v.trim())))) key = (v) => String(v).trim()
  else if ((type === 'line' || type === 'area') && known.every((v) => typeof v === 'number')) key = (v) => v as number
  if (!key) return null
  const by = key
  const order = xs.map((_, i) => i)
  order.sort((a, b) => {
    const va = xs[a]
    const vb = xs[b]
    if (va === null || va === undefined) return vb === null || vb === undefined ? a - b : 1
    if (vb === null || vb === undefined) return -1
    const ka = by(va)
    const kb = by(vb)
    return ka < kb ? -1 : ka > kb ? 1 : a - b
  })
  return order.every((v, i) => v === i) ? null : order
}

/** Percentages by name: "reject_rate_pct", "share %", "Defect percent". */
const isPercentName = (name: string) => /%|٪|pct|percent/i.test(name)

/**
 * The chart a query asked for, shaped for drawing, or null when it cannot be
 * drawn: a column it names is missing, a value is not a number, or there is
 * nothing to draw (every bar or slice nothing). The server checked all of it
 * already; this holds against a reply it never sent.
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

  // A value of x or of the split column as the server tells them apart (server/src/ai/charts.ts): by what the query
  // returned, exactly — null and "", "A" and "A ", 1 and "1" are each two, however alike they are written.
  const keyOf = (v: AiCell | undefined) => JSON.stringify(v ?? null)

  // The categories in the order the query returned them; a category met again adds to its own (a total per category).
  const order: string[] = []
  const at = new Map<string, number>()
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
    // Long to wide: one series per value of the split column, of the first y column. Two values written alike
    // (a blank and an empty text) stay two series, each with its own points, their names told apart as x's are.
    const yi = ys[0]
    const bySeries = new Map<string, { label: string; sums: (number | null)[] }>()
    for (const r of rows) {
      const c = category(r[xi])
      const v = num(r[yi])
      if (v === undefined) return null
      const key = keyOf(r[si])
      let s = bySeries.get(key)
      if (!s) bySeries.set(key, (s = { label: r[si] === null || r[si] === undefined ? '(blank)' : cellText(r[si]).trim() || '(blank)', sums: [] }))
      if (v !== null) s.sums[c] = (s.sums[c] ?? 0) + v
    }
    const found = [...bySeries.values()]
    const names = uniqueLabels(found.map((s) => s.label))
    series = found.map((s, k) => ({ label: names[k], sums: s.sums }))
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
  const along = axisOrder(xValues, spec.type)
  const arrange = <T>(list: T[]): T[] => (along ? along.map((i) => list[i]) : list)
  const values = series.map((s) => ({ label: s.label, values: arrange(Array.from({ length: n }, (_, i) => s.sums[i] ?? null)) }))
  const all = values.flatMap((s) => s.values).filter((v): v is number => v !== null)
  if (all.length === 0) return null
  const negative = all.some((v) => v < 0)

  // The largest series first when one column is split; the y columns keep the order asked for.
  const total = (s: ChartSeries) => s.values.reduce<number>((t, v) => t + (v ?? 0), 0)
  const ranked = si >= 0 ? [...values].sort((a, b) => total(b) - total(a)) : values
  const kept = ranked.slice(0, AI_CHART_MAX_SERIES)
  const omitted = ranked.length - kept.length

  let type = spec.type
  // As the server draws them: a pie of one series, a few slices, none below zero; a stack that does not cross zero.
  if (type === 'pie' && (kept.length > 1 || n > AI_PIE_MAX_SLICES || negative)) type = 'bar'
  if (type === 'stacked-bar' && negative) type = 'bar'
  // Bars and slices of nothing draw nothing; a line along zero still says something.
  const drawable = kept.flatMap((s) => s.values).some((v) => v !== null && v !== 0)
  if (type !== 'line' && type !== 'area' && !drawable) return null

  const yNames = si >= 0 ? [columns[ys[0]]] : ys.map((i) => columns[i])
  return {
    type,
    ...(spec.title?.trim() ? { title: spec.title.trim() } : {}),
    labels: uniqueLabels(chartLabels(arrange(xValues))),
    series: kept,
    unit: yNames.every(isPercentName) ? '%' : '',
    omitted,
    ...(si >= 0 ? { measure: humanizeColumn(columns[ys[0]]), splitBy: humanizeColumn(columns[si]) } : {}),
  }
}

/** A query's chart, when it asked for one and its result can be drawn. */
export function queryChart(part: AiQueryPart): ChartModel | null {
  if (!part.ok || !part.chart) return null
  return shapeChart(part.chart, part.columns, part.rows)
}
