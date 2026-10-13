import { describe, expect, it } from 'vitest'
import type { SavedTable } from '@qc/shared/savedTables'
import { matchesSavedTable, savedTableFacts, savedTableReaders, savedTableSummary } from './SavedTablesPage'

const table: SavedTable = {
  id: 't1',
  name: 'scrap_normal_range',
  title: 'Normal scrap range per item',
  summary: 'How much scrap is normal for each item, day to day.',
  description: 'The 10th to 90th percentile of daily scrap per item over the last year.',
  source: 'query',
  sql: 'SELECT 1 AS x',
  refresh: 'daily',
  domains: ['inspection', 'production'],
  dependsOn: [],
  columns: [
    { name: 'item_code', type: 'text', note: '' },
    { name: 'p90_pct', type: 'numeric', note: 'Percent.' },
  ],
  rowCount: 300,
  version: 1,
  refreshedAt: '2026-10-13T01:00:00.000Z',
  nextRefreshAt: '2026-10-14T01:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  createdByName: 'Mohamed Beda',
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedByName: 'Mohamed Beda',
  updatedAt: '2026-10-13T00:00:00.000Z',
  mayRefresh: true,
  mayRemove: true,
}

describe('the Saved tables page', () => {
  it('says who may read a table in the words of the settings', () => {
    expect(savedTableReaders(table)).toBe('People who may read Inspections and Production record')
    expect(savedTableReaders({ domains: [] })).toBe('Everyone given the assistant')
  })

  it('finds a table by its title, name, summary, description or columns, whatever the case', () => {
    expect(matchesSavedTable(table, '')).toBe(true)
    expect(matchesSavedTable(table, 'day to day')).toBe(true)
    expect(matchesSavedTable(table, 'SCRAP')).toBe(true)
    expect(matchesSavedTable(table, 'percentile')).toBe(true)
    expect(matchesSavedTable(table, 'p90')).toBe(true)
    expect(matchesSavedTable(table, 'routing')).toBe(false)
  })

  it('leads with the summary, or the first sentence of the description for a table saved before summaries', () => {
    expect(savedTableSummary(table)).toBe('How much scrap is normal for each item, day to day.')
    const routing = {
      summary: '  ',
      description: "One row per product x machine seen in the ERP production task record (ai.production_task_records), work days from 2025-01-01. Product = item_code (or '(no code)').",
    }
    expect(savedTableSummary(routing)).toBe('One row per product x machine seen in the ERP production task record (ai.production_task_records), work days from 2025-01-01.')
    expect(savedTableSummary({ summary: '', description: 'جدول المسارات لكل منتج؟ ثم التفاصيل.' })).toBe('جدول المسارات لكل منتج؟')
    expect(savedTableSummary({ summary: '', description: '' })).toBeNull()
    const long = savedTableSummary({ summary: '', description: `${'word '.repeat(60)}end.` })!
    expect(long.length).toBeLessThanOrEqual(181)
    expect(long).toMatch(/word…$/)
  })

  it('puts the rows and how the table is kept on one line', () => {
    expect(savedTableFacts(table)).toBe('300 rows · Every night')
    expect(savedTableFacts({ rowCount: 1, source: 'rows', refresh: 'never' })).toBe('1 row · Written out')
    expect(savedTableFacts({ rowCount: null, source: 'query', refresh: 'hourly' })).toBe('Every hour')
  })
})
