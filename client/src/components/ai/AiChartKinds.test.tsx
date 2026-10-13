import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiCell, AiChartSpec } from '@qc/shared/ai'
import { AiChart } from './AiChart'
import { rangeAxis } from './AiChartKinds'
import { shapeChart } from './chartData'

// Every kind of chart the assistant draws, drawn to a string as on a server: each must come out as a drawing,
// with what makes it that kind (its axes' names, its limits, its target).

const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']
const draw = (spec: AiChartSpec, columns: string[], rows: AiCell[][]) => {
  const model = shapeChart(spec, columns, rows)
  expect(model, spec.type).not.toBeNull()
  return renderToStaticMarkup(<AiChart model={model!} />)
}

describe('the assistant’s charts, each kind drawn', () => {
  const byMachine: AiCell[][] = [
    ['58. Welding', 12, 40],
    ['31. Forming', 7, 22],
    ['12. Paint', 3, 15],
  ]
  const machines = ['machine', 'defects', 'samples']

  it('draws bars, lying bars and stacks, with a target where asked', () => {
    expect(draw({ type: 'bar', x: 'machine', y: ['defects'], goal: 10 }, machines, byMachine)).toContain('Target 10')
    const lying = draw({ type: 'horizontal-bar', x: 'machine', y: ['defects', 'samples'], goal: 20 }, machines, byMachine)
    expect(lying).toContain('58. Welding')
    expect(lying).toContain('Target 20')
    expect(draw({ type: 'stacked-bar-100', x: 'machine', y: ['defects', 'samples'] }, machines, byMachine)).toContain('%')
  })

  it('draws lines, stacked areas and a combo of bars and lines', () => {
    const rows = days.map((d, i) => [d, 100 + i * 10, 1 + (i % 3) * 0.5, 20 + i])
    const cols = ['day', 'produced', 'reject_pct', 'held']
    expect(draw({ type: 'line', x: 'day', y: ['produced'], goal: 120 }, cols, rows)).toContain('Target 120')
    expect(draw({ type: 'stacked-area', x: 'day', y: ['produced', 'held'] }, cols, rows)).toContain('<polygon')
    const combo = draw({ type: 'combo', x: 'day', y: ['produced', 'reject_pct'], goal: 2 }, cols, rows)
    expect(combo).toContain('Target 2%')
    expect(combo).toContain('reject pct')
  })

  it('draws a Pareto, a scatter with its trend, a heatmap and a control chart', () => {
    const pareto = draw({ type: 'pareto', x: 'defect', y: ['pieces'] }, ['defect', 'pieces'], [['Scratch', 5], ['Dent', 30], ['Burr', 15]])
    expect(pareto).toContain('Cumulative share')
    const scatter = draw({ type: 'scatter', x: 'thickness', y: ['rejects'] }, ['thickness', 'rejects'], [[1.5, 3], [2, 5], [2.5, 6], [3, 9]])
    expect(scatter).toContain('Trend · r = 0.98')
    expect(scatter).toContain('thickness')
    const heat = draw(
      { type: 'heatmap', x: 'day', y: ['n'], series: 'machine' },
      ['day', 'machine', 'n'],
      days.flatMap((d, i) => [[d, '58', i], [d, '31', 6 - i]]),
    )
    expect(heat).toContain('Less')
    const control = draw({ type: 'control', x: 'day', y: ['len'] }, ['day', 'len'], days.map((d, i) => [d, i === 5 ? 2480 : 2450 + (i % 2)]))
    expect(control).toContain('UCL')
    expect(control).toContain('LCL')
    expect(control).toMatch(/In control|outside the limits/)
  })

  it('fits a value axis to the figures themselves for scatters and control charts', () => {
    expect(rangeAxis(2440, 2460)).toEqual({ min: 2440, max: 2460, steps: 4 })
    expect(rangeAxis(5, 5).min).toBeLessThan(5)
    const a = rangeAxis(0.12, 0.87)
    expect(a.min).toBeLessThanOrEqual(0.12)
    expect(a.max).toBeGreaterThanOrEqual(0.87)
    expect(a.steps).toBeLessThanOrEqual(5)
  })
})
