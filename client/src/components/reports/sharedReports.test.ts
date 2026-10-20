import { describe, expect, it } from 'vitest'
import type { SharedReportSummary } from '@qc/shared/reportShares'
import { ApiError } from '@/lib/api'
import { mergeSharedPages, sharedReportGone, sharedReportLine } from './sharedReports'

const summary = (id: string, over: Partial<SharedReportSummary> = {}): SharedReportSummary => ({
  id,
  title: `Report ${id}`,
  ownerName: 'Cara Creator',
  updatedAt: '2026-10-19T08:00:00.000Z',
  inputCount: 0,
  sectionCount: 1,
  ...over,
})

describe('the Reports page’s words', () => {
  it('reads the pages as one list, each report once, at its newer place', () => {
    const merged = mergeSharedPages([{ reports: [summary('a'), summary('b')] }, { reports: [summary('b', { title: 'older' }), summary('c')] }])
    expect(merged.map((r) => [r.id, r.title])).toEqual([
      ['a', 'Report a'],
      ['b', 'Report b'],
      ['c', 'Report c'],
    ])
    expect(mergeSharedPages(undefined)).toEqual([])
  })

  it('says who shared a report and what it asks for', () => {
    expect(sharedReportLine({ ownerName: 'Cara Creator', inputCount: 0, sectionCount: 1 })).toBe('Shared by Cara Creator · 1 section')
    expect(sharedReportLine({ ownerName: 'Cara Creator', inputCount: 2, sectionCount: 3 })).toBe('Shared by Cara Creator · 3 sections · asks for 2 values')
  })

  it('knows a report unshared or deleted while open: the server answers not found', () => {
    expect(sharedReportGone(new ApiError(404, 'not_found', 'That report was not found.'))).toBe(true)
    expect(sharedReportGone(new ApiError(409, 'conflict', 'Cara no longer has access.'))).toBe(false)
    expect(sharedReportGone(null)).toBe(false)
  })
})
