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
/** A heatmap's rows at most (the server's limit too). */
export const AI_HEATMAP_MAX_ROWS = 25
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

/** A scatter chart's points of one series. */
export interface ScatterSeries {
  label: string
  points: { x: number; y: number }[]
}

/** An individuals control chart's centre line and limits (3 sigma, sigma from the average moving range). */
export interface ControlLimits {
  mean: number
  ucl: number
  lcl: number
  sigma: number
}

export interface ChartModel {
  /** What is drawn: a pie of too many slices is drawn as bars. */
  type: AiChartType
  title?: string
  /** The x column's values, in the order the query returned them, as shown. */
  labels: string[]
  series: ChartSeries[]
  /** '%' when the figures are percentages (by the y column's name), else ''. A combo's: its bars'. */
  unit: string
  /** A combo's lines' unit. */
  lineUnit?: string
  /** A target drawn as a dashed line. */
  goal?: number
  /** A scatter chart's points, by series; the axes' names. */
  scatter?: ScatterSeries[]
  xName?: string
  yName?: string
  /** A control chart's centre line and limits. */
  control?: ControlLimits
  /** A Pareto's running share of the total at each bar, in %. */
  cumulative?: number[]
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
  else if ((type === 'line' || type === 'area' || type === 'stacked-area' || type === 'control') && known.every((v) => typeof v === 'number')) key = (v) => v as number
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

/**
 * An individuals (XmR) control chart's lines: the mean of the values, and
 * limits 3 sigma either side, sigma estimated from the average moving range
 * (MR-bar / 1.128, as SPC does: robust to a shift in the process, unlike the
 * plain standard deviation). Null with fewer than two values.
 */
export function controlLimits(values: readonly (number | null)[]): ControlLimits | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (known.length < 2) return null
  const mean = known.reduce((t, v) => t + v, 0) / known.length
  let ranges = 0
  for (let i = 1; i < known.length; i++) ranges += Math.abs(known[i] - known[i - 1])
  const sigma = ranges / (known.length - 1) / 1.128
  return { mean, ucl: mean + 3 * sigma, lcl: mean - 3 * sigma, sigma }
}

/** Each category's share of the running total, in %, after ordering largest first (a Pareto's line). */
export function cumulativeShares(values: readonly number[]): number[] {
  const total = values.reduce((t, v) => t + Math.max(0, v), 0)
  let run = 0
  return values.map((v) => {
    run += Math.max(0, v)
    return total > 0 ? Math.min(100, (run / total) * 100) : 0
  })
}

/** Each column's parts as shares of its total, in % (a 100% stacked chart); a column of nothing stays nothing. */
export function percentStack(series: readonly ChartSeries[], n: number): ChartSeries[] {
  const totals = Array.from({ length: n }, (_, i) => series.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0))
  return series.map((s) => ({ label: s.label, values: s.values.map((v, i) => (v === null || totals[i] === 0 ? null : (Math.max(0, v) / totals[i]) * 100)) }))
}

