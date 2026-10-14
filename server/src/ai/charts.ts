// ============================================================================
// §20 — a chart of a query's result. Since phase 4 the run_sql tool of a new
// conversation takes an optional `chart`: how the model wants the result
// drawn above its table in the answer,
//
//     { type: 'line', x: 'day', y: ['defect_pieces'], title: 'Defect pieces per day' }
//
// Thirty-one kinds (shared/ai.ts: AI_CHART_TYPES), each taking what it needs:
// a combo two or more y columns, a heatmap a series for its rows, a Pareto,
// a control chart, a funnel and a waterfall one y and no series, a scatter a
// numeric x, a dumbbell two y columns, a progress chart one (of a goal, or a
// percentage) or two (done and its target), a gantt two date columns (start
// and end) with perhaps a series naming its bars, a treemap one y with
// perhaps a series grouping its tiles; any of bar, horizontal-bar, line,
// area, combo, control and dumbbell may carry a target (goal). The quality
// charts take the readings themselves (a histogram one per row, an X̄-R chart
// and a box plot several per subgroup or group), or the counts an attribute
// chart is worked out from (a p-chart's defectives and inspected, a u-chart's
// defects and units, a c-chart's defects); a histogram and a box plot may
// carry specification limits (lsl, usl). A gauge takes one to six figures, a
// radar three to twelve axes, a bubble chart a numeric x and two y (its
// height and its size), a sankey its flows (from x to series, by y), a
// calendar one figure per day, a risk matrix each failure mode's severity and
// occurrence (and detection) on a scale of 1 to 10. It is checked here against what the query returned before
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
import { AI_CHART_TYPES, parseChartDate, type AiCell, type AiChartSpec, type AiChartType } from '@qc/shared/ai'
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
/** A progress chart's bars, a dumbbell's rows, a waterfall's steps and a funnel's stages at most. */
export const MAX_PROGRESS_BARS = 30
export const MAX_DUMBBELL_ROWS = 30
export const MAX_WATERFALL_STEPS = 30
export const MAX_FUNNEL_STAGES = 12
/** A gantt's rows (its x values) and bars at most. */
export const MAX_GANTT_ROWS = 40
export const MAX_GANTT_BARS = 120
/** A treemap's tiles at most: the rest are grouped as "Others" in SQL. */
export const MAX_TREEMAP_TILES = 60
/** Readings a histogram needs at the least to show a spread. */
export const MIN_HISTOGRAM_READINGS = 10
/** An X̄-R chart's subgroups at the least, and readings in one at most (its constants go to 10). */
export const MIN_XBAR_SUBGROUPS = 5
export const MAX_SUBGROUP_SIZE = 10
/** A box plot's groups at most. */
export const MAX_BOX_GROUPS = 12
/** Gauges one chart draws at most. */
export const MAX_GAUGES = 6
/** A radar's axes, at least and at most; its shapes at most. */
export const MIN_RADAR_AXES = 3
export const MAX_RADAR_AXES = 12
export const MAX_RADAR_SHAPES = 6
/** A bubble chart's bubbles, a sankey's flows and its stages (nodes), a risk matrix's failure modes, at most. */
export const MAX_BUBBLES = 60
export const MAX_SANKEY_LINKS = 60
export const MAX_SANKEY_NODES = 40
export const MAX_RISKS = 30

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
        `control: one y in time order, an SPC individuals chart with its centre line and 3-sigma limits (at least ${MIN_CONTROL_POINTS} points). ` +
        'progress: how far each row is toward its target, as bars: y = [done, target] (each row its own), or one y with goal as the target for every row, or one y that is already a % of 100. ' +
        'funnel: one y over stages in the order returned, each kept from the one before. ' +
        'waterfall: one y of signed changes in order (the first may be the starting amount); the end total is drawn after them. ' +
        'gantt: bars in time, y = [start, end] (dates or timestamps); x names the row, series (optional) names and colours each bar, and a row may hold several bars. ' +
        'dumbbell: two y columns compared on each row (planned and actual, last month and this one). ' +
        'treemap: one y as tiles sized by it (none below zero); series (optional) groups the tiles. ' +
        `histogram: one y of readings, one row per reading in time order (x names each: a sample), at least ${MIN_HISTOGRAM_READINGS}; with lsl and usl it shows the capability (Cp, Cpk, Pp, Ppk). ` +
        `xbar-r: one y of readings, one row per reading, x the subgroup (a session, an hour) in time order: 2 to ${MAX_SUBGROUP_SIZE} readings per subgroup, at least ${MIN_XBAR_SUBGROUPS} subgroups. ` +
        'p-chart: y = [defective, inspected] per sample (x a day or a lot), the share defective with its limits. u-chart: y = [defects, units]: defects per unit. c-chart: one y of defects per equal sample. ' +
        `box-plot: one y of readings, one row per reading, x the group (machine, shift), at most ${MAX_BOX_GROUPS} groups; lsl and usl optional. ` +
        `gauge: one y, one to ${MAX_GAUGES} rows (x names each), each on a dial to max against goal; better says whether higher or lower is good. ` +
        `radar: x the axes (${MIN_RADAR_AXES} to ${MAX_RADAR_AXES} measures, best on one scale such as 0-100), one shape per y column or per series value (at most ${MAX_RADAR_SHAPES}). ` +
        `bubble: x and the first y numeric, the second y sizes each bubble; series (optional) names each bubble (at most ${MAX_BUBBLES}). ` +
        `sankey: one row per flow: x the stage it leaves, series the stage it reaches, one y its quantity (at most ${MAX_SANKEY_LINKS} flows, no loops). ` +
        'calendar: x a day (a date), one y, one row per day: shaded by day across the weeks. ' +
        `risk-matrix (FMEA): x the failure mode, y = [severity, occurrence] or [severity, occurrence, detection], each 1 to 10 (or 1 to 5), at most ${MAX_RISKS} modes; it ranks them by RPN.`,
    },
    x: { type: 'string', description: "The result column along the axis, exactly as the query names it: a day, a month or a category (a pie's slices); a number for scatter." },
    y: {
      type: 'array',
      items: { type: 'string' },
      description: `1 to ${MAX_CHART_Y} numeric result columns to plot, exactly as the query names them (a gantt's two: the start and end dates).`,
    },
    series: {
      type: 'string',
      description: `Optional. A result column whose values split the one y column into lines, bars or stacks, one per value (at most ${MAX_CHART_SERIES}; a heatmap's rows, at most ${MAX_HEATMAP_ROWS}): the result in long form, one row per x and series value. A gantt's: each bar's name; a treemap's: the group of each tile.`,
    },
    title: { type: 'string', description: "Optional. A short title, in the user's language." },
    lsl: { type: 'number', description: "Optional. A histogram's or a box plot's lower specification limit, in the y column's unit." },
    usl: { type: 'number', description: "Optional. A histogram's or a box plot's upper specification limit, in the y column's unit." },
    max: { type: 'number', description: "Optional. A gauge's full scale (100 for a percentage)." },
    better: { type: 'string', enum: ['higher', 'lower'], description: "Optional. A gauge's: whether a higher or a lower figure is good against goal (lower for rejects or downtime)." },
    goal: {
      type: 'number',
      description:
        "Optional. A target drawn as a dashed line across the plot, in the y column's unit (bar, horizontal-bar, line, area, combo's line axis, control, dumbbell, histogram, xbar-r, box-plot: the nominal); a progress chart's target for every row, with one y; a gauge's target.",
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
  lsl: z.number().nullish(),
  usl: z.number().nullish(),
  max: z.number().nullish(),
  better: z.string().nullish(),
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
  'progress-bar': 'progress',
  'progress-bars': 'progress',
  completion: 'progress',
  'funnel-chart': 'funnel',
  'waterfall-chart': 'waterfall',
  bridge: 'waterfall',
  'bridge-chart': 'waterfall',
  'gantt-chart': 'gantt',
  timeline: 'gantt',
  schedule: 'gantt',
  'dumbbell-chart': 'dumbbell',
  'dumbbell-plot': 'dumbbell',
  'connected-dot': 'dumbbell',
  'dot-plot': 'dumbbell',
  'tree-map': 'treemap',
  capability: 'histogram',
  'capability-histogram': 'histogram',
  'process-capability': 'histogram',
  distribution: 'histogram',
  xbar: 'xbar-r',
  'x-bar-r': 'xbar-r',
  'xbar-r-chart': 'xbar-r',
  'x-bar': 'xbar-r',
  'xbar-chart': 'xbar-r',
  p: 'p-chart',
  'p-control': 'p-chart',
  u: 'u-chart',
  c: 'c-chart',
  'box-and-whisker': 'box-plot',
  boxplot: 'box-plot',
  'box-whisker': 'box-plot',
  box: 'box-plot',
  dial: 'gauge',
  speedometer: 'gauge',
  spider: 'radar',
  'spider-chart': 'radar',
  'radar-chart': 'radar',
  'bubble-chart': 'bubble',
  flow: 'sankey',
  'sankey-diagram': 'sankey',
  'calendar-heatmap': 'calendar',
  'risk-map': 'risk-matrix',
  fmea: 'risk-matrix',
  'heat-matrix': 'risk-matrix',
}

