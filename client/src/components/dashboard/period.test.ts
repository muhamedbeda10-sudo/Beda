import { describe, expect, it } from 'vitest'
import { compareRange, daysInRange, describeRange, factoryToday, isMonthAligned, presetRange } from './period'

const today = new Date(2026, 8, 8, 12) // noon, 8 Sep 2026, where the browser sits

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

  it('counts from the factory day: before 08:00 it is still yesterday', () => {
    // 02:00 on 1 October: the night shift of 30 September is still on.
    const night = new Date(2026, 9, 1, 2, 0)
    expect(presetRange('this-month', night)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(presetRange('last-7', night)).toEqual({ from: '2026-09-24', to: '2026-09-30' })
    expect(presetRange('this-month', new Date(2026, 9, 1, 8, 0))).toEqual({ from: '2026-10-01', to: '2026-10-01' })
    // In the factory's zone when it is given: 05:30 UTC is 07:30 in Cairo in January, 08:30 in summer.
    expect(presetRange('last-7', new Date('2026-01-01T05:30:00Z'), undefined, 'Africa/Cairo')).toEqual({ from: '2025-12-25', to: '2025-12-31' })
    expect(presetRange('this-year', new Date('2026-07-01T05:30:00Z'), undefined, 'Africa/Cairo')).toEqual({ from: '2026-01-01', to: '2026-07-01' })
    // The strip's today, in the factory's zone whatever the browser's.
    expect(factoryToday('Africa/Cairo', new Date('2026-10-19T23:00:00Z'))).toBe('2026-10-19')
    expect(factoryToday('Asia/Tokyo', new Date('2026-10-19T23:00:00Z'))).toBe('2026-10-20')
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

  it('compares a whole month with the whole month before, whatever their lengths', () => {
    // September (30 days) with all of August (31), not August 1–30.
    expect(compareRange({ from: '2026-09-01', to: '2026-09-30' }, 'previous-period', true)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    // February with all of January, not January 1–28; a leap February too.
    expect(compareRange({ from: '2026-02-01', to: '2026-02-28' }, 'previous-period', true)).toEqual({ from: '2026-01-01', to: '2026-01-31' })
    expect(compareRange({ from: '2028-02-01', to: '2028-02-29' }, 'previous-period', true)).toEqual({ from: '2028-01-01', to: '2028-01-31' })
    // March with all of a leap February.
    expect(compareRange({ from: '2028-03-01', to: '2028-03-31' }, 'previous-period', true)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    // December back across the year.
    expect(compareRange({ from: '2026-12-01', to: '2026-12-31' }, 'previous-period', true)).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    // A day short of the month's end is still the same day number.
    expect(compareRange({ from: '2026-09-01', to: '2026-09-29' }, 'previous-period', true)).toEqual({ from: '2026-08-01', to: '2026-08-29' })
  })

  it('compares whole quarters and spans of months with the whole span before', () => {
    // Q2 with all of Q1: to 31 March, not 30 March.
    expect(compareRange({ from: '2026-04-01', to: '2026-06-30' }, 'previous-period', true)).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    // Q1 with all of Q4 of the year before.
    expect(compareRange({ from: '2026-01-01', to: '2026-03-31' }, 'previous-period', true)).toEqual({ from: '2025-10-01', to: '2025-12-31' })
    // Q3 of a leap year back to Q2, and two months ending in February to the two before.
    expect(compareRange({ from: '2028-07-01', to: '2028-09-30' }, 'previous-period', true)).toEqual({ from: '2028-04-01', to: '2028-06-30' })
    expect(compareRange({ from: '2028-01-01', to: '2028-02-29' }, 'previous-period', true)).toEqual({ from: '2027-11-01', to: '2027-12-31' })
  })

  it('compares a day range with the same number of days before it', () => {
    const r = { from: '2026-09-02', to: '2026-09-08' }
    expect(daysInRange(r)).toBe(7)
    expect(compareRange(r, 'previous-period', false)).toEqual({ from: '2026-08-26', to: '2026-09-01' })
  })

  it('compares with last year', () => {
    expect(compareRange({ from: '2026-09-01', to: '2026-09-08' }, 'same-last-year', true)).toEqual({ from: '2025-09-01', to: '2025-09-08' })
    expect(compareRange({ from: '2024-02-29', to: '2024-02-29' }, 'same-last-year', false)).toEqual({ from: '2023-02-28', to: '2023-02-28' })
    // A whole February with a whole leap February, and the other way.
    expect(compareRange({ from: '2029-02-01', to: '2029-02-28' }, 'same-last-year', true)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(compareRange({ from: '2028-02-01', to: '2028-02-29' }, 'same-last-year', true)).toEqual({ from: '2027-02-01', to: '2027-02-28' })
  })

  it('describes a range for people', () => {
    expect(describeRange({ from: '2026-09-01', to: '2026-09-08' })).toBe('Sep 1 – Sep 8, 2026')
    expect(describeRange({ from: '2025-12-20', to: '2026-01-05' })).toBe('Dec 20, 2025 – Jan 5, 2026')
    expect(describeRange({ from: '2026-09-08', to: '2026-09-08' })).toBe('Sep 8, 2026')
  })
})
