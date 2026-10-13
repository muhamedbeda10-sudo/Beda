import { describe, expect, it } from 'vitest'
import { AI_CHART_TYPES, parseChartDate } from '@qc/shared/ai'
import { CHART_INPUT_SCHEMA, MAX_GANTT_ROWS, MAX_PROGRESS_BARS, checkChart } from '../src/ai/charts'
import type { QueryPreview } from '../src/ai/runQuery'

// The charts for planning and production: progress toward a target, a
// funnel of stages, a waterfall of changes, a gantt of bars in time, a
// dumbbell of two values per row and a treemap of the parts of a whole —
// each checked against the result it is drawn from, as the older kinds are.

const result = (columns: string[], rows: QueryPreview['rows'], truncated = false): QueryPreview => ({ columns, rows, rowCount: rows.length, truncated })
const why = (chart: unknown, r: QueryPreview) => checkChart(chart, r).note

const orders = result(
  ['order_line', 'made', 'required', 'pct'],
  [
    ['20095-A', 1500, 2000, 75],
    ['20095-B', 2400, 2000, 120],
    ['20480-A', 0, 1350, 0],
  ],
)

describe('the planning and production charts', () => {
  it('are offered to the model with what each takes', () => {
    expect(AI_CHART_TYPES).toEqual(expect.arrayContaining(['progress', 'funnel', 'waterfall', 'gantt', 'dumbbell', 'treemap', 'scatter', 'heatmap']))
    const typeText = (CHART_INPUT_SCHEMA.properties.type as { enum: string[]; description: string })
    expect(typeText.enum).toEqual([...AI_CHART_TYPES])
    for (const t of ['progress:', 'funnel:', 'waterfall:', 'gantt:', 'dumbbell:', 'treemap:']) expect(typeText.description).toContain(t)
  })

  it('draws progress as done of a target: each row its own, one goal for all, or a percentage', () => {
    expect(checkChart({ type: 'progress', x: 'order_line', y: ['made', 'required'] }, orders)).toEqual({ chart: { type: 'progress', x: 'order_line', y: ['made', 'required'] } })
    expect(checkChart({ type: 'progress', x: 'order_line', y: ['made'], goal: 2000 }, orders)).toEqual({ chart: { type: 'progress', x: 'order_line', y: ['made'], goal: 2000 } })
    expect(checkChart({ type: 'progress', x: 'order_line', y: ['pct'] }, orders)).toEqual({ chart: { type: 'progress', x: 'order_line', y: ['pct'] } })
    // Each row's own target makes a goal pointless; a target of nothing measures nothing.
    expect(checkChart({ type: 'progress', x: 'order_line', y: ['made', 'required'], goal: 5 }, orders)).toEqual({
      chart: { type: 'progress', x: 'order_line', y: ['made', 'required'] },
      note: 'The goal is not used: each row has its own target (the second y column).',
    })
    const noTarget = result(['line', 'made', 'required'], [['A', 5, 10], ['B', 3, 0], ['C', 1, null]])
    expect(why({ type: 'progress', x: 'line', y: ['made', 'required'] }, noTarget)).toBe('Chart not drawn: the target column "required" must be above 0 on every row (2 rows are not): leave rows without a target out.')
    expect(why({ type: 'progress', x: 'order_line', y: ['made'], goal: 0 }, orders)).toBe("Chart not drawn: a progress chart's goal (the target of every row) must be above 0.")
    expect(why({ type: 'progress', x: 'order_line', y: ['made', 'required', 'pct'] }, orders)).toMatch(/^Chart not drawn: a progress chart takes one y column/)
    const negative = result(['line', 'made'], [['A', -1], ['B', 3]])
    expect(why({ type: 'progress', x: 'line', y: ['made'] }, negative)).toBe(`Chart not drawn: a progress chart's done column "made" cannot be below zero.`)
    const many = result(['line', 'pct'], Array.from({ length: MAX_PROGRESS_BARS + 1 }, (_, i) => [`L${i}`, i]))
    expect(why({ type: 'progress', x: 'line', y: ['pct'] }, many)).toMatch(/^Chart not drawn: a progress chart shows at most 30 rows and the result has 31/)
  })

  it('draws a funnel of stages and a waterfall of changes, each from one y', () => {
    const stages = result(['stage', 'pieces'], [['Required', 5000], ['Produced', 4600], ['Inspected', 4200], ['Passed', 4050]])
    expect(checkChart({ type: 'funnel', x: 'stage', y: ['pieces'] }, stages)).toEqual({ chart: { type: 'funnel', x: 'stage', y: ['pieces'] } })
    expect(why({ type: 'funnel', x: 'stage', y: ['pieces'] }, result(['stage', 'pieces'], [['Required', 0], ['Produced', 10]]))).toBe("Chart not drawn: a funnel's first stage must be above 0: it is what the others are measured against.")
    expect(why({ type: 'funnel', x: 'stage', y: ['pieces'] }, result(['stage', 'pieces'], [['A', 10], ['B', -1]]))).toBe("Chart not drawn: a funnel's stages cannot be below zero.")
    const steps = result(['step', 'change'], [['Planned', 5000], ['Downtime', -400], ['Defects', -150], ['Overtime', 120]])
    expect(checkChart({ type: 'waterfall', x: 'step', y: ['change'] }, steps)).toEqual({ chart: { type: 'waterfall', x: 'step', y: ['change'] } })
    expect(why({ type: 'waterfall', x: 'step', y: ['change'], series: 'step' }, steps)).toMatch(/^Chart not drawn: "step" is used twice/)
    expect(why({ type: 'waterfall', x: 'step', y: ['change', 'change'] }, steps)).toMatch(/is used twice/)
    expect(checkChart({ type: 'bridge', x: 'step', y: ['change'] }, steps).chart?.type).toBe('waterfall')
  })

  it('draws a gantt of bars in time: start and end dates, several bars to a row, never one ending before it starts', () => {
    const plan = result(
      ['order_line', 'from_day', 'to_day', 'kind'],
      [
        ['20095-A', '2026-10-05', '2026-10-09', 'Planned'],
        ['20095-A', '2026-10-06', '2026-10-12', 'Actual'],
        ['20480-A', '2026-10-07 08:00:00+03', '2026-10-08 16:30:00+03', 'Actual'],
        ['20480-B', null, '2026-10-08', 'Actual'],
      ],
    )
    expect(checkChart({ type: 'gantt', x: 'order_line', y: ['from_day', 'to_day'], series: 'kind', title: 'Plan and actual' }, plan)).toEqual({
      chart: { type: 'gantt', x: 'order_line', y: ['from_day', 'to_day'], series: 'kind', title: 'Plan and actual' },
    })
    expect(checkChart({ type: 'timeline', x: 'order_line', y: ['from_day', 'to_day'] }, plan).chart?.type).toBe('gantt')
    expect(why({ type: 'gantt', x: 'order_line', y: ['from_day'] }, plan)).toMatch(/^Chart not drawn: a gantt chart takes two y columns/)
    const backwards = result(['line', 'a', 'b'], [['X', '2026-10-09', '2026-10-01']])
    expect(why({ type: 'gantt', x: 'line', y: ['a', 'b'] }, backwards)).toBe('Chart not drawn: a gantt bar ends before it starts ("X": 2026-10-09 to 2026-10-01); check the order of y (start, then end).')
    const numbers = result(['line', 'a', 'b'], [['X', 3, 5]])
    expect(why({ type: 'gantt', x: 'line', y: ['a', 'b'] }, numbers)).toBe(`Chart not drawn: a gantt's start column "a" must hold dates or times (it holds "3"): select them as date or timestamp.`)
    expect(why({ type: 'gantt', x: 'line', y: ['a', 'b'] }, result(['line', 'a', 'b'], [['X', null, '2026-10-01']]))).toBe('Chart not drawn: no row has both a start and an end.')
    const lanes = result(['line', 'a', 'b'], Array.from({ length: MAX_GANTT_ROWS + 1 }, (_, i) => [`L${i}`, '2026-10-01', '2026-10-02']))
    expect(why({ type: 'gantt', x: 'line', y: ['a', 'b'] }, lanes)).toBe(`Chart not drawn: x "line" has 41 values; a gantt shows at most ${MAX_GANTT_ROWS} rows. Keep the first or the largest.`)
    expect(checkChart({ type: 'gantt', x: 'order_line', y: ['from_day', 'to_day'], goal: 3 }, plan).note).toBe('The goal line is not drawn: a gantt chart takes none.')
  })

  it('draws a dumbbell of two values a row, and a treemap of tiles, perhaps grouped', () => {
    const hours = result(['machine', 'planned_h', 'actual_h'], [['58', 40, 46.5], ['31', 32, 30]])
    expect(checkChart({ type: 'dumbbell', x: 'machine', y: ['planned_h', 'actual_h'], goal: 40 }, hours)).toEqual({ chart: { type: 'dumbbell', x: 'machine', y: ['planned_h', 'actual_h'], goal: 40 } })
    expect(why({ type: 'dumbbell', x: 'machine', y: ['planned_h'] }, hours)).toMatch(/^Chart not drawn: a dumbbell chart takes exactly two y columns/)
    const tiles = result(
      ['machine', 'factory', 'pieces'],
      [
        ['58', 'Factory 1', 1200],
        ['31', 'Factory 1', 800],
        ['48', 'Factory 2', 950],
      ],
    )
    expect(checkChart({ type: 'treemap', x: 'machine', y: ['pieces'], series: 'factory' }, tiles)).toEqual({ chart: { type: 'treemap', x: 'machine', y: ['pieces'], series: 'factory' } })
    expect(why({ type: 'treemap', x: 'machine', y: ['pieces'] }, result(['machine', 'pieces'], [['58', 5], ['31', -2]]))).toBe("Chart not drawn: a treemap's tiles are sizes: none can be below zero.")
    expect(why({ type: 'treemap', x: 'machine', y: ['pieces'] }, result(['machine', 'pieces'], [['58', 5], ['31', 0]]))).toBe('Chart not drawn: a treemap needs at least two tiles above 0.')
  })
})

describe('dates as a chart reads them', () => {
  it('reads days and times as the factory clock wrote them, and nothing else', () => {
    expect(parseChartDate('2026-10-13')).toEqual({ ms: Date.UTC(2026, 9, 13), dateOnly: true })
    expect(parseChartDate('2026-10-13 08:30:00+03')).toEqual({ ms: Date.UTC(2026, 9, 13, 8, 30), dateOnly: false })
    expect(parseChartDate('2026-10-13T08:30')).toEqual({ ms: Date.UTC(2026, 9, 13, 8, 30), dateOnly: false })
    expect(parseChartDate('2026-10-13 23:59:59.123456+03:00')?.ms).toBe(Date.UTC(2026, 9, 13, 23, 59, 59))
    for (const bad of ['2026-02-30', '2026-13-01', '13/10/2026', 'today', 5, null]) expect(parseChartDate(bad)).toBeNull()
  })
})