/** A chart type as the model may spell it ("Stacked bar", "stacked_bar", "donut"); null when it is none of them. */
function typeOf(raw: string): AiChartType | null {
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if ((AI_CHART_TYPES as readonly string[]).includes(t)) return t as AiChartType
  return ALIASES[t] ?? null
}

/** The types that take a goal line (a progress chart's: its target for every row). */
const TAKES_GOAL: ReadonlySet<AiChartType> = new Set(['bar', 'horizontal-bar', 'line', 'area', 'combo', 'control', 'dumbbell', 'progress', 'histogram', 'xbar-r', 'box-plot', 'gauge'])
/** The types that take specification limits. */
const TAKES_SPEC: ReadonlySet<AiChartType> = new Set(['histogram', 'box-plot'])
/** The types whose rows may repeat x: readings of one subgroup or group, points that share an x. */
const REPEATS_X: ReadonlySet<AiChartType> = new Set(['scatter', 'bubble', 'histogram', 'xbar-r', 'box-plot'])
/** The attribute control charts, and the control charts as a whole: each needs enough points for its limits. */
const ATTRIBUTE: ReadonlySet<AiChartType> = new Set(['p-chart', 'u-chart', 'c-chart'])

/** How the notes name each type. */
const TYPE_NAME: Record<AiChartType, string> = {
  bar: 'bar chart',
  'horizontal-bar': 'horizontal bar chart',
  'stacked-bar': 'stacked bar chart',
  'stacked-bar-100': '100% stacked bar chart',
  line: 'line chart',
  area: 'area chart',
  'stacked-area': 'stacked area chart',
  pie: 'pie chart',
  combo: 'combo chart',
  pareto: 'Pareto chart',
  scatter: 'scatter chart',
  heatmap: 'heatmap',
  control: 'control chart',
  progress: 'progress chart',
  funnel: 'funnel',
  waterfall: 'waterfall',
  gantt: 'gantt chart',
  dumbbell: 'dumbbell chart',
  treemap: 'treemap',
  histogram: 'histogram',
  'xbar-r': 'X̄-R chart',
  'p-chart': 'p-chart',
  'u-chart': 'u-chart',
  'c-chart': 'c-chart',
  'box-plot': 'box plot',
  gauge: 'gauge',
  radar: 'radar chart',
  bubble: 'bubble chart',
  sankey: 'sankey diagram',
  calendar: 'calendar',
  'risk-matrix': 'risk matrix',
}

