import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiCell, AiChartSpec } from '@qc/shared/ai'
import { AiChart } from './AiChart'
import { ganttTicks, lastsText, percentText, squarify, wallText } from './AiPlanCharts'
import { shapeChart } from './chartData'

// The planning and production charts: shaped from a query's rows, and each drawn to a string as on a server —
// with what makes it that kind (its shares, its stages, its total, its days, its difference, its tiles).

const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

const shape = (spec: AiChartSpec, columns: string[], rows: AiCell[][]) => shapeChart(spec, columns, rows)
const draw = (spec: AiChartSpec, columns: string[], rows: AiCell[][]) => {
  const model = shape(spec, columns, rows)
  expect(model, spec.type).not.toBeNull()
  return renderToStaticMarkup(<AiChart model={model!} />)
}
/** The drawing's words, tags and entities out of the way. */
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const orders: AiCell[][] = [
  ['20095-A', 1500, 2000],
  ['20095-B', 2400, 2000],
  ['20480-A', 0, 1350],
]

describe('the planning charts shaped', () => {
  it('takes a progress chart’s targets from each row, the goal, or 100 for percentages', () => {
    const own = shape({ type: 'progress', x: 'line', y: ['made', 'required'] }, ['line', 'made', 'required'], orders)!
    expect(own.targets).toEqual([2000, 2000, 1350])
    expect(own.series.map((s) => s.label)).toEqual(['made'])
    expect(own.percentMode).toBe(false)
    const goal = shape({ type: 'progress', x: 'line', y: ['made'], goal: 2500 }, ['line', 'made', 'required'], orders)!
    expect(goal.targets).toEqual([2500, 2500, 2500])
    const pct = shape({ type: 'progress', x: 'line', y: ['done_pct'] }, ['line', 'done_pct'], [['A', 75], ['B', 40]])!
    expect(pct).toMatchObject({ percentMode: true, unit: '%', targets: [100, 100] })
  })

  it('makes a gantt’s bars: each row a bar on its x’s row, a day ending at its end, names in the order met', () => {
    const model = shape(
      { type: 'gantt', x: 'line', y: ['from_day', 'to_day'], series: 'kind' },
      ['line', 'from_day', 'to_day', 'kind'],
      [
        ['20095-A', '2026-10-05', '2026-10-09', 'Planned'],
        ['20095-A', '2026-10-06', '2026-10-12', 'Actual'],
        ['20480-A', '2026-10-07', '2026-10-08', 'Actual'],
        ['20480-B', null, '2026-10-08', 'Actual'],
      ],
    )!
    expect(model.labels).toEqual(['20095-A', '20480-A'])
    expect(model.gantt).toMatchObject({ names: ['Planned', 'Actual'], dateOnly: true, min: Date.UTC(2026, 9, 5), max: Date.UTC(2026, 9, 13) })
    expect(model.gantt!.bars.map((b) => [b.lane, b.name, b.color])).toEqual([
      [0, 'Planned', 0],
      [0, 'Actual', 1],
      [1, 'Actual', 1],
    ])
    expect(lastsText(model.gantt!.bars[0].start, model.gantt!.bars[0].end, true)).toBe('5 days')
    expect(shape({ type: 'gantt', x: 'line', y: ['a', 'b'] }, ['line', 'a', 'b'], [['X', 3, 5]])).toBeNull()
  })
})

