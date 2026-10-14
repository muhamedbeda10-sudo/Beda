import { describe, expect, it } from 'vitest'
import { attributeOf, binsOf, boxOf, calendarOf, capabilityOf, capabilityTone, riskZone, sankeyNodes, spreadOf, xbarROf } from './chartStats'

describe('the statistics behind the quality charts', () => {
  const readings = [9, 10, 11, 10, 9, 11, 10, 10]

  it('works out the spread and the capability: Cp and Cpk from σ within, Pp and Ppk from σ overall', () => {
    expect(spreadOf(readings)).toEqual({ n: 8, mean: 10, sd: expect.closeTo(0.7559, 4), min: 9, max: 11 })
    const cap = capabilityOf(readings, 7, 13)!
    // σ within = MR̄ / 1.128 = 1 / 1.128.
    expect(cap.cp).toBeCloseTo(1.128, 3)
    expect(cap.cpk).toBeCloseTo(1.128, 3)
    expect(cap.pp).toBeCloseTo(1.323, 3)
    expect(cap.ppk).toBeCloseTo(1.323, 3)
    expect(cap).toMatchObject({ below: 0, above: 0 })
    // One limit: no Cp, a Cpk to the limit given; readings past it counted.
    const upper = capabilityOf(readings, undefined, 10.5)!
    expect(upper.cp).toBeNull()
    expect(upper.cpk).toBeCloseTo((10.5 - 10) / (3 / 1.128), 3)
    expect(upper.above).toBe(2)
    expect(capabilityOf(readings, undefined, undefined)).toBeNull()
    expect([capabilityTone(1.4), capabilityTone(1.1), capabilityTone(0.8), capabilityTone(null)]).toEqual(['good', 'fair', 'poor', null])
  })

  it('bins readings in round widths across the readings and the limits', () => {
    const bins = binsOf(readings, [7, 13])
    expect(bins.edges[0]).toBeLessThanOrEqual(7)
    expect(bins.edges.at(-1)).toBeGreaterThanOrEqual(13)
    expect(bins.counts.reduce((t, c) => t + c, 0)).toBe(8)
    expect(bins.counts.length).toBeGreaterThanOrEqual(5)
  })

  it('draws an X̄-R chart with limits for each subgroup’s size, leaving out a subgroup of one reading', () => {
    const x = xbarROf([[1, 3], [2, 4], [3, 5], [7], [2, 2], [4, 6]])!
    expect(x.kept).toEqual([0, 1, 2, 4, 5])
    expect(x.left).toBe(1)
    expect(x.sigma).toBeCloseTo(8 / 1.128 / 5, 4)
    expect(x.means.center).toBeCloseTo(3.2, 6)
    expect(x.means.ucl[0]).toBeCloseTo(3.2 + (3 * x.sigma) / Math.SQRT2, 6)
    expect(x.ranges.ucl[0]).toBeCloseTo(3.267 * 1.128 * x.sigma, 6)
    expect(x.ranges.lcl[0]).toBeNull()
    expect(xbarROf([[1, 2], [3]])).toBeNull()
  })

  it('puts the attribute charts’ limits at each sample’s size, never below zero', () => {
    const p = attributeOf('p', [1, 2, 3, 20], [100, 100, 100, 100])!
    expect(p.center).toBeCloseTo(6.5, 6)
    expect(p.ucl[0]).toBeCloseTo((0.065 + 3 * Math.sqrt((0.065 * 0.935) / 100)) * 100, 6)
    expect(p.lcl[0]).toBeNull()
    expect(p.out).toEqual([false, false, false, true])
    const c = attributeOf('c', [4, 5, 6, 5], [null, null, null, null])!
    expect(c.center).toBe(5)
    expect(c.ucl[0]).toBeCloseTo(5 + 3 * Math.sqrt(5), 6)
    const u = attributeOf('u', [2, 4], [1, 4])!
    expect(u.values).toEqual([2, 1])
    expect(u.ucl[0]! > u.ucl[1]!).toBe(true)
  })

  it('finds a box plot’s quartiles, whiskers and outliers', () => {
    expect(boxOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toEqual({ n: 10, q1: 3.25, median: 5.5, q3: 7.75, low: 1, high: 9, mean: 14.5, outliers: [100] })
  })

  it('lays out a sankey’s stages and a calendar’s weeks, and zones a risk', () => {
    expect(sankeyNodes([{ from: 'A', to: 'B', value: 5 }, { from: 'B', to: 'C', value: 4 }, { from: 'A', to: 'C', value: 1 }])).toEqual([
      { name: 'A', column: 0, value: 6 },
      { name: 'B', column: 1, value: 5 },
      { name: 'C', column: 2, value: 5 },
    ])
    const ms = (d: string) => Date.parse(`${d}T00:00:00Z`)
    const cal = calendarOf([
      { ms: ms('2026-10-14'), day: '2026-10-14', value: 3 },
      { ms: ms('2026-10-12'), day: '2026-10-12', value: 1 },
      { ms: ms('2026-10-19'), day: '2026-10-19', value: null },
    ])
    expect(cal.weeks).toBe(2)
    expect(cal.cells.map((c) => [c.day, c.week, c.weekday])).toEqual([
      ['2026-10-14', 0, 2],
      ['2026-10-12', 0, 0],
      ['2026-10-19', 1, 0],
    ])
    expect([riskZone(7, 6, 10), riskZone(5, 5, 10), riskZone(9, 4, 10), riskZone(9, 2, 10), riskZone(2, 3, 10), riskZone(3, 5, 5)]).toEqual(['high', 'medium', 'high', 'medium', 'low', 'high'])
  })
})