/** The most rows (a gantt's: bars; a treemap's: tiles) each type draws, when it has a limit of its own. */
const MOST_ROWS: Partial<Record<AiChartType, number>> = {
  progress: MAX_PROGRESS_BARS,
  dumbbell: MAX_DUMBBELL_ROWS,
  waterfall: MAX_WATERFALL_STEPS,
  funnel: MAX_FUNNEL_STAGES,
  gantt: MAX_GANTT_BARS,
  treemap: MAX_TREEMAP_TILES,
  gauge: MAX_GAUGES,
  bubble: MAX_BUBBLES,
  sankey: MAX_SANKEY_LINKS,
  'risk-matrix': MAX_RISKS,
}
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
    if (ys.length > 1 && type !== 'gantt' && type !== 'bubble') return { note: `${NOT_DRAWN} with series, y takes exactly one column.` }
    series = s
  }

  // What each type takes of y and series.
  if (type === 'heatmap' && (!series || ys.length !== 1)) return { note: `${NOT_DRAWN} a heatmap takes one y column and a series column for its rows.` }
  if ((type === 'pareto' || type === 'control') && (series || ys.length !== 1)) return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} takes one y column and no series.` }
  if (type === 'combo' && (series || ys.length < 2)) return { note: `${NOT_DRAWN} a combo chart takes 2 to ${MAX_CHART_Y} y columns (the first as bars, the rest as lines) and no series.` }
  if ((type === 'funnel' || type === 'waterfall') && (series || ys.length !== 1)) return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} takes one y column and no series.` }
  if (type === 'progress' && (series || ys.length > 2)) {
    return { note: `${NOT_DRAWN} a progress chart takes one y column (done, with goal as the target; or already a % of 100) or two (done, then its target), and no series.` }
  }
  if (type === 'dumbbell' && (series || ys.length !== 2)) return { note: `${NOT_DRAWN} a dumbbell chart takes exactly two y columns (the two values compared on each row) and no series.` }
  if (type === 'gantt' && ys.length !== 2) return { note: `${NOT_DRAWN} a gantt chart takes two y columns, each bar's start and end (dates), and optionally a series naming the bars.` }
  if (type === 'treemap' && ys.length !== 1) return { note: `${NOT_DRAWN} a treemap takes one y column (each tile's size), and optionally a series grouping the tiles.` }
  if ((type === 'histogram' || type === 'xbar-r' || type === 'box-plot' || type === 'c-chart' || type === 'calendar' || type === 'gauge') && (series || ys.length !== 1)) {
    return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} takes one y column and no series.` }
  }
  if (type === 'p-chart' && (series || ys.length !== 2)) return { note: `${NOT_DRAWN} a p-chart takes two y columns, the defective pieces and the pieces inspected of each sample, and no series.` }
  if (type === 'u-chart' && (series || ys.length !== 2)) return { note: `${NOT_DRAWN} a u-chart takes two y columns, the defects and the units inspected of each sample, and no series.` }
  if (type === 'bubble' && ys.length !== 2) return { note: `${NOT_DRAWN} a bubble chart takes two y columns: the height of each bubble, then its size; series (optional) names each bubble.` }
  if (type === 'sankey' && (!series || ys.length !== 1)) return { note: `${NOT_DRAWN} a sankey takes x (the stage a flow leaves), series (the stage it reaches) and one y (its quantity).` }
  if (type === 'risk-matrix' && (series || ys.length < 2 || ys.length > 3)) {
    return { note: `${NOT_DRAWN} a risk matrix takes y = [severity, occurrence] or [severity, occurrence, detection] and no series.` }
  }
  if (type === 'radar' && series && ys.length !== 1) return { note: `${NOT_DRAWN} with series, a radar chart takes one y column.` }

  const rows = result.rows
  if (rows.length === 0) return { note: `${NOT_DRAWN} the result has no rows.` }
  const most = MOST_ROWS[type]
  if (most !== undefined && rows.length > most) {
    return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} shows at most ${most} ${type === 'gantt' ? 'bars' : type === 'treemap' ? 'tiles' : 'rows'} and the result has ${rows.length}: keep the largest (or the first) and group the rest.` }
  }
  if (type === 'gantt') {
    const gantt = checkGantt(rows, x, ys, series)
    if (gantt) return { note: gantt }
    return finish(type, input, x, ys, series, result, [])
  }
  if (type === 'scatter' || type === 'bubble') {
    let numbers = 0
    for (const row of rows) {
      const v = row[x.index]
      if (v === null) continue
      if (typeof v !== 'number') return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]}'s x column "${x.name}" must be numeric (it holds ${JSON.stringify(cutChars(String(v), 40, true))}).` }
      numbers++
    }
    if (numbers < (type === 'bubble' ? 2 : 3)) return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} needs at least ${type === 'bubble' ? 2 : 3} points.` }
  }
  if (type === 'calendar') {
    for (const row of rows) {
      const v = row[x.index]
      const day = parseChartDate(v)
      if (!day || !day.dateOnly) return { note: `${NOT_DRAWN} a calendar's x column "${x.name}" must hold days (it holds ${JSON.stringify(cutChars(String(v), 40, true))}): select it as a date.` }
    }
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
  if (values < 2 && type !== 'gauge') return { note: `${NOT_DRAWN} a single figure is stated in words, not charted.` }
  if (!nonZero && type !== 'gauge' && type !== 'p-chart' && type !== 'u-chart') return { note: `${NOT_DRAWN} every value is 0.` }
  const own = valuesProblem(type, rows, ys, input.goal ?? undefined) ?? shapeProblem(type, rows, x, ys, series)
  if (own) return { note: own }
  if (series) {
    const n = distinct(rows, series.index)
    const most = type === 'heatmap' ? MAX_HEATMAP_ROWS : type === 'radar' ? MAX_RADAR_SHAPES : type === 'bubble' || type === 'sankey' ? Infinity : MAX_CHART_SERIES
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
  // One point per x (and series): two rows on one point would be drawn over each other, or summed out of sight. A
  // scatter's or a bubble chart's points may share an x, and a histogram, an X̄-R chart and a box plot hold many
  // readings of one subgroup or group.
  if (!REPEATS_X.has(type)) {
    const points = new Set(rows.map((r) => JSON.stringify([r[x.index] ?? null, series ? (r[series.index] ?? null) : null]))).size
    if (points < rows.length) {
      return {
        note: series
          ? `${NOT_DRAWN} rows repeat a pair of x "${x.name}" and series "${series.name}"; return one row per pair.`
          : `${NOT_DRAWN} rows repeat a value of x "${x.name}"; return one row per x, or name the column that tells them apart as series.`,
      }
    }
  }
  if ((type === 'control' || ATTRIBUTE.has(type)) && rows.length < MIN_CONTROL_POINTS) return { note: `${NOT_DRAWN} a ${TYPE_NAME[type]} needs at least ${MIN_CONTROL_POINTS} points for its limits.` }

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
  return finish(drawn, input, x, ys, series, result, notes)
}

