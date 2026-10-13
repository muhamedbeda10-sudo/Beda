// ============================================================================
// §20 — a chart of a query's result. Since phase 4 the run_sql tool of a new
// conversation takes an optional `chart`: how the model wants the result
// drawn above its table in the answer,
//
//     { type: 'line', x: 'day', y: ['defect_pieces'], title: 'Defect pieces per day' }
//
// Thirteen kinds (shared/ai.ts: AI_CHART_TYPES), each taking what it needs:
// a combo two or more y columns, a heatmap a series for its rows, a Pareto
// and a control chart one y and no series, a scatter a numeric x; any of
// bar, horizontal-bar, line, area, combo and control may carry a target
// (goal). It is checked here against what the query returned before
// anything keeps it: the columns must be there (and be numbers where they
// are plotted), and the chart must have something to show. A chart that
// cannot be drawn is left out, and the model is told why in the query's
// result, so it can say so or try again; one that can be drawn another way
// is (a pie of too many slices, a Pareto of too many causes as bars; a stack
// across zero side by side), and the result says so.
//
// Report sections carry a chart too (a saved report's, from its answer; a
// scheduled report's, from its proposal): checked again against every run's
// rows, and left out of a run they do not fit.
// What passes is stored with the query (ai_queries.chart) and handed to the
// panel on its card (AiQueryPart.chart), live and in the history alike.
//
// A conversation begun before phase 4 keeps the tool it was given, without
// `chart`: what a conversation was sent is never changed.
// ============================================================================

import { z } from 'zod'
import { AI_CHART_TYPES, type AiCell, type AiChartSpec, type AiChartType } from '@qc/shared/ai'
import { cutChars } from './blocks'
import type { QueryPreview } from './runQuery'

/** Numeric columns one chart plots at most. */
export const MAX_CHART_Y = 4
/** Slices a pie shows at most; more are drawn as bars. */
export const MAX_PIE_SLICES = 8
/** Values a series column may split the chart into. */
export const MAX_CHART_SERIES = 8
/** A heatmap's rows (its series' values) and columns (its x values) at most. */
export const MAX_HEATMAP_ROWS = 25
export const MAX_HEATMAP_COLUMNS = 40
/** A Pareto's causes at most: the rest are grouped as "Others" in SQL. */
export const MAX_PARETO_BARS = 30
/** Points a control chart needs at the least for its limits to mean anything. */
export const MIN_CONTROL_POINTS = 5
/** A longer title is cut. */
export const MAX_CHART_TITLE_CHARS = 100

/** `chart` in run_sql's input, as the tool declares it. A strict schema cannot carry the count limits: checkChart holds to them. */
export const CHART_INPUT_SCHEMA = {
  type: 'object',
  description:
    'Optional. Draws the result as a chart, shown with the answer above the result\'s table, when a picture says more than the figures (see "Charts" in the system prompt). Leave it out otherwise.',
  properties: {
    type: {
      type: 'string',
      enum: [...AI_CHART_TYPES],
      description:
        'bar: compare categories. horizontal-bar: a ranking, or long category names. line or area: a trend over time. ' +
        `stacked-bar, stacked-bar-100 (each column as shares of 100%), stacked-area or pie (at most ${MAX_PIE_SLICES} slices): the parts of a whole. ` +
        'combo: the first y as bars (a volume), the other y columns as lines on their own axis (a rate). ' +
        `pareto: one y, causes largest first with their running share (at most ${MAX_PARETO_BARS}). ` +
        'scatter: x and y both numeric, one point per row, with a trend line. ' +
        'heatmap: one y across x and series (machine by day), one row per pair. ' +
        `control: one y in time order, an SPC individuals chart with its centre line and 3-sigma limits (at least ${MIN_CONTROL_POINTS} points).`,
    },
    x: { type: 'string', description: "The result column along the axis, exactly as the query names it: a day, a month or a category (a pie's slices); a number for scatter." },
    y: { type: 'array', items: { type: 'string' }, description: `1 to ${MAX_CHART_Y} numeric result columns to plot, exactly as the query names them.` },
    series: {
      type: 'string',
      description: `Optional. A result column whose values split the one y column into lines, bars or stacks, one per value (at most ${MAX_CHART_SERIES}; a heatmap's rows, at most ${MAX_HEATMAP_ROWS}): the result in long form, one row per x and series value.`,
    },
    title: { type: 'string', description: "Optional. A short title, in the user's language." },
    goal: {
      type: 'number',
      description: "Optional. A target drawn as a dashed line across the plot, in the y column's unit (bar, horizontal-bar, line, area, combo's line axis, control).",
    },
  },
  required: ['type', 'x', 'y'],
  additionalProperties: false,
}

