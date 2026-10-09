// ============================================================================
// §20 — saved reports through the cache: saving marks the answer it came
// from wherever its conversation is cached ("Saved · Open"), and moves the
// month's spend; deleting takes the mark off again and forgets the report;
// renaming reaches the report on screen and its runs.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AiMessage, AiMessagesResponse, AiReport, AiReportRunResponse, AiSaveReportResponse, AiStatusResponse } from '@qc/shared/ai'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { deleteAiReport, markSavedReport, renameAiReport, saveAiReport } = await import('./mutations')
const { keys, loadAiReportExport, loadOlderAiReports } = await import('./queries')

const conversation = { id: 'c1', title: 'Top defects', createdAt: '2026-10-09T10:00:00Z', lastMessageAt: '2026-10-09T10:00:00Z' }
const question: AiMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Top defects?' }], createdAt: '2026-10-09T10:00:00Z', turnId: 't1' }
const answer: AiMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Weld porosity.' }], createdAt: '2026-10-09T10:00:05Z', turnId: 't1' }
const other: AiMessage = { ...answer, id: 'a2', turnId: 't2' }
const messages: AiMessagesResponse = { conversation, messages: [question, answer, other] }
const status: AiStatusResponse = { available: true, model: 'claude-sonnet-5-5', spentUsd: 1.5, capUsd: 50, monthStart: '2026-10-01T00:00:00Z' }
const report: AiReport = {
  id: 'r1',
  title: 'Top defects',
  question: 'Top defects?',
  period: { kind: 'last_days', days: 30 },
  adjustable: true,
  sectionCount: 1,
  createdAt: '2026-10-09T10:01:00Z',
  updatedAt: '2026-10-09T10:01:00Z',
  conversationId: 'c1',
  sections: [{ title: 'Defects', sql: 'SELECT 1 WHERE d >= {{from}} AND d < {{to}} + 1' }],
}

describe('marking an answer as saved', () => {
  it('marks the answer of the turn, and only it', () => {
    const marked = markSavedReport(messages, 't1', 'r1')!
    expect(marked.messages.map((m) => m.savedReportId)).toEqual([undefined, 'r1', undefined])
    // The other messages are the same objects: nothing else redraws.
    expect(marked.messages[0]).toBe(question)
    expect(marked.messages[2]).toBe(other)
  })

  it('returns the same conversation when the turn is not in it, or it is marked already', () => {
    expect(markSavedReport(messages, 't9', 'r1')).toBe(messages)
    const marked = markSavedReport(messages, 't1', 'r1')!
    expect(markSavedReport(marked, 't1', 'r1')).toBe(marked)
    expect(markSavedReport(undefined, 't1', 'r1')).toBeUndefined()
  })

  it('takes the mark of a deleted report off every answer that has it', () => {
    const marked = markSavedReport(messages, 't1', 'r1')!
    const cleared = markSavedReport(marked, null, 'r1')!
    expect(cleared.messages.every((m) => !('savedReportId' in m))).toBe(true)
    expect(markSavedReport(marked, null, 'r9')).toBe(marked)
  })
})

describe('saved reports and the cache', () => {
  let qc: QueryClient

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    qc.setQueryData(keys.aiMessages('c1'), messages)
  })

  it('saving sends the turn, keeps the report and the new spend, and marks the answer', async () => {
    const res: AiSaveReportResponse = { report, status }
    apiMock.mockResolvedValueOnce(res)
    expect(await saveAiReport(qc, { turnId: 't1' })).toBe(res)
    expect(apiMock).toHaveBeenCalledWith('/ai/reports', { method: 'POST', body: { turnId: 't1' } })
    expect(qc.getQueryData(keys.aiStatus)).toEqual(status)
    expect(qc.getQueryData(keys.aiReport('r1'))).toEqual(report)
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.messages[1].savedReportId).toBe('r1')
  })

  it('saving as asked says so, for no call to the model', async () => {
    apiMock.mockResolvedValueOnce({ report: { ...report, adjustable: false, period: null }, status })
    await saveAiReport(qc, { turnId: 't1', adjustable: false })
    expect(apiMock).toHaveBeenCalledWith('/ai/reports', { method: 'POST', body: { turnId: 't1', adjustable: false } })
  })

  it('a refused save marks nothing', async () => {
    apiMock.mockRejectedValueOnce(new Error('The monthly cap is reached.'))
    await expect(saveAiReport(qc, { turnId: 't1' })).rejects.toThrow(/cap/)
    expect(qc.getQueryData(keys.aiMessages('c1'))).toBe(messages)
  })

  it('renaming reaches the report and its runs', async () => {
    const run: AiReportRunResponse = { report, period: null, sections: [], ranAt: '2026-10-09T11:00:00Z' }
    qc.setQueryData(keys.aiReportRun('r1', null), run)
    qc.setQueryData(keys.aiReportRun('r1', { from: '2026-09-01', to: '2026-09-30' }), run)
    const renamed = { ...report, title: 'Defects, 30 days' }
    apiMock.mockResolvedValueOnce(renamed)
    await renameAiReport(qc, 'r1', 'Defects, 30 days')
    expect(apiMock).toHaveBeenCalledWith('/ai/reports/r1', { method: 'PATCH', body: { title: 'Defects, 30 days' } })
    expect(qc.getQueryData<AiReport>(keys.aiReport('r1'))?.title).toBe('Defects, 30 days')
    expect(qc.getQueryData<AiReportRunResponse>(keys.aiReportRun('r1', null))?.report.title).toBe('Defects, 30 days')
    expect(qc.getQueryData<AiReportRunResponse>(keys.aiReportRun('r1', { from: '2026-09-01', to: '2026-09-30' }))?.report.title).toBe('Defects, 30 days')
  })

  it('deleting forgets the report and its runs, and the answer offers saving again', async () => {
    qc.setQueryData(keys.aiMessages('c1'), markSavedReport(messages, 't1', 'r1'))
    qc.setQueryData(keys.aiReport('r1'), report)
    qc.setQueryData(keys.aiReportRun('r1', null), { report, period: null, sections: [], ranAt: '2026-10-09T11:00:00Z' })
    apiMock.mockResolvedValueOnce(undefined)
    await deleteAiReport(qc, 'r1')
    expect(apiMock).toHaveBeenCalledWith('/ai/reports/r1', { method: 'DELETE' })
    expect(qc.getQueryData(keys.aiReport('r1'))).toBeUndefined()
    expect(qc.getQueryData(keys.aiReportRun('r1', null))).toBeUndefined()
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.messages[1].savedReportId).toBeUndefined()
  })

  it('asks for the days of an export only when they were chosen, both together', async () => {
    apiMock.mockResolvedValue({})
    await loadAiReportExport('r1', null)
    await loadAiReportExport('r/1', { from: '2026-09-01', to: '2026-09-30' })
    await loadOlderAiReports('2026-10-01T08:00:00.000Z')
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/ai/reports/r1/export',
      '/ai/reports/r%2F1/export?from=2026-09-01&to=2026-09-30',
      '/ai/reports?before=2026-10-01T08%3A00%3A00.000Z&limit=50',
    ])
  })
})