/** The chart as it is drawn, with its title and goal, and what the model is told of it. */
function finish(
  drawn: AiChartType,
  input: z.infer<typeof ChartInput>,
  x: { name: string },
  ys: readonly { name: string }[],
  series: { name: string } | null,
  result: QueryPreview,
  notes: string[],
): ChartCheck {
  if (result.truncated) notes.push(`The chart shows only the ${result.rows.length} rows returned, not the whole result: aggregate further for a chart of all of it.`)
  const chart: AiChartSpec = { type: drawn, x: x.name, y: ys.map((y) => y.name) }
  if (series) chart.series = series.name
  const title = cutChars((input.title ?? '').replace(/\s+/g, ' ').trim(), MAX_CHART_TITLE_CHARS, true)
  if (title) chart.title = title
  if (typeof input.goal === 'number' && Number.isFinite(input.goal)) {
    if (drawn === 'progress' && ys.length === 2) notes.push('The goal is not used: each row has its own target (the second y column).')
    else if (TAKES_GOAL.has(drawn)) chart.goal = input.goal
    else notes.push(`The goal line is not drawn: a ${TYPE_NAME[drawn]} takes none.`)
  }
  const lsl = typeof input.lsl === 'number' && Number.isFinite(input.lsl) ? input.lsl : undefined
  const usl = typeof input.usl === 'number' && Number.isFinite(input.usl) ? input.usl : undefined
  if (lsl !== undefined || usl !== undefined) {
    if (!TAKES_SPEC.has(drawn)) notes.push(`The specification limits are not drawn: a ${TYPE_NAME[drawn]} takes none.`)
    else if (lsl !== undefined && usl !== undefined && !(lsl < usl)) notes.push('The specification limits are not drawn: lsl must be below usl.')
    else {
      if (lsl !== undefined) chart.lsl = lsl
      if (usl !== undefined) chart.usl = usl
    }
  }
  if (typeof input.max === 'number' && Number.isFinite(input.max)) {
    if (drawn !== 'gauge') notes.push(`max is not used: only a gauge takes a full scale.`)
    else if (!(input.max > 0)) notes.push("max is not used: a gauge's full scale must be above 0.")
    else chart.max = input.max
  }
  if (input.better) {
    const better = input.better.trim().toLowerCase()
    if (drawn !== 'gauge') notes.push('better is not used: only a gauge takes it.')
    else if (better === 'higher' || better === 'lower') chart.better = better
    else notes.push('better is not used: it is higher or lower.')
  }
  return notes.length > 0 ? { chart, note: notes.join(' ') } : { chart }
}

