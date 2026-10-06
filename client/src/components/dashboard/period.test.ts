import { describe, expect, it } from 'vitest'
import { compareRange, daysInRange, describeRange, isMonthAligned, presetRange } from './period'

const today = new Date(2026, 8, 8) // 8 Sep 2026

describe('dashboard periods', () => {
  it('knows the presets', () => {
    expect(presetRange('this-month', today)).toEqual({ from: '2026-09-01', to: '2026-09-08' })
    expect(presetRange('last-month', today)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(presetRange('last-7', today)).toEqual({ from: '2026-09-02', to: '2026-09-08' })
    expect(presetRange('last-30', today)).toEqual({ from: '2026-08-10', to: '2026-09-08' })
    expect(presetRange('this-quarter', today)).toEqual({ from: '2026-07-01', to: '2026-09-08' })
    expect(presetRange('this-year', today)).toEqual({ from: '2026-01-01', to: '2026-09-08' })
    expect(presetRange('custom', today, { from: '2026-03-03', to: '2026-03-09' })).toEqual({ from: '2026-03-03', to: '2026-03-09' })
  })

  it('compares month-to-date with the same days of the previous month', () => {
    const r = { from: '2026-09-01', to: '2026-09-08' }
    expect(isMonthAligned(r)).toBe(true)
    expect(compareRange(r, 'previous-period', true)).toEqual({ from: '2026-08-01', to: '2026-08-08' })
    // 31 March compared with February clamps to the 28th.
    expect(compareRange({ from: '2026-03-01', to: '2026-03-31' }, 'previous-period', true)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    // A quarter to date compares with the previous quarter to the same day.
    expect(compareRange({ from: '2026-07-01', to: '2026-09-08' }, 'previous-period', true)).toEqual({ from: '2026-04-01', to: '2026-06-08' })
    // January goes back to December of the previous year.
    expect(compareRange({ from: '2026-01-01', to: '2026-01-15' }, 'previous-period', true)).toEqual({ from: '2025-12-01', to: '2025-12-15' })
  })

  it('compares a day range with the same number of days before it', () => {
    const r = { from: '2026-09-02', to: '2026-09-08' }
    expect(daysInRange(r)).toBe(7)
    expect(compareRange(r, 'previous-period', false)).toEqual({ from: '2026-08-26', to: '2026-09-01' })
  })

  it('compares with last year', () => {
    expect(compareRange({ from: '2026-09-01', to: '2026-09-08' }, 'same-last-year', true)).toEqual({ from: '2025-09-01', to: '2025-09-08' })
    expect(compareRange({ from: '2024-02-29', to: '2024-02-29' }, 'same-last-year', false)).toEqual({ from: '2023-02-28', to: '2023-02-28' })
  })

  it('describes a range for people', () => {
    expect(describeRange({ from: '2026-09-01', to: '2026-09-08' })).toBe('Sep 1 – Sep 8, 2026')
    expect(describeRange({ from: '2025-12-20', to: '2026-01-05' })).toBe('Dec 20, 2025 – Jan 5, 2026')
    expect(describeRange({ from: '2026-09-08', to: '2026-09-08' })).toBe('Sep 8, 2026')
  })
})
