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

describe('the quality charts and the other newer kinds', () => {
  const readings = (n: number, x = (i: number) => `S${i}`) => Array.from({ length: n }, (_, i) => [x(i), 2450 + ((i * 7) % 5) - 2])

  it('are offered to the model with what each takes, and named as the model may spell them', () => {
    const typeText = CHART_INPUT_SCHEMA.properties.type as { enum: string[]; description: string }
    for (const t of ['histogram', 'xbar-r', 'p-chart', 'u-chart', 'c-chart', 'box-plot', 'gauge', 'radar', 'bubble', 'sankey', 'calendar', 'risk-matrix']) {
      expect(typeText.enum).toContain(t)
      expect(typeText.description).toContain(`${t}`)
    }
    const r = result(['sample', 'length'], readings(30))
    expect(checkChart({ type: 'Capability', x: 'sample', y: ['length'] }, r).chart?.type).toBe('histogram')
    expect(checkChart({ type: 'spider chart', x: 'sample', y: ['length'] }, r).chart).toBeUndefined()
    expect(checkChart({ type: 'FMEA', x: 'm', y: ['s', 'o'] }, result(['m', 's', 'o'], [['Wavy', 7, 6], ['Twist', 5, 3]])).chart?.type).toBe('risk-matrix')
  })

  it('draws a histogram of readings with its limits and target, and needs enough of them', () => {
    expect(checkChart({ type: 'histogram', x: 'sample', y: ['length'], lsl: 2446, usl: 2454, goal: 2450 }, result(['sample', 'length'], readings(30)))).toEqual({
      chart: { type: 'histogram', x: 'sample', y: ['length'], lsl: 2446, usl: 2454, goal: 2450 },
    })
    expect(why({ type: 'histogram', x: 'sample', y: ['length'] }, result(['sample', 'length'], readings(6)))).toBe('Chart not drawn: a histogram needs at least 10 readings (it has 6).')
    expect(why({ type: 'histogram', x: 'sample', y: ['length'], lsl: 2454, usl: 2446 }, result(['sample', 'length'], readings(30)))).toBe('The specification limits are not drawn: lsl must be below usl.')
    expect(why({ type: 'bar', x: 'sample', y: ['length'], lsl: 1 }, result(['sample', 'length'], readings(3)))).toBe('The specification limits are not drawn: a bar chart takes none.')
  })

  it('draws an X̄-R chart of subgroups of 2 to 10 readings, at least five of them', () => {
    const groups = (n: number, size: number) => result(['session', 'length'], readings(n * size, (i) => `G${Math.floor(i / size)}`))
    expect(checkChart({ type: 'xbar-r', x: 'session', y: ['length'], goal: 2450 }, groups(6, 5)).chart).toEqual({ type: 'xbar-r', x: 'session', y: ['length'], goal: 2450 })
    expect(why({ type: 'xbar-r', x: 'session', y: ['length'] }, groups(3, 5))).toContain('needs at least 5 subgroups of 2 or more readings (it has 3)')
    expect(why({ type: 'xbar-r', x: 'session', y: ['length'] }, groups(6, 12))).toContain('subgroup "G0" has 12 readings; an X̄-R chart takes at most 10 per subgroup')
  })

  it('draws p-, u- and c-charts from counts, never more defective than inspected', () => {
    const days = Array.from({ length: 6 }, (_, i) => `2026-09-0${i + 1}`)
    const p = result(['day', 'rejected', 'inspected'], days.map((d, i) => [d, i + 1, 200]))
    expect(checkChart({ type: 'p-chart', x: 'day', y: ['rejected', 'inspected'] }, p).chart).toEqual({ type: 'p-chart', x: 'day', y: ['rejected', 'inspected'] })
    expect(why({ type: 'p-chart', x: 'day', y: ['inspected', 'rejected'] }, p)).toContain('a sample has more defective pieces than it inspected')
    expect(why({ type: 'p-chart', x: 'day', y: ['rejected'] }, p)).toBe('Chart not drawn: a p-chart takes two y columns, the defective pieces and the pieces inspected of each sample, and no series.')
    const zero = result(['day', 'rejected', 'inspected'], days.map((d, i) => [d, 1, i === 2 ? 0 : 100]))
    expect(why({ type: 'u-chart', x: 'day', y: ['rejected', 'inspected'] }, zero)).toBe('Chart not drawn: the units ("inspected") must be above 0 on every row.')
    // No defect at all is still a stable process on a p-chart.
    expect(checkChart({ type: 'p-chart', x: 'day', y: ['rejected', 'inspected'] }, result(['day', 'rejected', 'inspected'], days.map((d) => [d, 0, 100]))).chart?.type).toBe('p-chart')
    expect(why({ type: 'c-chart', x: 'day', y: ['rejected'] }, result(['day', 'rejected'], days.slice(0, 4).map((d) => [d, 2])))).toBe('Chart not drawn: a c-chart needs at least 5 points for its limits.')
  })

  it('draws box plots of groups, at most twelve', () => {
    const r = result(['machine', 'length'], readings(40, (i) => `M${i % 4}`))
    expect(checkChart({ type: 'box-plot', x: 'machine', y: ['length'], usl: 2454 }, r).chart).toEqual({ type: 'box-plot', x: 'machine', y: ['length'], usl: 2454 })
    expect(why({ type: 'box-plot', x: 'machine', y: ['length'] }, result(['machine', 'length'], readings(39, (i) => `M${i % 13}`)))).toContain('a box plot shows at most 12 groups')
  })

  it('draws a gauge of one figure (the only chart of a single number) with its scale and which way is good', () => {
    const one = result(['kpi', 'reject_pct'], [['Reject rate', 2.6]])
    expect(checkChart({ type: 'gauge', x: 'kpi', y: ['reject_pct'], goal: 2, max: 10, better: 'Lower' }, one)).toEqual({ chart: { type: 'gauge', x: 'kpi', y: ['reject_pct'], goal: 2, max: 10, better: 'lower' } })
    expect(why({ type: 'bar', x: 'kpi', y: ['reject_pct'] }, one)).toBe('Chart not drawn: a single figure is stated in words, not charted.')
    expect(why({ type: 'line', x: 'kpi', y: ['reject_pct'], max: 5, better: 'up' }, result(['kpi', 'reject_pct'], [['A', 1], ['B', 2]]))).toBe('max is not used: only a gauge takes a full scale. better is not used: only a gauge takes it.')
    expect(why({ type: 'gauge', x: 'kpi', y: ['reject_pct'] }, result(['kpi', 'reject_pct'], Array.from({ length: 7 }, (_, i) => [`K${i}`, i])))).toContain('a gauge shows at most 6 rows')
  })

  it('draws a radar of three to twelve axes, a bubble chart of three measures, and a calendar of days', () => {
    const scores = result(['measure', 'machine', 'score'], ['Quality', 'Output', 'OEE'].flatMap((m) => [[m, 'RF-01', 80], [m, 'RF-03', 60]]))
    expect(checkChart({ type: 'radar', x: 'measure', y: ['score'], series: 'machine' }, scores).chart).toEqual({ type: 'radar', x: 'measure', y: ['score'], series: 'machine' })
    expect(why({ type: 'radar', x: 'measure', y: ['score'], series: 'machine' }, result(['measure', 'machine', 'score'], [['Q', 'A', 1], ['O', 'A', 2]]))).toContain('a radar chart takes 3 to 12 axes')
    const machines = result(['machine', 'output', 'reject_pct', 'hours'], [['RF-01', 900, 1.6, 120], ['RF-02', 1700, 0.3, 80], ['RF-03', 2000, 2.8, -1]])
    expect(why({ type: 'bubble', x: 'output', y: ['reject_pct', 'hours'], series: 'machine' }, machines)).toBe('Chart not drawn: a bubble\'s size ("hours") cannot be below zero.')
    expect(checkChart({ type: 'bubble', x: 'output', y: ['reject_pct', 'hours'], series: 'machine' }, result(machines.columns, machines.rows.slice(0, 2))).chart?.type).toBe('bubble')
    expect(why({ type: 'bubble', x: 'machine', y: ['reject_pct', 'hours'] }, machines)).toContain('a bubble chart\'s x column "machine" must be numeric')
    expect(checkChart({ type: 'calendar', x: 'day', y: ['n'] }, result(['day', 'n'], [['2026-09-01', 3], ['2026-09-02', 5]])).chart?.type).toBe('calendar')
    expect(why({ type: 'calendar', x: 'day', y: ['n'] }, result(['day', 'n'], [['Mon', 3], ['Tue', 5]]))).toContain("a calendar's x column \"day\" must hold days")
  })

  it('draws a sankey of flows that run one way, and a risk matrix of ratings from 1 to 10', () => {
    const flows = result(['from_stage', 'to_stage', 'pieces'], [['Order A', 'RF-01', 100], ['RF-01', 'Passed', 90], ['RF-01', 'Rejected', 10]])
    expect(checkChart({ type: 'sankey', x: 'from_stage', y: ['pieces'], series: 'to_stage' }, flows).chart).toEqual({ type: 'sankey', x: 'from_stage', y: ['pieces'], series: 'to_stage' })
    const loop = result(flows.columns, [...flows.rows, ['Rejected', 'RF-01', 5]])
    expect(why({ type: 'sankey', x: 'from_stage', y: ['pieces'], series: 'to_stage' }, loop)).toContain('the flows go round in a loop')
    expect(why({ type: 'sankey', x: 'from_stage', y: ['pieces'] }, flows)).toContain('a sankey takes x (the stage a flow leaves), series (the stage it reaches)')
    const risks = result(['mode', 's', 'o', 'd'], [['Wavy edge', 7, 6, 4], ['Twist', 6, 4, 6]])
    expect(checkChart({ type: 'risk-matrix', x: 'mode', y: ['s', 'o', 'd'] }, risks).chart).toEqual({ type: 'risk-matrix', x: 'mode', y: ['s', 'o', 'd'] })
    expect(why({ type: 'risk-matrix', x: 'mode', y: ['s', 'o', 'd'] }, result(risks.columns, [['Wavy edge', 7, 6, 4], ['Twist', 11, 4, 6]]))).toBe(
      'Chart not drawn: severity ("s") must be a whole number from 1 to 10 on every row ("Twist" has 11).',
    )
    expect(why({ type: 'risk-matrix', x: 'mode', y: ['s'] }, risks)).toContain('a risk matrix takes y = [severity, occurrence]')
  })
})
