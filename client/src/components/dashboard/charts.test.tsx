import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { chartFigure } from '@/components/ai/chartData'
import { ColumnChart, GroupedBarChart, LineChart, PairedBarChart, ParetoChart, StackedColumnChart, TrendChart, niceBounds } from './charts'

/** The figures written along a chart's value axis, bottom to top (the grid's labels: anchored at their end, left of the plot). */
const axisFigures = (html: string) => [...html.matchAll(/<text x="[\d.]+" y="[\d.-]+" text-anchor="end" fill="currentColor">([^<]*)<\/text>/g)].map((m) => m[1])
/** The slanted names: where each is anchored and its words. */
const slanted = (html: string) => [...html.matchAll(/<text x="([\d.]+)"[^>]*transform="rotate\(-35[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), text: m[2] }))

describe('the value axis', () => {
  it('is the dashboard’s by default: 0 to the most rounded up, in four steps', () => {
    expect(niceBounds(0, 267)).toEqual({ min: 0, max: 500, steps: 4 })
    expect(niceBounds(0, 0.9)).toEqual({ min: 0, max: 1, steps: 4 })
  })

  it('fitted, spans the figures in the least round step, five at most', () => {
    expect(niceBounds(0, 267, true)).toEqual({ min: 0, max: 300, steps: 3 })
    expect(niceBounds(0, 315, true)).toEqual({ min: 0, max: 400, steps: 4 })
    expect(niceBounds(0, 3900, true)).toEqual({ min: 0, max: 4000, steps: 4 })
    expect(niceBounds(0, 0.0129, true)).toEqual({ min: 0, max: 0.015, steps: 3 })
    // Below zero and above it, zero among the steps.
    expect(niceBounds(-1250, 2210, true)).toEqual({ min: -2000, max: 3000, steps: 5 })
    expect(niceBounds(-3, 0, true)).toEqual({ min: -3, max: 0, steps: 3 })
  })

  it('fitted, never leaves much more than a quarter of the plot empty', () => {
    for (let hi = 0.37; hi < 1e6; hi *= 1.37) {
      const axis = niceBounds(0, hi, true)
      expect(axis.steps).toBeGreaterThanOrEqual(2)
      expect(axis.steps).toBeLessThanOrEqual(5)
      expect(axis.max).toBeGreaterThanOrEqual(hi)
      expect(hi / axis.max).toBeGreaterThan(0.6)
    }
  })

  it('reads nothing at all as 0 to 1', () => {
    expect(niceBounds(0, 0, true)).toEqual({ min: 0, max: 1, steps: 4 })
  })
})

describe('the assistant’s bar chart', () => {
  const types = ['Paint thickness out of tolerance', 'Scratch', 'Burr', 'Hole misalignment', 'Colour difference', 'Weld porosity', 'Weld crack', 'Bubbles', 'Dimension shift', 'Dent', 'Rust spot', 'Missing hole']
  const values = [267, 135, 87, 66, 57, 48, 47, 33, 38, 35, 30, 28]

  it('writes its figures as the assistant does, on an axis fitted to them', () => {
    const html = renderToStaticMarkup(<GroupedBarChart labels={types} series={[{ label: 'defect pieces', values, className: 'fill-brand-500' }]} width={820} format={chartFigure} />)
    expect(axisFigures(html)).toEqual(['0', '100', '200', '300'])
    const small = renderToStaticMarkup(<GroupedBarChart labels={['A', 'B']} series={[{ label: 'rate', values: [0.0012, 0.0129], className: 'fill-brand-500' }]} width={820} format={chartFigure} />)
    expect(axisFigures(small)).toEqual(['0', '0.005', '0.01', '0.015'])
    expect(small).toContain('>0.0012<')
    const large = renderToStaticMarkup(<GroupedBarChart labels={['A', 'B']} series={[{ label: 'pieces', values: [1284, 12500000], className: 'fill-brand-500' }]} width={820} format={chartFigure} />)
    expect(large).toContain('>12,500,000<')
    expect(large).toContain('>1,284<')
  })

  it('makes room at the left for its first slanted name, which would otherwise run off the drawing', () => {
    for (const width of [340, 420, 820]) {
      const html = renderToStaticMarkup(<GroupedBarChart labels={types} series={[{ label: 'defect pieces', values, className: 'fill-brand-500' }]} width={width} format={chartFigure} />)
      const names = slanted(html)
      expect(names[0].text).toBe('Paint thickness out of to…')
      // Its end is anchored under its column; turned 35°, it reaches back across cos 35° of its length (5.4 px a letter, as
      // drawn), and its letters' tops (7.5 px up) lean back sin 35° of their height further.
      for (const n of names) expect(n.x - n.text.length * 5.4 * Math.cos((35 * Math.PI) / 180) - 7.5 * Math.sin((35 * Math.PI) / 180)).toBeGreaterThanOrEqual(0)
    }
    // Names of figures, as wide as letters get: the first of forty orders.
    const orders = Array.from({ length: 40 }, (_, i) => `${20000 + i}-Ph${(i % 7) + 1}.${i % 4}-SMA`)
    for (const width of [340, 820]) {
      const html = renderToStaticMarkup(<GroupedBarChart labels={orders} series={[{ label: 'defect pieces', values: orders.map((_, i) => 900 - i * 20), className: 'fill-brand-500' }]} width={width} format={chartFigure} />)
      for (const n of slanted(html)) expect(n.x - n.text.length * 6 * Math.cos((35 * Math.PI) / 180) - 7.5 * Math.sin((35 * Math.PI) / 180)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('the assistant’s line chart', () => {
  const days = Array.from({ length: 365 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 9, 1 + i))
    return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
  })
  const produced = days.map((_, i) => 3200 + Math.round(600 * Math.sin(i / 30)))

  it('names a year of days only as often as the names stand apart, and marks no point but the one hovered', () => {
    const html = renderToStaticMarkup(<LineChart labels={days} series={[{ label: 'produced', values: produced, className: 'stroke-brand-500' }]} unit="" width={760} fitted format={chartFigure} />)
    const names = [...html.matchAll(/<text x="[\d.]+" y="[\d.]+" text-anchor="(?:start|middle|end)" font-size="10" class="fill-muted">([^<]*)<\/text>/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThanOrEqual(6)
    expect(names.length).toBeLessThanOrEqual(10)
    expect(names[0]).toBe('Oct 1, 2025')
    expect(html).not.toContain('<circle')
    expect(axisFigures(html)).toEqual(['0', '1,000', '2,000', '3,000', '4,000'])
  })

  it('marks a point standing alone between gaps, which no line would draw', () => {
    const gappy = days.map((_, i) => (i === 100 ? 3000 : i < 50 ? 2800 + i : null))
    const joined = renderToStaticMarkup(<LineChart labels={days} series={[{ label: 'produced', values: gappy, className: 'stroke-brand-500' }]} width={760} fitted connectGaps format={chartFigure} />)
    expect(joined).not.toContain('<circle')
    const apart = renderToStaticMarkup(<LineChart labels={days} series={[{ label: 'produced', values: gappy, className: 'stroke-brand-500' }]} width={760} fitted format={chartFigure} />)
    expect(apart.match(/<circle/g)).toHaveLength(1)
    const single = renderToStaticMarkup(<LineChart labels={days} series={[{ label: 'produced', values: days.map((_, i) => (i === 100 ? 3000 : null)), className: 'stroke-brand-500' }]} width={760} fitted connectGaps format={chartFigure} />)
    expect(single.match(/<circle/g)).toHaveLength(1)
  })

  it('stays the dashboard’s without `fitted`: a name every few points, every point marked', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb']
    const html = renderToStaticMarkup(<LineChart labels={months.map((m, i) => `${m} ${i}`)} series={[{ label: 'rate', values: months.map((_, i) => i + 0.5), className: 'stroke-brand-500' }]} />)
    expect(html.match(/<circle/g)).toHaveLength(months.length)
    expect(axisFigures(html)).toEqual(['0%', '5%', '10%', '15%', '20%'])
  })
})

describe('the assistant’s stacked columns', () => {
  it('fitted, fits its axis to the totals; on the dashboard, rounds the most up as it always has', () => {
    const columns = ['LM1', 'LM2'].map((label, i) => ({ label, segments: [{ label: 'a', value: 100 + i * 67, className: 'fill-brand-500' }, { label: 'b', value: 100, className: 'fill-rose-500' }] }))
    const legend = [{ label: 'a', className: 'fill-brand-500' }, { label: 'b', className: 'fill-rose-500' }]
    expect(axisFigures(renderToStaticMarkup(<StackedColumnChart columns={columns} legend={legend} fitted format={chartFigure} />))).toEqual(['0', '100', '200', '300'])
    expect(axisFigures(renderToStaticMarkup(<StackedColumnChart columns={columns} legend={legend} />))).toEqual(['0', '125', '250', '375', '500'])
  })
})

/** Every type size a drawing writes in (its texts' and their groups'). */
const typeSizes = (html: string) => [...html.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]))
/** The drawing's own width, from its viewBox. */
const drawnWidth = (html: string) => Number(/viewBox="0 0 ([\d.]+) /.exec(html)?.[1])

describe('the dashboard’s charts, drawn at the size they are shown', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const trend = months.map((label, i) => ({ label, bar: 400 + i * 130, line: 1 + (i % 4) * 0.37 }))
  const pareto = ['Burr', 'Wavy', 'Scratch', 'Edge', 'زوائد قص', 'Dent', 'Others (3)'].map((label, i) => ({ label, value: 40 - i * 5, cumulativePct: Math.min(100, 30 + i * 12) }))
  const days = Array.from({ length: 283 }, (_, i) => ({ label: `D${i + 1}`, total: i > 250 ? 30 + (i % 7) : 0, part: i > 250 ? i % 5 : 0 }))
  const weeks = Array.from({ length: 41 }, (_, i) => ({ label: `W${i + 1}`, total: i > 35 ? 210 : 0, part: i > 35 ? 12 : 0 }))
  // A 360 px phone's card, a board box at 1180, a desktop card.
  const widths = [296, 416, 720]
  const charts = (width: number) => [
    renderToStaticMarkup(<TrendChart points={trend} barLabel="Pieces made" lineLabel="Reject rate" width={width} />),
    renderToStaticMarkup(<ParetoChart bars={pareto} onPick={() => {}} width={width} />),
    renderToStaticMarkup(<PairedBarChart points={days} weekly={weeks} totalLabel="Pieces inspected" partLabel="Defect pieces" width={width} />),
    renderToStaticMarkup(<LineChart labels={months} series={[{ label: 'Factory 1', values: trend.map((p) => p.line), className: 'stroke-brand-500' }]} width={width} />),
    renderToStaticMarkup(<StackedColumnChart columns={['31-Roll Forming-LM2 long name', '34-Gasparini Long Roll Forming Machine'].map((label) => ({ label, segments: [{ label: 'Burr', value: 20, className: 'fill-brand-500' }] }))} legend={[{ label: 'Burr', className: 'fill-brand-500' }]} width={width} />),
    renderToStaticMarkup(<ColumnChart columns={[{ label: '1 pc', value: 4, sub: '40%' }, { label: '2 pcs', value: 6, sub: '60%' }]} width={width} />),
  ]

  it('draws at the width given, so a word keeps its size: never under 10 px', () => {
    for (const width of widths) {
      for (const html of charts(width)) {
        expect(drawnWidth(html)).toBe(width)
        expect(Math.min(...typeSizes(html))).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('leaves the rate’s axis out on a phone, where the read-out says the rate', () => {
    const wide = renderToStaticMarkup(<TrendChart points={trend} barLabel="Pieces made" lineLabel="Reject rate" width={720} />)
    const narrow = renderToStaticMarkup(<TrendChart points={trend} barLabel="Pieces made" lineLabel="Reject rate" width={296} />)
    expect(wide).toContain('>0%</text>')
    expect(narrow).not.toContain('>0%</text>')
  })

  it('writes as many month names as have room: all twelve on a desktop card, fewer on a phone', () => {
    const named = (html: string) => months.filter((m) => html.includes(`>${m}</text>`)).length
    expect(named(renderToStaticMarkup(<TrendChart points={trend} barLabel="Pieces made" lineLabel="Reject rate" width={720} />))).toBe(12)
    const phone = named(renderToStaticMarkup(<TrendChart points={trend} barLabel="Pieces made" lineLabel="Reject rate" width={296} />))
    expect(phone).toBeGreaterThan(2)
    expect(phone).toBeLessThan(12)
  })

  it('numbers a Pareto’s bars on a phone and lists their names under it; slants the names on a wider card', () => {
    const narrow = renderToStaticMarkup(<ParetoChart bars={pareto} onPick={() => {}} width={296} />)
    expect(narrow).not.toContain('rotate(-28)')
    expect(narrow).toContain('<ol')
    expect(narrow).toContain('>زوائد قص</span>')
    // The 80% line keeps its mark where the share's axis was.
    expect(narrow).toContain('>80%</text>')
    const wide = renderToStaticMarkup(<ParetoChart bars={pareto} onPick={() => {}} width={720} />)
    expect(wide).toContain('rotate(-28)')
    expect(wide).not.toContain('<ol')
  })

  it('draws a bar a week where a day would be too narrow to see, and a bar a day where there is room', () => {
    const phone = renderToStaticMarkup(<PairedBarChart points={days} weekly={weeks} totalLabel="Pieces inspected" partLabel="Defect pieces" width={296} />)
    expect(phone).toContain('by week</title>')
    expect(phone).toContain('A bar a week')
    const month = days.slice(250)
    const card = renderToStaticMarkup(<PairedBarChart points={month} weekly={weeks} totalLabel="Pieces inspected" partLabel="Defect pieces" width={296} />)
    expect(card).toContain('by day</title>')
  })
})