/**
 * What a type asks of its numbers beyond being numbers: a progress chart's
 * done figures not below zero and its targets above it; a funnel's stages
 * not below zero, the first above it; a treemap's tiles not below zero, two
 * of them above it. Null when they hold.
 */
function valuesProblem(type: AiChartType, rows: readonly AiCell[][], ys: readonly { index: number; name: string }[], goal: number | undefined): string | null {
  const column = (k: number) => rows.map((r) => r[ys[k].index]).filter((v): v is number => typeof v === 'number')
  if (type === 'progress') {
    if (column(0).some((v) => v < 0)) return `${NOT_DRAWN} a progress chart's done column "${ys[0].name}" cannot be below zero.`
    if (ys.length === 2) {
      const bad = rows.filter((r) => !(typeof r[ys[1].index] === 'number' && (r[ys[1].index] as number) > 0)).length
      if (bad > 0) return `${NOT_DRAWN} the target column "${ys[1].name}" must be above 0 on every row (${bad} ${bad === 1 ? 'row is' : 'rows are'} not): leave rows without a target out.`
    } else if (goal !== undefined && !(goal > 0)) {
      return `${NOT_DRAWN} a progress chart's goal (the target of every row) must be above 0.`
    }
  }
  if (type === 'funnel') {
    const stages = column(0)
    if (stages.some((v) => v < 0)) return `${NOT_DRAWN} a funnel's stages cannot be below zero.`
    if (rows.length < 2) return `${NOT_DRAWN} a funnel needs at least two stages.`
    if (!(typeof rows[0][ys[0].index] === 'number' && (rows[0][ys[0].index] as number) > 0)) return `${NOT_DRAWN} a funnel's first stage must be above 0: it is what the others are measured against.`
  }
  if (type === 'waterfall' && rows.length < 2) return `${NOT_DRAWN} a waterfall needs at least two steps.`
  if (type === 'treemap') {
    const tiles = column(0)
    if (tiles.some((v) => v < 0)) return `${NOT_DRAWN} a treemap's tiles are sizes: none can be below zero.`
    if (tiles.filter((v) => v > 0).length < 2) return `${NOT_DRAWN} a treemap needs at least two tiles above 0.`
  }
  return null
}