/** The input as it may arrive: eager input streaming means the API no longer holds the model to the schema. */
const ChartInput = z.object({
  type: z.string(),
  x: z.string(),
  y: z.union([z.string(), z.array(z.string())]),
  series: z.string().nullish(),
  title: z.string().nullish(),
  goal: z.number().nullish(),
})

export interface ChartCheck {
  /** The chart as it is drawn; absent when it was left out. */
  chart?: AiChartSpec
  /** For the model, in the query's result: what was left out or changed, and why. Absent when the chart is drawn as asked. */
  note?: string
}

const NOT_DRAWN = 'Chart not drawn:'
const AS_BARS = 'Chart drawn as a bar chart instead of a pie:'

/** Other names the model may give a type. */
const ALIASES: Record<string, AiChartType> = {
  donut: 'pie',
  doughnut: 'pie',
  column: 'bar',
  'column-bar': 'bar',
  hbar: 'horizontal-bar',
  'bar-horizontal': 'horizontal-bar',
  'horizontal-bars': 'horizontal-bar',
  'stacked-column': 'stacked-bar',
  'percent-stacked-bar': 'stacked-bar-100',
  'stacked-bar-percent': 'stacked-bar-100',
  '100%-stacked-bar': 'stacked-bar-100',
  'bar-line': 'combo',
  'bar+line': 'combo',
  'dual-axis': 'combo',
  spc: 'control',
  'control-chart': 'control',
  'i-chart': 'control',
  'scatter-plot': 'scatter',
  'heat-map': 'heatmap',
}

/** A chart type as the model may spell it ("Stacked bar", "stacked_bar", "donut"); null when it is none of them. */
function typeOf(raw: string): AiChartType | null {
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if ((AI_CHART_TYPES as readonly string[]).includes(t)) return t as AiChartType
  return ALIASES[t] ?? null
}

/** The types that take a goal line. */
const TAKES_GOAL: ReadonlySet<AiChartType> = new Set(['bar', 'horizontal-bar', 'line', 'area', 'combo', 'control'])
/** The types that stack their series, and cannot across zero. */
const STACKED: ReadonlySet<AiChartType> = new Set(['stacked-bar', 'stacked-bar-100', 'stacked-area'])

type Column = { index: number; name: string } | { error: string }

/**
 * A column of the result by the name the model gave: as written, or, when
 * nothing is named so, in any case (PostgreSQL folds an unquoted alias to
 * lower case). Two columns may share a name; such a name is no column.
 */
function columnOf(columns: readonly string[], raw: string, role: string): Column {
  const name = raw.trim()
  const find = (same: (c: string) => boolean) => columns.flatMap((c, index) => (same(c) ? [index] : []))
  let at = find((c) => c === name)
  if (at.length === 0) at = find((c) => c.toLowerCase() === name.toLowerCase())
  if (at.length === 1) return { index: at[0], name: columns[at[0]] }
  if (at.length > 1) return { error: `${NOT_DRAWN} ${role} "${name}" names ${at.length} columns of the result; give them distinct aliases.` }
  return { error: `${NOT_DRAWN} ${role} "${name}" is not a column of the result.` }
}

/** The distinct values of a column, as the chart tells them apart (null and "" are two). */
const distinct = (rows: readonly AiCell[][], index: number): number => new Set(rows.map((r) => JSON.stringify(r[index] ?? null))).size