describe('the planning charts drawn', () => {
  it('draws progress with each share and the overall, green once reached', () => {
    const html = draw({ type: 'progress', x: 'line', y: ['made', 'required'] }, ['line', 'made', 'required'], orders)
    expect(words(html)).toContain('75% · 1,500 of 2,000')
    expect(words(html)).toContain('120% · 2,400 of 2,000')
    expect(words(html)).toContain('Overall 73% · 3,900 of 5,350')
    expect(words(html)).toContain('1 of 3 reached')
    expect(html).toContain('fill-emerald-500')
  })

  it('draws a funnel with each stage’s share of the first and what it kept', () => {
    const t = words(draw({ type: 'funnel', x: 'stage', y: ['pieces'] }, ['stage', 'pieces'], [['Required', 5000], ['Produced', 4600], ['Passed', 4050]]))
    expect(t).toContain('Required')
    expect(t).toContain('92%')
    expect(t).toContain('↓ 88% kept')
  })

  it('draws a waterfall from its start, its changes signed, to the total it adds', () => {
    const t = words(draw({ type: 'waterfall', x: 'step', y: ['change'] }, ['step', 'change'], [['Planned', 5000], ['Downtime', -400], ['Defects', -150], ['Overtime', 120]]))
    expect(t).toContain('5,000')
    expect(t).toContain('-400')
    expect(t).toContain('+120')
    expect(t).toContain('Total')
    expect(t).toContain('4,570')
  })

  it('draws a gantt on a time axis, its bars named, plan and actual on lanes of their own', () => {
    const html = draw(
      { type: 'gantt', x: 'line', y: ['from_day', 'to_day'], series: 'kind' },
      ['line', 'from_day', 'to_day', 'kind'],
      [
        ['20095-A', '2026-10-05', '2026-10-09', 'Planned'],
        ['20095-A', '2026-10-06', '2026-10-12', 'Actual'],
      ],
    )
    expect(words(html)).toContain('20095-A · Planned: Oct 5 → Oct 9 (5 days)')
    expect(words(html)).toContain('Actual')
    expect(words(html)).toContain('Oct 7')
  })

  it('draws a dumbbell with the difference on each row, and a treemap of grouped tiles', () => {
    const bell = words(draw({ type: 'dumbbell', x: 'machine', y: ['planned_h', 'actual_h'] }, ['machine', 'planned_h', 'actual_h'], [['58', 40, 46.5], ['31', 32, 30]]))
    expect(bell).toContain('+6.5')
    expect(bell).toContain('-2')
    expect(bell).toContain('Difference: actual h − planned h')
    const tree = words(
      draw({ type: 'treemap', x: 'machine', y: ['pieces'], series: 'factory' }, ['machine', 'factory', 'pieces'], [['58', 'Factory 1', 1200], ['31', 'Factory 1', 800], ['48', 'Factory 2', 950]]),
    )
    expect(tree).toContain('Factory 1 2,000 · 68%')
    expect(tree).toContain('Total 2,950')
  })
})

describe('the planning charts’ arithmetic', () => {
  it('lays tiles in proportion, filling the box', () => {
    const boxes = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 600, h: 400 })
    const area = boxes.reduce((t, b) => t + b.w * b.h, 0)
    expect(area).toBeCloseTo(600 * 400, 3)
    expect((boxes[0].w * boxes[0].h) / area).toBeCloseTo(6 / 24, 5)
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(-1e-9)
      expect(b.x + b.w).toBeLessThanOrEqual(600 + 1e-6)
      expect(b.y + b.h).toBeLessThanOrEqual(400 + 1e-6)
    }
    expect(squarify([0, 5], { x: 0, y: 0, w: 10, h: 10 })[0]).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('marks a time axis in steps that fit, and writes times and spans as words', () => {
    const day = 86_400_000
    const week = ganttTicks(Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12), true, 600)
    expect(week[0]).toEqual({ at: Date.UTC(2026, 9, 5), text: 'Oct 5' })
    expect(week.length).toBeLessThanOrEqual(10)
    const months = ganttTicks(Date.UTC(2026, 0, 10), Date.UTC(2026, 11, 20), true, 600)
    expect(months.map((t) => t.text)).toContain('Jul')
    const hours = ganttTicks(Date.UTC(2026, 9, 5, 6), Date.UTC(2026, 9, 5, 18), false, 600)
    expect(hours.map((t) => t.text)).toContain('12:00')
    expect(wallText(Date.UTC(2026, 9, 7, 8, 5), true)).toBe('Oct 7, 08:05')
    expect(lastsText(0, 7.5 * 3_600_000, false)).toBe('7.5 h')
    expect(lastsText(0, 3 * day + 2 * 3_600_000, false)).toBe('3 d 2 h')
    expect(percentText(7.46)).toBe('7.5%')
    expect(percentText(68.2)).toBe('68%')
  })
})