/**
 * What the newer kinds ask of the shape of their rows: an X̄-R chart's
 * subgroups of 2 to 10 readings, enough of them; a box plot's groups; a
 * p-chart's or a u-chart's counts within each other; a radar's axes; a
 * sankey's flows without a loop; a risk matrix's ratings on their scale.
 * Null when they hold.
 */
function shapeProblem(type: AiChartType, rows: readonly AiCell[][], x: { index: number; name: string }, ys: readonly { index: number; name: string }[], series: { index: number; name: string } | null): string | null {
  const num = (r: readonly AiCell[], k: number) => r[ys[k].index]
  const sizes = () => {
    const by = new Map<string, number>()
    for (const r of rows) if (typeof num(r, 0) === 'number') by.set(JSON.stringify(r[x.index] ?? null), (by.get(JSON.stringify(r[x.index] ?? null)) ?? 0) + 1)
    return by
  }
  if (type === 'histogram') {
    const n = rows.filter((r) => typeof num(r, 0) === 'number').length
    if (n < MIN_HISTOGRAM_READINGS) return `${NOT_DRAWN} a histogram needs at least ${MIN_HISTOGRAM_READINGS} readings (it has ${n}).`
  }
  if (type === 'xbar-r') {
    const by = sizes()
    const big = [...by.entries()].find(([, n]) => n > MAX_SUBGROUP_SIZE)
    if (big) return `${NOT_DRAWN} subgroup ${big[0]} has ${big[1]} readings; an X̄-R chart takes at most ${MAX_SUBGROUP_SIZE} per subgroup (take the first ${MAX_SUBGROUP_SIZE}, or use smaller subgroups).`
    const kept = [...by.values()].filter((n) => n >= 2).length
    if (kept < MIN_XBAR_SUBGROUPS) return `${NOT_DRAWN} an X̄-R chart needs at least ${MIN_XBAR_SUBGROUPS} subgroups of 2 or more readings (it has ${kept}): return one row per reading, x naming its subgroup.`
  }
  if (type === 'box-plot') {
    const by = sizes()
    if (by.size > MAX_BOX_GROUPS) return `${NOT_DRAWN} a box plot shows at most ${MAX_BOX_GROUPS} groups and x "${x.name}" has ${by.size}: keep the largest.`
    if (![...by.values()].some((n) => n >= 4)) return `${NOT_DRAWN} a box plot needs a group of at least 4 readings: return one row per reading, x naming its group.`
  }
  if (type === 'p-chart' || type === 'u-chart') {
    for (const r of rows) {
      const [d, n] = [num(r, 0), num(r, 1)]
      if (d === null || n === null) return `${NOT_DRAWN} every sample needs both its ${type === 'p-chart' ? 'defective pieces and pieces inspected' : 'defects and units'}; leave out a sample without them.`
      if (!((n as number) > 0)) return `${NOT_DRAWN} the ${type === 'p-chart' ? 'pieces inspected' : 'units'} ("${ys[1].name}") must be above 0 on every row.`
      if ((d as number) < 0) return `${NOT_DRAWN} "${ys[0].name}" cannot be below zero.`
      if (type === 'p-chart' && (d as number) > (n as number)) return `${NOT_DRAWN} a sample has more defective pieces than it inspected (${JSON.stringify(r[x.index])}); check the order of y (defective, then inspected).`
    }
  }
  if (type === 'c-chart' && rows.some((r) => typeof num(r, 0) === 'number' && (num(r, 0) as number) < 0)) return `${NOT_DRAWN} a c-chart's defects cannot be below zero.`
  if (type === 'radar') {
    const axes = distinct(rows, x.index)
    if (axes < MIN_RADAR_AXES || axes > MAX_RADAR_AXES) return `${NOT_DRAWN} a radar chart takes ${MIN_RADAR_AXES} to ${MAX_RADAR_AXES} axes (values of x "${x.name}"); it has ${axes}.`
    if (rows.some((r) => ys.some((_, k) => typeof num(r, k) === 'number' && (num(r, k) as number) < 0))) return `${NOT_DRAWN} a radar chart's values cannot be below zero: score them (0 to 100) in SQL.`
  }
  if (type === 'bubble' && rows.some((r) => typeof num(r, 1) === 'number' && (num(r, 1) as number) < 0)) return `${NOT_DRAWN} a bubble's size ("${ys[1].name}") cannot be below zero.`
  if (type === 'sankey' && series) {
    const name = (v: AiCell) => (v === null || v === undefined ? '' : String(v).trim())
    const out = new Map<string, Set<string>>()
    for (const r of rows) {
      const v = num(r, 0)
      if (typeof v === 'number' && v < 0) return `${NOT_DRAWN} a flow cannot be below zero.`
      const [a, b] = [name(r[x.index]), name(r[series.index])]
      if (!a || !b) return `${NOT_DRAWN} every flow needs the stage it leaves and the one it reaches.`
      if (a === b) return `${NOT_DRAWN} a flow from "${a}" to itself.`
      out.set(a, (out.get(a) ?? new Set()).add(b))
    }
    const nodes = new Set([...out.keys(), ...[...out.values()].flatMap((s) => [...s])])
    if (nodes.size > MAX_SANKEY_NODES) return `${NOT_DRAWN} a sankey shows at most ${MAX_SANKEY_NODES} stages and this one has ${nodes.size}: group the smallest.`
    // A loop has no first stage to draw it from.
    const state = new Map<string, 1 | 2>()
    const loops = (n: string): boolean => {
      state.set(n, 1)
      for (const m of out.get(n) ?? []) {
        if (state.get(m) === 1) return true
        if (!state.has(m) && loops(m)) return true
      }
      state.set(n, 2)
      return false
    }
    for (const n of nodes) if (!state.has(n) && loops(n)) return `${NOT_DRAWN} the flows go round in a loop (through "${n}"); a sankey runs one way: name a stage met twice apart (Rework, Re-inspection).`
  }
  if (type === 'risk-matrix') {
    for (const r of rows) {
      for (let k = 0; k < ys.length; k++) {
        const v = num(r, k)
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10) {
          return `${NOT_DRAWN} ${['severity', 'occurrence', 'detection'][k]} ("${ys[k].name}") must be a whole number from 1 to 10 on every row (${JSON.stringify(r[x.index])} has ${JSON.stringify(v)}).`
        }
      }
    }
  }
  return null
}

