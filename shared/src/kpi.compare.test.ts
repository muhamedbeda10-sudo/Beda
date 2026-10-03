import { describe, it, expect } from 'vitest'
import { compareBuckets, compareGrain, normaliseDashboardLayout, defaultDashboardLayout } from './kpi'

describe('§15 — the grain and the points of a comparison', () => {
  it('draws up to a month a day a point, up to three months a week, else a month', () => {
    expect(compareGrain('2026-09-01', '2026-09-30')).toBe('day')
    expect(compareGrain('2026-08-01', '2026-08-31')).toBe('day')
    expect(compareGrain('2026-08-01', '2026-09-01')).toBe('week')
    expect(compareGrain('2026-07-01', '2026-09-30')).toBe('week')
    expect(compareGrain('2026-07-01', '2026-10-01')).toBe('month')
  })

  it('puts every day on the axis', () => {
    expect(compareBuckets('2026-02-27', '2026-03-01', 'day').map((b) => b.key)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01'])
  })

  it("counts weeks from the period's first day, the last one cut to the period", () => {
    expect(compareBuckets('2026-09-01', '2026-09-16', 'week')).toEqual([
      { key: '2026-09-01', from: '2026-09-01', to: '2026-09-07' },
      { key: '2026-09-08', from: '2026-09-08', to: '2026-09-14' },
      { key: '2026-09-15', from: '2026-09-15', to: '2026-09-16' },
    ])
  })

  it('cuts the first and the last month to the period, across a year', () => {
    expect(compareBuckets('2025-11-15', '2026-01-10', 'month')).toEqual([
      { key: '2025-11', from: '2025-11-15', to: '2025-11-30' },
      { key: '2025-12', from: '2025-12-01', to: '2025-12-31' },
      { key: '2026-01', from: '2026-01-01', to: '2026-01-10' },
    ])
  })

  it('has no point for a period that ends before it starts', () => {
    expect(compareBuckets('2026-09-02', '2026-09-01', 'day')).toEqual([])
  })

  it('gives a page saved before it existed its default arrangement', () => {
    expect(normaliseDashboardLayout('comparisons', undefined)).toEqual(defaultDashboardLayout('comparisons'))
    expect(normaliseDashboardLayout('comparisons', [])).toEqual(defaultDashboardLayout('comparisons'))
  })
})
