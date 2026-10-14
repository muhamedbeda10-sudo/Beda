import { describe, expect, it } from 'vitest'
import { SLOW_QUERY_SOURCE, slowQueryDuration } from './AiSlowQueriesSection'

describe('a slow query as the owner reads it', () => {
  it('says how long it took in seconds, then minutes', () => {
    expect(slowQueryDuration(12_345)).toBe('12.3 s')
    expect(slowQueryDuration(59_960)).toBe('60.0 s')
    expect(slowQueryDuration(60_002)).toBe('1 min 0 s')
    expect(slowQueryDuration(75_400)).toBe('1 min 15 s')
  })

  it('names every place a query of the assistant runs', () => {
    expect(SLOW_QUERY_SOURCE).toEqual({
      chat: 'Chat',
      report: 'Saved report',
      'scheduled-report': 'Scheduled report',
      excel: 'Excel file',
      'saved-table': 'Saved table',
      export: 'Export to Excel',
      automation: 'Automation',
      other: 'Other',
    })
  })
})