/**
 * The chart the model asked for, checked against the result it is drawn
 * from: the rows the model read and the card shows. Nothing asked for,
 * nothing returned. A chart that can be drawn another way is (a pie of too
 * many slices as bars, a stack across zero side by side), and the note says so.
 */
export function checkChart(raw: unknown, result: QueryPreview): ChartCheck {
  if (raw === undefined || raw === null) return {}
  const parsed = ChartInput.safeParse(raw)
  if (!parsed.success) return { note: `${NOT_DRAWN} chart takes type, x and y (a list of column names), and optionally series, title and goal.` }
  const input = parsed.data
  const type = typeOf(input.type)
  if (!type) return { note: `${NOT_DRAWN} its type must be one of ${AI_CHART_TYPES.join(', ')}.` }

  const x = columnOf(result.columns, input.x, 'x')
  if ('error' in x) return { note: x.error }
  const yNames = (typeof input.y === 'string' ? [input.y] : input.y).filter((n) => n.trim() !== '')
  if (yNames.length === 0 || yNames.length > MAX_CHART_Y) return { note: `${NOT_DRAWN} y takes 1 to ${MAX_CHART_Y} columns.` }
  const ys: { index: number; name: string }[] = []
  for (const name of yNames) {
    const y = columnOf(result.columns, name, 'y')
    if ('error' in y) return { note: y.error }
    if (y.index === x.index || ys.some((o) => o.index === y.index)) return { note: `${NOT_DRAWN} "${y.name}" is used twice; x, y and series each take other columns.` }
    ys.push(y)
  }
  let series: { index: number; name: string } | null = null
  if (input.series && input.series.trim() !== '') {
    const s = columnOf(result.columns, input.series, 'series')
    if ('error' in s) return { note: s.error }
    if (s.index === x.index || ys.some((o) => o.index === s.index)) return { note: `${NOT_DRAWN} "${s.name}" is used twice; x, y and series each take other columns.` }
    if (ys.length > 1) return { note: `${NOT_DRAWN} with series, y takes exactly one column.` }
    series = s
  }

  // What each type takes of y and series.
  if (type === 'heatmap' && (!series || ys.length !== 1)) return { note: `${NOT_DRAWN} a heatmap takes one y column and a series column for its rows.` }
  if ((type === 'pareto' || type === 'control') && (series || ys.length !== 1)) return { note: `${NOT_DRAWN} a ${type === 'pareto' ? 'Pareto' : 'control'} chart takes one y column and no series.` }
  if (type === 'combo' && (series || ys.length < 2)) return { note: `${NOT_DRAWN} a combo chart takes 2 to ${MAX_CHART_Y} y columns (the first as bars, the rest as lines) and no series.` }

  const rows = result.rows
  if (rows.length === 0) return { note: `${NOT_DRAWN} the result has no rows.` }
  if (type === 'scatter') {
    let numbers = 0
    for (const row of rows) {
      const v = row[x.index]
      if (v === null) continue
      if (typeof v !== 'number') return { note: `${NOT_DRAWN} a scatter chart's x column "${x.name}" must be numeric (it holds ${JSON.stringify(cutChars(String(v), 40, true))}).` }
      numbers++
    }
    if (numbers < 3) return { note: `${NOT_DRAWN} a scatter chart needs at least 3 points.` }
  }
  let values = 0
  let nonZero = false
  let negative = false
  for (const y of ys) {
    let numbers = 0
    for (const row of rows) {
      const v = row[y.index]
      if (v === null) continue
      if (typeof v !== 'number') return { note: `${NOT_DRAWN} y column "${y.name}" is not numeric (it holds ${JSON.stringify(cutChars(String(v), 40, true))}).` }
      numbers++
      if (v !== 0) nonZero = true
      if (v < 0) negative = true
    }
    if (numbers === 0) return { note: `${NOT_DRAWN} y column "${y.name}" holds no numbers.` }
    values += numbers
  }
  if (values < 2) return { note: `${NOT_DRAWN} a single figure is stated in words, not charted.` }
  if (!nonZero) return { note: `${NOT_DRAWN} every value is 0.` }
  if (series) {
    const n = distinct(rows, series.index)
    const most = type === 'heatmap' ? MAX_HEATMAP_ROWS : MAX_CHART_SERIES
    if (n > most) {
      return {
        note:
          type === 'heatmap'
            ? `${NOT_DRAWN} series "${series.name}" has ${n} values; a heatmap shows at most ${MAX_HEATMAP_ROWS} rows. Keep the largest and group the rest.`
            : `${NOT_DRAWN} series "${series.name}" has ${n} values; a chart shows at most ${MAX_CHART_SERIES}. Keep the largest and group the rest, or chart without series.`,
      }
    }
  }
  if (type === 'heatmap' && distinct(rows, x.index) > MAX_HEATMAP_COLUMNS) {
    return { note: `${NOT_DRAWN} x "${x.name}" has ${distinct(rows, x.index)} values; a heatmap shows at most ${MAX_HEATMAP_COLUMNS} columns. Use a coarser period (weeks for days).` }
  }
  // One point per x (and series): two rows on one point would be drawn over each other, or summed out of sight. A scatter's points may share an x.
  if (type !== 'scatter') {
    const points = new Set(rows.map((r) => JSON.stringify([r[x.index] ?? null, series ? (r[series.index] ?? null) : null]))).size
    if (points < rows.length) {
      return {
        note: series
          ? `${NOT_DRAWN} rows repeat a pair of x "${x.name}" and series "${series.name}"; return one row per pair.`
          : `${NOT_DRAWN} rows repeat a value of x "${x.name}"; return one row per x, or name the column that tells them apart as series.`,
      }
    }
  }
  if (type === 'control' && rows.length < MIN_CONTROL_POINTS) return { note: `${NOT_DRAWN} a control chart needs at least ${MIN_CONTROL_POINTS} points for its limits.` }

  const notes: string[] = []
  let drawn: AiChartType = type
  if (type === 'pie') {
    const slices = distinct(rows, x.index)
    const why =
      ys.length > 1 || series
        ? 'a pie shows one y column and no series.'
        : slices > MAX_PIE_SLICES
          ? `a pie shows at most ${MAX_PIE_SLICES} slices and the result has ${slices}.`
          : negative
            ? 'a pie cannot show negative values.'
            : null
    if (why) {
      drawn = 'bar'
      notes.push(`${AS_BARS} ${why}`)
    }
  }
  if (STACKED.has(type) && negative) {
    drawn = type === 'stacked-area' ? 'line' : 'bar'
    notes.push(`Chart drawn as ${drawn === 'line' ? 'lines' : 'bars side by side'} instead of stacked: a stack cannot show values below zero.`)
  }
  if (type === 'pareto') {
    const bars = distinct(rows, x.index)
    if (negative) {
      drawn = 'bar'
      notes.push('Chart drawn as a bar chart instead of a Pareto: a Pareto cannot show negative values.')
    } else if (bars > MAX_PARETO_BARS) {
      drawn = 'bar'
      notes.push(`Chart drawn as a bar chart instead of a Pareto: a Pareto shows at most ${MAX_PARETO_BARS} causes and the result has ${bars}; keep the largest and group the rest as Others.`)
    }
  }
  if (result.truncated) notes.push(`The chart shows only the ${rows.length} rows returned, not the whole result: aggregate further for a chart of all of it.`)

  const chart: AiChartSpec = { type: drawn, x: x.name, y: ys.map((y) => y.name) }
  if (series) chart.series = series.name
  const title = cutChars((input.title ?? '').replace(/\s+/g, ' ').trim(), MAX_CHART_TITLE_CHARS, true)
  if (title) chart.title = title
  if (typeof input.goal === 'number' && Number.isFinite(input.goal)) {
    if (TAKES_GOAL.has(drawn)) chart.goal = input.goal
    else notes.push(`The goal line is not drawn: a ${drawn} chart takes none.`)
  }
  return notes.length > 0 ? { chart, note: notes.join(' ') } : { chart }
}
