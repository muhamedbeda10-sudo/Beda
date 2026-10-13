import { describe, expect, it } from 'vitest'
import type { SavedTable } from '@qc/shared/savedTables'
import { matchesSavedTable, savedTableReaders } from './SavedTablesPage'

const table: SavedTable = {
  id: 't1',
  name: 'scrap_normal_range',
  title: 'Normal scrap range per item',
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

  it('finds a table by its title, name, description or columns, whatever the case', () => {
    expect(matchesSavedTable(table, '')).toBe(true)
    expect(matchesSavedTable(table, 'SCRAP')).toBe(true)
    expect(matchesSavedTable(table, 'percentile')).toBe(true)
    expect(matchesSavedTable(table, 'p90')).toBe(true)
    expect(matchesSavedTable(table, 'routing')).toBe(false)
  })
})
