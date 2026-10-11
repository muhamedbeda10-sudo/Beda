import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionRecordsSummary } from '@qc/shared/api'
import { countOf, describeDays, describeProductionRecords, formatWorkDay } from './productionRecords'

const summary = (over: Partial<ProductionRecordsSummary> = {}): ProductionRecordsSummary => ({
  rows: 42_143,
  lines: 29_901,
  linesKnown: 28_100,
  firstDay: '2020-01-22',
  lastDay: '2026-10-04',
  lastImportAt: '2026-10-10T19:05:00.000Z',
  ...over,
})

describe('the production record in one line (§24)', () => {
  beforeEach(() => {
    // The year decides whether a day carries it; the device is in Cairo (UTC+2 in October).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T20:00:00+02:00'))
  })
  afterEach(() => vi.useRealTimers())

  it('counts with a thousands separator and the right noun', () => {
    expect(countOf(1, 'record')).toBe('1 record')
    expect(countOf(0, 'record')).toBe('0 records')
    expect(countOf(42_143, 'order line')).toBe('42,143 order lines')
  })

  it('reads a working day as the factory day, never the day before it', () => {
    // A UTC reading of '2020-01-22' would show Jan 21 on a device west of Greenwich; a local reading never does.
    expect(formatWorkDay('2020-01-22')).toBe('Jan 22, 2020')
    expect(formatWorkDay('2026-10-04')).toBe('Oct 4')
    expect(describeDays('2020-01-22', '2026-10-04')).toBe('Jan 22, 2020 – Oct 4')
    expect(describeDays('2026-10-04', '2026-10-04')).toBe('Oct 4')
  })

  it('says what is stored: records, order lines and how many the sheet knows, the days, the last import', () => {
    expect(describeProductionRecords(summary())).toMatch(/^42,143 records · 29,901 order lines \(28,100 on the order sheet\) · Jan 22, 2020 – Oct 4 · last import Oct 10, \d\d:\d\d$/)
  })

  it('says so when there is nothing, and leaves out what is not there', () => {
    expect(describeProductionRecords(summary({ rows: 0, lines: 0, linesKnown: 0, firstDay: null, lastDay: null, lastImportAt: null }))).toBe('No production records yet.')
    // Records whose rows carry no day at all, before any import stamped them.
    expect(describeProductionRecords(summary({ rows: 1, lines: 1, linesKnown: 0, firstDay: null, lastDay: null, lastImportAt: null }))).toBe(
      '1 record · 1 order line (none on the order sheet)',
    )
  })
})
