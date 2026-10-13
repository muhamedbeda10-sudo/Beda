import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ColumnChart, DonutChart, GroupedBarChart, HorizontalBars, LineChart, PairedBarChart, ParetoChart, PieChart, StackedColumnChart, TrendChart } from './charts'
import { ChartOnly, FigureScope, shareOf, type FigureScopeValue } from './figureView'

// Every chart offers its figures as a table: on its own it carries a Chart / Table switch, inside a card the card's
// one switch decides — and each chart's table holds the rows and columns of what it draws, in its own words.

const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

const asTable: FigureScopeValue = { view: 'table', register: () => () => undefined }
const html = (node: ReactNode) => renderToStaticMarkup(node)
/** A table's cells, row by row, as text. */
function cells(markup: string): string[][] {
  const rows = [...markup.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')))
  return rows
}
const table = (node: ReactNode) => cells(html(<FigureScope scope={asTable}>{node}</FigureScope>))

describe('a chart on its own', () => {
  it('carries its own switch, the chart shown first', () => {
    const out = html(<ColumnChart columns={[{ label: 'Mon', value: 3 }, { label: 'Tue', value: 5 }]} />)
    expect(out).toContain('aria-label="Show as"')
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*?Chart/)
    expect(out).toContain('<svg')
  })

  it('shows no switch inside a card that has one, nor where the figures are shown another way', () => {
    const scoped: FigureScopeValue = { view: 'chart', register: () => () => undefined }
    expect(html(<FigureScope scope={scoped}><ColumnChart columns={[{ label: 'Mon', value: 3 }]} /></FigureScope>)).not.toContain('Show as')
    expect(html(<ChartOnly><ColumnChart columns={[{ label: 'Mon', value: 3 }]} /></ChartOnly>)).not.toContain('Show as')
  })
})

describe('each chart’s table', () => {
  it('holds a trend’s bars, its line and its other lines, a row a point', () => {
    expect(
      table(<TrendChart points={[{ label: 'Sep', bar: 1200, line: 2.5 }, { label: 'Oct', bar: 900, line: null }]} barLabel="Pieces made" lineLabel="Reject rate" lines={[{ label: 'Factory 1', values: [1.25, 3], className: '' }]} />),
    ).toEqual([
      ['', 'Pieces made', 'Reject rate', 'Factory 1'],
      ['Sep', '1,200', '2.5%', '1.25%'],
      ['Oct', '900', '—', '3%'],
    ])
  })

  it('holds a Pareto’s causes with their running share, and a pie’s slices with their shares', () => {
    expect(table(<ParetoChart valueLabel="Pieces" bars={[{ label: 'Scratch', value: 30, cumulativePct: 60 }, { label: 'Dent', value: 20, cumulativePct: 100 }]} />)).toEqual([
      ['', 'Pieces', 'Cumulative'],
      ['Scratch', '30', '60%'],
      ['Dent', '20', '100%'],
    ])
    expect(table(<PieChart centerLabel="rejected" slices={[{ label: 'Factory 1', value: 3, className: '' }, { label: 'Factory 2', value: 1, className: '' }]} />)).toEqual([
      ['', 'Rejected', 'Share'],
      ['Factory 1', '3', '75%'],
      ['Factory 2', '1', '25%'],
    ])
    expect(table(<DonutChart centerLabel="samples" slices={[{ label: 'OK', value: 9, className: '' }, { label: 'NG', value: 1, className: '' }]} />)[2]).toEqual(['NG', '1', '10%'])
  })

  it('holds stacks with their totals, grouped bars and lines a series a column, and paired bars with the share', () => {
    expect(
      table(
        <StackedColumnChart
          columns={[{ label: '58', segments: [{ label: 'Scratch', value: 2, className: '' }, { label: 'Dent', value: 3, className: '' }] }]}
          legend={[{ label: 'Scratch', className: '' }, { label: 'Dent', className: '' }, { label: 'Burr', className: '' }]}
        />,
      ),
    ).toEqual([
      ['', 'Scratch', 'Dent', 'Burr', 'Total'],
      ['58', '2', '3', '—', '5'],
    ])
    expect(table(<GroupedBarChart labels={['58', '31']} series={[{ label: 'This month', values: [4, null], className: '' }]} unit="%" />)).toEqual([
      ['', 'This month'],
      ['58', '4%'],
      ['31', '—'],
    ])
    expect(table(<LineChart labels={['Sep']} series={[{ label: 'Welding', values: [1.5], className: '' }]} />)[1]).toEqual(['Sep', '1.5%'])
    expect(table(<PairedBarChart points={[{ label: 'Oct 1', total: 200, part: 5 }]} totalLabel="Pieces inspected" partLabel="Defect pieces" />)).toEqual([
      ['', 'Pieces inspected', 'Defect pieces', 'Share'],
      ['Oct 1', '200', '5', '2.5%'],
    ])
  })

  it('holds a list of bars with their words, and columns with what is under them', () => {
    expect(table(<HorizontalBars unit="%" rows={[{ label: 'Supplier A', sub: 'coils', value: 2.5, tone: 'green', text: '2.5% · 3 of 120' }]} />)).toEqual([
      ['', 'Value', 'Detail'],
      ['Supplier A · coils', '2.5%', '2.5% · 3 of 120'],
    ])
    expect(table(<ColumnChart columns={[{ label: 'Mon', value: 3, sub: '120 pcs' }]} />)).toEqual([
      ['', 'Value', 'Detail'],
      ['Mon', '3', '120 pcs'],
    ])
  })

  it('says so when there is nothing, and works out shares safely', () => {
    expect(table(<LineChart labels={[]} series={[]} />)).toEqual([[''], ['Nothing in this period.']])
    expect(shareOf(1, 3)).toBe(33.3)
    expect(shareOf(1, 0)).toBeNull()
  })
})