/**
 * A gantt's rows: each a bar from its start to its end, both dates or times
 * (the end not before the start); a row missing either is left out, but not
 * all of them. Several bars may share a row (x), so no row needs to be the
 * only one of its x; there are at most MAX_GANTT_ROWS rows. Null when it can
 * be drawn.
 */
function checkGantt(rows: readonly AiCell[][], x: { index: number; name: string }, ys: readonly { index: number; name: string }[], series: { index: number; name: string } | null): string | null {
  let bars = 0
  for (const row of rows) {
    const [a, b] = ys.map((y) => row[y.index])
    for (const [v, y] of [
      [a, ys[0]],
      [b, ys[1]],
    ] as const) {
      if (v !== null && !parseChartDate(v)) {
        return `${NOT_DRAWN} a gantt's ${y === ys[0] ? 'start' : 'end'} column "${y.name}" must hold dates or times (it holds ${JSON.stringify(cutChars(String(v), 40, true))}): select them as date or timestamp.`
      }
    }
    if (a === null || b === null) continue
    if (parseChartDate(b)!.ms < parseChartDate(a)!.ms) {
      return `${NOT_DRAWN} a gantt bar ends before it starts (${JSON.stringify(row[x.index])}: ${String(a)} to ${String(b)}); check the order of y (start, then end).`
    }
    bars++
  }
  if (bars === 0) return `${NOT_DRAWN} no row has both a start and an end.`
  const lanes = distinct(rows, x.index)
  if (lanes > MAX_GANTT_ROWS) return `${NOT_DRAWN} x "${x.name}" has ${lanes} values; a gantt shows at most ${MAX_GANTT_ROWS} rows. Keep the first or the largest.`
  void series
  return null
}
