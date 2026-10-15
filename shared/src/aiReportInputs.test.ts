import { describe, expect, it } from 'vitest'
import { inputDefault, inputValueText, isoWeekOf, readInputValues, splitList, type AiReportInput } from './aiReportInputs'

const WEEK: AiReportInput = { name: 'week', label: 'Week', kind: 'number', required: true, dynamicDefault: 'this_week' }
const ORDERS: AiReportInput = { name: 'orders', label: 'Orders', kind: 'list', required: true }
const SHIFT: AiReportInput = { name: 'shift', label: 'Shift', kind: 'choice', required: false, choices: ['A', 'B'] }
const DAY: AiReportInput = { name: 'day', label: 'Day', kind: 'date', required: false, dynamicDefault: 'today' }

describe('the ISO week', () => {
  it('is counted from Monday, the year of its Thursday deciding', () => {
    expect(isoWeekOf('2026-06-22')).toEqual({ week: 26, year: 2026 })
    expect(isoWeekOf('2026-01-01')).toEqual({ week: 1, year: 2026 })
    // A Sunday ends its week; the last days of a year can be the next year's week 1, the first days the last year's.
    expect(isoWeekOf('2026-06-28')).toEqual({ week: 26, year: 2026 })
    expect(isoWeekOf('2024-12-30')).toEqual({ week: 1, year: 2025 })
    expect(isoWeekOf('2027-01-01')).toEqual({ week: 53, year: 2026 })
  })
})

describe('what is typed', () => {
  it('splits a list at commas, Arabic commas, semicolons, spaces and lines, each once', () => {
    expect(splitList('20332, 20333،20334;20335\n20332  20336')).toEqual(['20332', '20333', '20334', '20335', '20336'])
    expect(splitList(' , ')).toEqual([])
  })

  it('starts from each default of the day, and takes what was sent', () => {
    expect(inputDefault(WEEK, '2026-10-15')).toBe(42)
    expect(inputDefault(DAY, '2026-10-15')).toBe('2026-10-15')
    expect(inputDefault(ORDERS, '2026-10-15')).toEqual([])
    expect(readInputValues([WEEK, SHIFT, DAY], null, '2026-10-15')).toEqual({ values: { week: 42, shift: null, day: '2026-10-15' } })
    expect(readInputValues([WEEK, ORDERS], { week: '26', orders: '20332 20333-Ph1' }, '2026-10-15')).toEqual({ values: { week: 26, orders: ['20332', '20333-Ph1'] } })
  })

  it('tells every problem at once, by the field', () => {
    const read = readInputValues([WEEK, ORDERS, SHIFT, DAY], { week: 'abc', orders: '', shift: 'C', day: '2026-02-30' }, '2026-10-15')
    expect(read).toEqual({ problems: ['Week: a number.', 'Orders: required.', 'Shift: one of A, B.', 'Day: a day, YYYY-MM-DD.'] })
    expect(readInputValues([ORDERS], { orders: Array.from({ length: 101 }, (_, i) => `o${i}`) }, '2026-10-15')).toEqual({ problems: ['Orders: at most 100 values.'] })
    expect(readInputValues([ORDERS], { orders: ['x'.repeat(101)] }, '2026-10-15')).toEqual({ problems: ['Orders: each value at most 100 characters.'] })
  })

  it('reads a value back as a person does', () => {
    expect(inputValueText(['20332', '20333'])).toBe('20332, 20333')
    expect(inputValueText(null)).toBe('—')
    expect(inputValueText(26)).toBe('26')
  })
})
