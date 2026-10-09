import { describe, expect, it } from 'vitest'
import type { AiCell, AiQueryPart } from '@qc/shared/ai'
import { AI_BAR_MAX_CATEGORIES, AI_CHART_MAX_SERIES, chartLabels, humanizeColumn, queryChart, shapeChart, uniqueLabels } from './chartData'

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
    })
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

  it('draws a pie of a few slices, and bars when there are too many or more than one series', () => {
    const few = shapeChart({ type: 'pie', x: 'machine', y: ['defect_pieces'] }, columns, rows)
    expect(few?.type).toBe('pie')
    const nine: AiCell[][] = Array.from({ length: 9 }, (_, i) => [`D${i}`, i + 1])
    expect(shapeChart({ type: 'pie', x: 'defect', y: ['pieces'] }, ['defect', 'pieces'], nine)?.type).toBe('bar')
    expect(shapeChart({ type: 'pie', x: 'machine', y: ['defect_pieces', 'samples'] }, columns, rows)?.type).toBe('bar')
  })

  it('takes percentages by the y column’s name', () => {
    expect(shapeChart({ type: 'line', x: 'machine', y: ['reject_rate_pct'] }, ['machine', 'reject_rate_pct'], [['RF-01', 1.2]])?.unit).toBe('%')
    expect(shapeChart({ type: 'line', x: 'machine', y: ['share %', 'pieces'] }, ['machine', 'share %', 'pieces'], [['RF-01', 1.2, 3]])?.unit).toBe('')
  })

  it('draws nothing it cannot draw honestly', () => {
    // A column it names is missing; the split column is missing.
    expect(shapeChart({ type: 'bar', x: 'nope', y: ['samples'] }, columns, rows)).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['nope'] }, columns, rows)).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['samples'], series: 'nope' }, columns, rows)).toBeNull()
    // A value that is not a number; a figure below zero.
    expect(shapeChart({ type: 'bar', x: 'samples', y: ['machine'] }, columns, rows)).toBeNull()
    expect(shapeChart({ type: 'line', x: 'machine', y: ['delta'] }, ['machine', 'delta'], [['RF-01', 3], ['RF-02', -1]])).toBeNull()
    // Nothing at all; bars of nothing (a line along zero still says something).
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['samples'] }, columns, [])).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', null]])).toBeNull()
    expect(shapeChart({ type: 'bar', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', 0]])).toBeNull()
    expect(shapeChart({ type: 'line', x: 'machine', y: ['n'] }, ['machine', 'n'], [['RF-01', 0]])?.type).toBe('line')
    // More categories than bars can show.
    const crowd: AiCell[][] = Array.from({ length: AI_BAR_MAX_CATEGORIES + 1 }, (_, i) => [`C${i}`, 1])
    expect(shapeChart({ type: 'bar', x: 'c', y: ['n'] }, ['c', 'n'], crowd)).toBeNull()
    expect(shapeChart({ type: 'line', x: 'c', y: ['n'] }, ['c', 'n'], crowd)?.labels).toHaveLength(AI_BAR_MAX_CATEGORIES + 1)
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
