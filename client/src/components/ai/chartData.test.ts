import { describe, expect, it } from 'vitest'
import type { AiCell, AiQueryPart } from '@qc/shared/ai'
import { AI_CHART_MAX_SERIES, AI_CHART_MAX_WIDTH, AI_CHART_MIN_WIDTH, aiChartWidth, axisOrder, chartFigure, chartLabels, humanizeColumn, queryChart, shapeChart, uniqueLabels } from './chartData'

describe('a chart from a query’s rows', () => {
  const columns = ['machine', 'defect_pieces', 'samples']
  const rows: AiCell[][] = [
    ['RF-01', 12, 40],
    ['RF-02', 7, 31],
    ['WL-03', 0, 12],
  ]

  it('draws one series per y column, the categories in the order the query returned them', () => {
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['defect_pieces', 'samples'], title: '  By machine ' }, columns, rows)).toEqual({
      type: 'bar',
      title: 'By machine',
      labels: ['RF-01', 'RF-02', 'WL-03'],
      series: [
        { label: 'defect pieces', values: [12, 7, 0] },
        { label: 'samples', values: [40, 31, 12] },
      ],
      unit: '',
      omitted: 0,
    })
  })

  it('turns a long result wide: a series per value of the split column, the largest first, gaps as null', () => {
    const long: AiCell[][] = [
      ['2026-09-01', 'RF-01', 3],
      ['2026-09-01', 'WL-03', 9],
      ['2026-09-02', 'RF-01', 4],
      ['2026-09-03', 'WL-03', 2],
      ['2026-09-03', null, 1],
    ]
    const model = shapeChart({ type: 'line', x: 'day', y: ['pieces'], series: 'machine' }, ['day', 'machine', 'pieces'], long)
    expect(model).toEqual({
      type: 'line',
      labels: ['Sep 1', 'Sep 2', 'Sep 3'],
      series: [
        { label: 'WL-03', values: [9, null, 2] },
        { label: 'RF-01', values: [3, 4, null] },
        { label: '(blank)', values: [null, null, 1] },
      ],
      unit: '',
      omitted: 0,
      measure: 'pieces',
      splitBy: 'machine',
    })
  })

  it('keeps apart the series the server tells apart, however alike they are written, rather than adding them up', () => {
    // The server lets these through: one point per day and raw value of the split column — null and "" are two, and so are "A" and "A ".
    const alike: AiCell[][] = [
      ['2026-09-01', 1, 'A'],
      ['2026-09-01', 2, null],
      ['2026-09-01', 3, ''],
      ['2026-09-01', 4, 'A '],
    ]
    const model = shapeChart({ type: 'line', x: 'day', y: ['v'], series: 's' }, ['day', 'v', 's'], alike)
    expect(model?.series).toEqual([
      { label: 'A (2)', values: [4] },
      { label: '(blank) (2)', values: [3] },
      { label: '(blank)', values: [2] },
      { label: 'A', values: [1] },
    ])
    // A number and its digits as text are two values too, along x as in the series.
    const mixed = shapeChart({ type: 'bar', x: 'code', y: ['n'] }, ['code', 'n'], [[1, 5], ['1', 7]])
    expect(mixed?.labels).toEqual(['1', '1 (2)'])
    expect(mixed?.series[0].values).toEqual([5, 7])
  })

  it('draws a long result along time in time’s order, whatever order its rows came in', () => {
    // Ordered by machine first, as a query often is: the days of the second machine come after the first's.
    const bySeriesFirst: AiCell[][] = [
      ['RF-01', '2026-09-01', 3],
      ['RF-01', '2026-09-03', 5],
      ['WL-03', '2026-09-02', 9],
      ['WL-03', '2026-09-03', 1],
    ]
    const model = shapeChart({ type: 'line', x: 'day', y: ['pieces'], series: 'machine' }, ['machine', 'day', 'pieces'], bySeriesFirst)
    expect(model?.labels).toEqual(['Sep 1', 'Sep 2', 'Sep 3'])
    expect(model?.series).toEqual([
      { label: 'WL-03', values: [null, 9, 1] },
      { label: 'RF-01', values: [3, null, 5] },
    ])
  })

  it('adds up a category met twice, and reads numbers written as text', () => {
    const model = shapeChart({ type: 'bar', x: 'machine', y: ['pieces'] }, ['machine', 'pieces'], [
      ['RF-01', '1,204'],
      ['RF-01', 6],
      ['RF-02', null],
    ])
    expect(model?.series).toEqual([{ label: 'pieces', values: [1210, null] }])
  })

  it('draws the largest series of many, and says how many were left out', () => {
    const many: AiCell[][] = Array.from({ length: 12 }, (_, i) => ['Sep', `M${i}`, i + 1])
    const model = shapeChart({ type: 'stacked-bar', x: 'month', y: ['pieces'], series: 'machine' }, ['month', 'machine', 'pieces'], many)
    expect(model?.series).toHaveLength(AI_CHART_MAX_SERIES)
    expect(model?.series[0].label).toBe('M11')
    expect(model?.omitted).toBe(12 - AI_CHART_MAX_SERIES)
  })

  it('draws a pie of a few slices, and bars when there are too many, more than one series or a figure below zero', () => {
    const few = shapeChart({ type: 'pie', x: 'machine', y: ['defect_pieces'] }, columns, rows)
    expect(few?.type).toBe('pie')
    const nine: AiCell[][] = Array.from({ length: 9 }, (_, i) => [`D${i}`, i + 1])
    expect(shapeChart({ type: 'pie', x: 'defect', y: ['pieces'] }, ['defect', 'pieces'], nine)?.type).toBe('bar')
    expect(shapeChart({ type: 'pie', x: 'machine', y: ['defect_pieces', 'samples'] }, columns, rows)?.type).toBe('bar')
    expect(shapeChart({ type: 'pie', x: 'machine', y: ['change'] }, ['machine', 'change'], [['RF-01', 3], ['RF-02', -2]])?.type).toBe('bar')
  })

  it('draws figures below zero as the server let them through: bars and lines across zero, a stack side by side', () => {
    const change: AiCell[][] = [
      ['RF-01', 3, 1],
      ['RF-02', -2, 4],
    ]
    const bars = shapeChart({ type: 'bar', x: 'machine', y: ['change'] }, ['machine', 'change', 'other'], change)
    expect(bars).toMatchObject({ type: 'bar', series: [{ label: 'change', values: [3, -2] }] })
    expect(shapeChart({ type: 'line', x: 'machine', y: ['change'] }, ['machine', 'change', 'other'], change)?.type).toBe('line')
    // A stack cannot add up across zero.
    expect(shapeChart({ type: 'stacked-bar', x: 'machine', y: ['change', 'other'] }, ['machine', 'change', 'other'], change)?.type).toBe('bar')
    expect(shapeChart({ type: 'stacked-bar', x: 'machine', y: ['other'] }, ['machine', 'change', 'other'], change)?.type).toBe('stacked-bar')
  })

  it('draws as many categories as the result holds', () => {
    const crowd: AiCell[][] = Array.from({ length: 200 }, (_, i) => [`C${i}`, i + 1])
    expect(shapeChart({ type: 'bar', x: 'c', y: ['n'] }, ['c', 'n'], crowd)?.labels).toHaveLength(200)
  })

  it('takes percentages by the y column’s name', () => {
    expect(shapeChart({ type: 'line', x: 'machine', y: ['reject_rate_pct'] }, ['machine', 'reject_rate_pct'], [['RF-01', 1.2]])?.unit).toBe('%')
    expect(shapeChart({ type: 'line', x: 'machine', y: ['share %', 'pieces'] }, ['machine', 'share %', 'pieces'], [['RF-01', 1.2, 3]])?.unit).toBe('')
  })

  it('draws nothing it cannot draw at all', () => {
    // A column it names is missing; the split column is missing.
    expect(shapeChart({ type: 'bar', x: 'nope', y: ['samples'] }, columns, rows)).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['nope'] }, columns, rows)).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['samples'], series: 'nope' }, columns, rows)).toBeNull()
    // A value that is not a number.
    expect(shapeChart({ type: 'bar', x: 'samples', y: ['machine'] }, columns, rows)).toBeNull()
    // Nothing at all; bars of nothing (a line along zero still says something).
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['samples'] }, columns, [])).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', null]])).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', 0]])).toBeNull()
    expect(shapeChart({ type: 'line', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', 0]])?.type).toBe('line')
    // No spec.
    expect(shapeChart(undefined, columns, rows)).toBeNull()
  })

  it('takes a y column named twice once, and at most four', () => {
    const cols = ['x', 'a', 'b', 'c', 'd', 'e']
    const model = shapeChart({ type: 'bar', x: 'x', y: ['a', 'a', 'b', 'c', 'd', 'e'] }, cols, [['k', 1, 2, 3, 4, 5]])
    expect(model?.series.map((s) => s.label)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('charts a query only when it worked and asked for a chart', () => {
    const part: AiQueryPart = { type: 'query', queryId: 'q', purpose: 'p', sql: 's', ok: true, columns, rows, rowCount: 3, truncated: false, ms: 1 }
    expect(queryChart(part)).toBeNull()
    expect(queryChart({ ...part, chart: { type: 'bar', x: 'machine', y: ['samples'] } })?.series[0].values).toEqual([40, 31, 12])
    expect(queryChart({ ...part, ok: false, chart: { type: 'bar', x: 'machine', y: ['samples'] } })).toBeNull()
  })
})

describe('the labels along x', () => {
  it('writes days and months as the dashboard does, with the year when they span more than one', () => {
    expect(chartLabels(['2026-09-01', '2026-09-02 00:00:00+03', '2026-09-03T00:00:00.000Z'])).toEqual(['Sep 1', 'Sep 2', 'Sep 3'])
    expect(chartLabels(['2025-12-31', '2026-01-01'])).toEqual(['Dec 31, 2025', 'Jan 1, 2026'])
    expect(chartLabels(['2026-08', '2026-09', null])).toEqual(['Aug', 'Sep', '(blank)'])
    expect(chartLabels(['2025-12', '2026-01'])).toEqual(['Dec 2025', 'Jan 2026'])
  })

  it('writes the first days of several months as those months', () => {
    expect(chartLabels(['2026-07-01', '2026-08-01 00:00:00+03', '2026-09-01T00:00:00Z'])).toEqual(['Jul', 'Aug', 'Sep'])
    expect(chartLabels(['2025-12-01', '2026-01-01'])).toEqual(['Dec 2025', 'Jan 2026'])
    // One first of a month is a day; so are firsts among other days.
    expect(chartLabels(['2026-09-01'])).toEqual(['Sep 1'])
    expect(chartLabels(['2026-09-01', '2026-09-02'])).toEqual(['Sep 1', 'Sep 2'])
  })

  it('writes anything else as it is: numbers, yes and no, blanks', () => {
    expect(chartLabels([2026, true, false, '', ' RF-01 ', '2026-09-01 10:30:00+03'])).toEqual(['2026', 'Yes', 'No', '(blank)', 'RF-01', '2026-09-01 10:30:00+03'])
  })

  it('makes labels unique, as the charts key their marks by them', () => {
    expect(uniqueLabels(['Sep 1', 'Sep 1', 'A', 'Sep 1'])).toEqual(['Sep 1', 'Sep 1 (2)', 'A', 'Sep 1 (3)'])
  })

  it('names a column as a legend shows it', () => {
    expect(humanizeColumn('defect_pieces')).toBe('defect pieces')
    expect(humanizeColumn('__')).toBe('__')
    expect(humanizeColumn('عدد_القطع')).toBe('عدد القطع')
  })
})

describe('the order of the points along x', () => {
  it('puts days and months in time’s order, blanks last, and leaves an order already right alone', () => {
    expect(axisOrder(['2026-09-03', '2026-09-01', null, '2026-09-02'], 'bar')).toEqual([1, 3, 0, 2])
    expect(axisOrder(['2026-08', '2026-07'], 'line')).toEqual([1, 0])
    expect(axisOrder(['2026-09-01', '2026-09-02'], 'line')).toBeNull()
  })

  it('puts numbers in order along a line, and leaves bars of categories as the query ordered them', () => {
    expect(axisOrder([3, 1, 2], 'line')).toEqual([1, 2, 0])
    expect(axisOrder([3, 1, 2], 'bar')).toBeNull()
    expect(axisOrder(['RF-02', 'RF-01'], 'line')).toBeNull()
  })
})

describe('the figures a chart writes', () => {
  it('groups thousands, as the answer and its cards write them, to two decimals at most', () => {
    expect(chartFigure(1284)).toBe('1,284')
    expect(chartFigure(-1250)).toBe('-1,250')
    expect(chartFigure(3750)).toBe('3,750')
    expect(chartFigure(1234.5678)).toBe('1,234.57')
    expect(chartFigure(1.29)).toBe('1.29')
  })

  it('writes a figure below one to three significant digits: never 0 for a small one, and small steps apart', () => {
    expect(chartFigure(0.0012)).toBe('0.0012')
    expect([0, 0.005, 0.01, 0.015, 0.02].map(chartFigure)).toEqual(['0', '0.005', '0.01', '0.015', '0.02'])
    expect(chartFigure(-0.0012)).toBe('-0.0012')
    // Floating point's hairs are not figures; zero is never "-0".
    expect(chartFigure(0.1 + 0.2)).toBe('0.3')
    expect(chartFigure(-0)).toBe('0')
  })
})

describe('the width a chart is drawn at', () => {
  it('is the width it is shown at, within bounds, in steps of 20', () => {
    expect(aiChartWidth(421)).toBe(420)
    expect(aiChartWidth(1060)).toBe(AI_CHART_MAX_WIDTH)
    expect(aiChartWidth(300)).toBe(AI_CHART_MIN_WIDTH)
    expect(aiChartWidth(null)).toBe(720)
    expect(aiChartWidth(0)).toBe(720)
  })
})