/** A least-squares line through points, with r (Pearson's); null for fewer than two distinct x. */
export function trendLine(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; r: number } | null {
  const n = points.length
  if (n < 2) return null
  const mx = points.reduce((t, p) => t + p.x, 0) / n
  const my = points.reduce((t, p) => t + p.y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my)
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, r: syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy) }
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
  const yNames = si >= 0 ? [columns[ys[0]]] : ys.map((i) => columns[i])
  const goal = typeof spec.goal === 'number' && Number.isFinite(spec.goal) ? { goal: spec.goal } : {}
  const titled = spec.title?.trim() ? { title: spec.title.trim() } : {}

  if (spec.type === 'scatter') {
    // Points, not categories: one per row, by series (each y column, or each value of the split column).
    const groups = new Map<string, ScatterSeries>()
    const add = (label: string, x: number, y: number) => {
      let g = groups.get(label)
      if (!g) groups.set(label, (g = { label, points: [] }))
      g.points.push({ x, y })
    }
    for (const r of rows) {
      const x = num(r[xi])
      if (x === undefined) return null
      if (x === null) continue
      if (si >= 0) {
        const y = num(r[ys[0]])
        if (y === undefined) return null
        if (y !== null) add(r[si] === null || r[si] === undefined ? '(blank)' : cellText(r[si]).trim() || '(blank)', x, y)
      } else
        for (const yi of ys) {
          const y = num(r[yi])
          if (y === undefined) return null
          if (y !== null) add(humanizeColumn(columns[yi]), x, y)
        }
    }
    const scatter = [...groups.values()].slice(0, AI_CHART_MAX_SERIES)
    if (scatter.reduce((t, g) => t + g.points.length, 0) < 2) return null
    return {
      type: 'scatter',
      ...titled,
      labels: [],
      series: [],
      unit: yNames.every(isPercentName) ? '%' : '',
      omitted: Math.max(0, groups.size - scatter.length),
      scatter,
      xName: humanizeColumn(columns[xi]),
      yName: si >= 0 ? humanizeColumn(columns[ys[0]]) : ys.length === 1 ? humanizeColumn(columns[ys[0]]) : '',
      ...goal,
    }
  }

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

  // The largest series first when one column is split (a heatmap keeps its rows in the order they came); the y columns keep the order asked for.
  const total = (s: ChartSeries) => s.values.reduce<number>((t, v) => t + (v ?? 0), 0)
  const ranked = si >= 0 && spec.type !== 'heatmap' ? [...values].sort((a, b) => total(b) - total(a)) : values
  const kept = ranked.slice(0, spec.type === 'heatmap' ? AI_HEATMAP_MAX_ROWS : AI_CHART_MAX_SERIES)
  const omitted = ranked.length - kept.length

  let type = spec.type
  // As the server draws them: a pie of one series, a few slices, none below zero; a stack that does not cross zero.
  if (type === 'pie' && (kept.length > 1 || n > AI_PIE_MAX_SLICES || negative)) type = 'bar'
  if ((type === 'stacked-bar' || type === 'stacked-bar-100' || type === 'pareto') && negative) type = 'bar'
  if (type === 'stacked-area' && negative) type = 'line'
  if (type === 'combo' && kept.length < 2) type = 'bar'
  if ((type === 'pareto' || type === 'control') && kept.length !== 1) type = type === 'pareto' ? 'bar' : 'line'
  // Bars and slices of nothing draw nothing; a line along zero still says something.
  const drawable = kept.flatMap((s) => s.values).some((v) => v !== null && v !== 0)
  if (type !== 'line' && type !== 'area' && type !== 'control' && !drawable) return null

  let labels = uniqueLabels(chartLabels(arrange(xValues)))
  let drawn: ChartSeries[] = kept
  const extra: Partial<ChartModel> = {}
  if (type === 'pareto') {
    // Largest first, whatever order the rows came in; the running share over them.
    const order = labels.map((_, i) => i).sort((a, b) => (kept[0].values[b] ?? 0) - (kept[0].values[a] ?? 0))
    labels = order.map((i) => labels[i])
    drawn = [{ label: kept[0].label, values: order.map((i) => kept[0].values[i]) }]
    extra.cumulative = cumulativeShares(drawn[0].values.map((v) => v ?? 0))
  }
  if (type === 'control') {
    const limits = controlLimits(drawn[0].values)
    if (!limits) return null
    extra.control = limits
  }
  if (type === 'combo') {
    const lineNames = yNames.slice(1)
    extra.lineUnit = lineNames.every(isPercentName) ? '%' : ''
  }
  return {
    type,
    ...titled,
    labels,
    series: drawn,
    unit: (type === 'combo' ? yNames.slice(0, 1) : yNames).every(isPercentName) ? '%' : '',
    omitted,
    ...(si >= 0 ? { measure: humanizeColumn(columns[ys[0]]), splitBy: humanizeColumn(columns[si]) } : {}),
    ...(type === 'pie' || type === 'stacked-bar' || type === 'stacked-bar-100' || type === 'stacked-area' || type === 'heatmap' || type === 'pareto' ? {} : goal),
    ...extra,
  }
}

/** A query's chart, when it asked for one and its result can be drawn. */
export function queryChart(part: AiQueryPart): ChartModel | null {
  if (!part.ok || !part.chart) return null
  return shapeChart(part.chart, part.columns, part.rows)
}
