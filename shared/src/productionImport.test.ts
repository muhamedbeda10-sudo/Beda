import { describe, expect, it } from 'vitest'
import { normaliseHeader } from './orderImport'
import { PRODUCTION_RECORD_FIELDS, PRODUCTION_RECORD_KEYS, actualHoursOrNull, parseDayNo, parseWeek, parseWorkDay, workersOf } from './productionImport'

describe('production record fields', () => {
  it('map every column of the ERP export by its header', () => {
    const headers = [
      'ID', 'Pivot', 'Order', 'Item', 'Color', 'Qty', 'Worker1', 'Worker2', 'Worker3', 'Worker4', 'DayNo', 'Day', 'Work Center', 'Duration',
      'Stage (N)', 'Stage (Qty)', 'Remarks', 'L (mm)', 'W (mm)', 'T (mm)', 'Req_Q', 'Actual Time', 'Planned time', 'Shift Category', 'Resource',
      'Weight (KG)', 'Produced Weight (KG)', 'Produced Length (Meter)', 'Record ID',
    ]
    const names = (f: (typeof PRODUCTION_RECORD_FIELDS)[number]) => [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader)
    for (const h of headers) {
      const hits = PRODUCTION_RECORD_FIELDS.filter((f) => names(f).includes(normaliseHeader(h)))
      expect(hits.map((f) => f.key), h).toHaveLength(1)
    }
    // "ID" is the order sheet's Order ID, so the two imports agree on the name of the column that joins them.
    expect(PRODUCTION_RECORD_FIELDS.find((f) => names(f).includes(normaliseHeader('ID')))?.key).toBe('lineKey')
    expect(PRODUCTION_RECORD_FIELDS.find((f) => names(f).includes(normaliseHeader('Order ID')))?.key).toBe('lineKey')
    // "Productivity" is left out on purpose: the ERP writes 0 on every row.
    expect(PRODUCTION_RECORD_FIELDS.some((f) => names(f).includes(normaliseHeader('Productivity')))).toBe(false)
  })

  it('name a record by the order line and the record id together', () => {
    expect(PRODUCTION_RECORD_KEYS).toEqual(['lineKey', 'erpRecordId'])
    for (const k of PRODUCTION_RECORD_KEYS) expect(PRODUCTION_RECORD_FIELDS.some((f) => f.key === k)).toBe(true)
  })

  it('keeps keys unique', () => {
    expect(new Set(PRODUCTION_RECORD_FIELDS.map((f) => f.key)).size).toBe(PRODUCTION_RECORD_FIELDS.length)
  })
})

describe('actualHoursOrNull', () => {
  it("turns the ERP's placeholder into not recorded, keeps real hours", () => {
    expect(actualHoursOrNull(0.00001)).toBeNull()
    expect(actualHoursOrNull(0)).toBeNull()
    expect(actualHoursOrNull(0.001)).toBe(0.001)
    expect(actualHoursOrNull(2)).toBe(2)
    expect(actualHoursOrNull(null)).toBeNull()
    expect(actualHoursOrNull(undefined)).toBeNull()
    expect(actualHoursOrNull(Number.NaN)).toBeNull()
  })
})

describe('parseDayNo', () => {
  it('reads the ERP forms', () => {
    expect(parseDayNo('Day1')).toBe(1)
    expect(parseDayNo('day 12')).toBe(12)
    expect(parseDayNo('3')).toBe(3)
    expect(parseDayNo(4)).toBe(4)
    expect(parseDayNo('Day')).toBeNull()
    expect(parseDayNo('')).toBeNull()
    expect(parseDayNo('Day1.5')).toBeNull()
    expect(parseDayNo(2.5)).toBeNull()
    expect(parseDayNo(null)).toBeNull()
  })
})

describe('parseWeek', () => {
  it('reads week/year', () => {
    expect(parseWeek('01/2026')).toEqual({ week: 1, year: 2026 })
    expect(parseWeek('41/2026')).toEqual({ week: 41, year: 2026 })
    expect(parseWeek(' 7 / 2025 ')).toEqual({ week: 7, year: 2025 })
    expect(parseWeek('54/2026')).toBeNull()
    expect(parseWeek('2026/01')).toBeNull()
    expect(parseWeek('')).toBeNull()
    expect(parseWeek(undefined)).toBeNull()
  })
})

describe('parseWorkDay', () => {
  it('reads ISO with or without a time, and day-first dates, as the day only', () => {
    expect(parseWorkDay('2025-12-26 00:00:00')).toBe('2025-12-26')
    expect(parseWorkDay('2026-01-05')).toBe('2026-01-05')
    expect(parseWorkDay('2026-01-05T22:00:00.000Z')).toBe('2026-01-05')
    expect(parseWorkDay('05/01/2026')).toBe('2026-01-05')
    expect(parseWorkDay('5-1-2026')).toBe('2026-01-05')
    expect(parseWorkDay('26/12/2025 07:30')).toBe('2025-12-26')
  })
  it('refuses what is not a day', () => {
    expect(parseWorkDay('')).toBeNull()
    expect(parseWorkDay('2026-02-30')).toBeNull()
    expect(parseWorkDay('13/13/2026')).toBeNull()
    expect(parseWorkDay('Day1')).toBeNull()
    expect(parseWorkDay(null)).toBeNull()
  })
})

describe('workersOf', () => {
  it('lists the people once, in order, blanks left out, spaces tidied', () => {
    expect(workersOf(['حسن  أحمد', '', null, 'حسن أحمد', 'سامي'])).toEqual(['حسن أحمد', 'سامي'])
    expect(workersOf([undefined, undefined])).toEqual([])
  })
})
