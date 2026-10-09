// ============================================================================
// §20 — saved reports through the cache: saving marks the answer it came
// from wherever its conversation is cached ("Saved · Open"), and asks again
// whether the assistant can still answer — keeping no amount, which the chat
// never shows — one save of an answer at a time whatever the screen does;
// deleting takes the mark off again and forgets the report; renaming reaches
// the report on screen and its runs, and a run ending later does not undo it;
// My reports pages and searches through the server, without gaps.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { InfiniteQueryObserver, QueryClient, type MutationState } from '@tanstack/react-query'
import type { AiMessage, AiMessagesResponse, AiReport, AiReportRunResponse, AiReportsResponse, AiReportSummary, AiSaveReportRequest, AiSaveReportResponse, AiStatusResponse } from '@qc/shared/ai'
import { ApiError } from '@/lib/api'
import { saveAsReportState } from '@/components/ai/reports'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { deleteAiReport, markSavedReport, renameAiReport, saveAiReport, startSavingAiReport } = await import('./mutations')
const { aiReportListOptions, keys, loadAiReportExport, loadAiReportsPage, newerAiReport, runAiReport } = await import('./queries')

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

  it('saving sends the turn, keeps the report, marks the answer, and asks /ai/me again without keeping an amount', async () => {
    qc.setQueryData(keys.aiMe, { granted: true, owner: false, available: true })
    const res: AiSaveReportResponse = { report, status }
    apiMock.mockResolvedValueOnce(res)
    expect(await saveAiReport(qc, { turnId: 't1' })).toBe(res)
    expect(apiMock).toHaveBeenCalledWith('/ai/reports', { method: 'POST', body: { turnId: 't1' } })
    // The model call may have reached a cap: whether the assistant can still answer is asked again.
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(true)
    // The response's figures go nowhere: the chat shows no amounts.
    expect(qc.getQueryCache().findAll({ queryKey: ['ai', 'status'] })).toHaveLength(0)
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
    await loadAiReportsPage('', null)
    await loadAiReportsPage('عيوب L1', { updatedAt: '2026-10-01T08:00:00.000Z', id: 'a1b2' })
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/ai/reports/r1/export',
      '/ai/reports/r%2F1/export?from=2026-09-01&to=2026-09-30',
      '/ai/reports?limit=50',
      `/ai/reports?q=${encodeURIComponent('عيوب')}+L1&before=2026-10-01T08%3A00%3A00.000Z&beforeId=a1b2&limit=50`,
    ])
  })
})

describe('saving an answer, once at a time', () => {
  let qc: QueryClient
  const saves = (turnId: string) =>
    qc
      .getMutationCache()
      .findAll({ mutationKey: keys.aiSaveReport(turnId), exact: true })
      .map((m) => m.state as MutationState<AiSaveReportResponse, Error, AiSaveReportRequest>)

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    qc.setQueryData(keys.aiMessages('c1'), messages)
  })

  it('a save on its way stays one, whatever is drawn again meanwhile, and leaves its word when it ends', async () => {
    let answer!: (res: AiSaveReportResponse) => void
    apiMock.mockReturnValueOnce(new Promise<AiSaveReportResponse>((resolve) => (answer = resolve)))
    const first = startSavingAiReport(qc, { turnId: 't1' })
    expect(first).not.toBeNull()
    // The answer drawn again (the thread left and come back to): the save is still on its way, and a second is not sent.
    expect(saveAsReportState(saves('t1'))).toEqual({ saving: 'adjustable', savedId: null, fixedWhy: null, budgetSpent: false })
    expect(startSavingAiReport(qc, { turnId: 't1' })).toBeNull()
    expect(startSavingAiReport(qc, { turnId: 't1', adjustable: false })).toBeNull()
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))

    answer({ report: { ...report, adjustable: false, period: null }, notice: 'A section gave other rows over the same days.', status })
    await first
    expect(apiMock).toHaveBeenCalledTimes(1)
    // Its reason stays for the answer, read again by an answer drawn later.
    expect(saveAsReportState(saves('t1'))).toEqual({ saving: null, savedId: 'r1', fixedWhy: 'A section gave other rows over the same days.', budgetSpent: false })
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.messages[1].savedReportId).toBe('r1')
    // Another answer is its own.
    expect(saveAsReportState(saves('t2')).saving).toBeNull()
  })

  it('the budget spent offers saving as asked, which replaces the refused save', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(402, 'ai_budget_reached', 'The monthly cap is reached.'))
    await expect(startSavingAiReport(qc, { turnId: 't1' })).rejects.toThrow(/cap/)
    expect(saveAsReportState(saves('t1')).budgetSpent).toBe(true)

    apiMock.mockResolvedValueOnce({ report: { ...report, adjustable: false, period: null }, status })
    await startSavingAiReport(qc, { turnId: 't1', adjustable: false })
    expect(apiMock).toHaveBeenLastCalledWith('/ai/reports', { method: 'POST', body: { turnId: 't1', adjustable: false } })
    expect(saves('t1')).toHaveLength(1)
    // Saved as asked on purpose: nothing to explain.
    expect(saveAsReportState(saves('t1'))).toEqual({ saving: null, savedId: 'r1', fixedWhy: null, budgetSpent: false })
  })

  it('deleting the report forgets that the answer was saved', async () => {
    apiMock.mockResolvedValueOnce({ report, status })
    await startSavingAiReport(qc, { turnId: 't1' })
    expect(saveAsReportState(saves('t1')).savedId).toBe('r1')
    apiMock.mockResolvedValueOnce(undefined)
    await deleteAiReport(qc, 'r1')
    expect(saveAsReportState(saves('t1')).savedId).toBeNull()
  })
})

describe('a run ending after a rename', () => {
  let qc: QueryClient
  const run = (r: AiReport): AiReportRunResponse => ({ report: r, period: null, sections: [], ranAt: '2026-10-09T11:00:00Z' })

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
  })

  it('keeps the newer title, and the run it ended', async () => {
    const renamed: AiReport = { ...report, title: 'Defects, 30 days', updatedAt: '2026-10-09T10:30:00.000Z', lastRunAt: '2026-10-09T10:00:00.000Z' }
    qc.setQueryData(keys.aiReport('r1'), renamed)
    // The server read the report before the rename and ran its sections meanwhile.
    apiMock.mockResolvedValueOnce(run({ ...report, lastRunAt: '2026-10-09T11:00:00.000Z' }))
    const done = await runAiReport(qc, 'r1', null)
    expect(done.report.title).toBe('Defects, 30 days')
    expect(done.report.lastRunAt).toBe('2026-10-09T11:00:00.000Z')
    expect(qc.getQueryData<AiReport>(keys.aiReport('r1'))).toEqual({ ...renamed, lastRunAt: '2026-10-09T11:00:00.000Z' })
  })

  it("takes the run's copy when it is as new or newer", async () => {
    const fresh = run({ ...report, title: 'Renamed elsewhere', updatedAt: '2026-10-09T12:00:00.000Z', lastRunAt: '2026-10-09T12:00:01.000Z' })
    qc.setQueryData(keys.aiReport('r1'), report)
    apiMock.mockResolvedValueOnce(fresh)
    expect(await runAiReport(qc, 'r1', { from: '2026-09-01', to: '2026-09-30' })).toBe(fresh)
    expect(apiMock).toHaveBeenCalledWith('/ai/reports/r1/run?from=2026-09-01&to=2026-09-30')
    expect(qc.getQueryData(keys.aiReport('r1'))).toEqual(fresh.report)
    // Nothing cached yet, or the same version: the run's copy (it knows the last run).
    expect(newerAiReport(undefined, report)).toBe(report)
    const ran = { ...report, lastRunAt: '2026-10-09T13:00:00.000Z' }
    expect(newerAiReport(report, ran)).toBe(ran)
  })
})

describe('My reports, paged and searched by the server', () => {
  let qc: QueryClient
  let reports: AiReportSummary[]
  const minute = 60_000
  const at = (i: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') - i * minute).toISOString()

  /** The server's list: the latest changed first, before a moment, matching a search in the title or the question. */
  function serve(path: string, init?: { method?: string; body?: unknown }) {
    const url = new URL(path, 'http://x')
    if (init?.method === 'PATCH') {
      const id = url.pathname.split('/').at(-1)!
      const r = reports.find((x) => x.id === id)!
      Object.assign(r, { title: (init.body as { title: string }).title, updatedAt: new Date(Date.parse(at(0)) + minute).toISOString() })
      return Promise.resolve({ ...r, sections: [] })
    }
    const q = url.searchParams.get('q')?.toLowerCase() ?? null
    const before = url.searchParams.get('before')
    const limit = Number(url.searchParams.get('limit'))
    const rows = reports
      .filter((r) => (before === null || r.updatedAt < before) && (q === null || r.title.toLowerCase().includes(q) || r.question.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    return Promise.resolve<AiReportsResponse>({ reports: rows.slice(0, limit), hasMore: rows.length > limit })
  }

  async function list(search: string) {
    const observer = new InfiniteQueryObserver(qc, aiReportListOptions(search))
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true))
    const ids = () => (observer.getCurrentResult().data?.pages ?? []).flatMap((p) => p.reports.map((r) => r.id))
    return { observer, stop, ids }
  }

  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation(serve)
    qc = new QueryClient()
    reports = Array.from({ length: 120 }, (_, i) => ({
      id: `r${String(i + 1).padStart(3, '0')}`,
      title: i === 109 ? 'Coil thickness by supplier' : `Report ${i + 1}`,
      question: `Question ${i + 1}?`,
      period: null,
      adjustable: false,
      sectionCount: 1,
      createdAt: at(i + 1),
      updatedAt: at(i + 1),
    }))
  })

  it('renaming a report of an older page moves it to the top without losing the one where the pages met', async () => {
    const { observer, stop, ids } = await list('')
    await observer.fetchNextPage()
    expect(ids()).toHaveLength(100)
    expect(ids().slice(48, 52)).toEqual(['r049', 'r050', 'r051', 'r052'])

    await renameAiReport(qc, 'r060', 'Renamed')
    // Every page loaded was fetched again, from the new first page on: still the latest 100, each once, r050 among them.
    const now = ids()
    expect(now).toHaveLength(100)
    expect(new Set(now).size).toBe(100)
    expect(now[0]).toBe('r060')
    expect(now).toContain('r050')
    expect(now.at(-1)).toBe('r100')
    expect(observer.getCurrentResult().hasNextPage).toBe(true)
    stop()
  })

  it('finds a report on a page never loaded, and pages through the matches', async () => {
    const all = await list('')
    expect(all.ids()).not.toContain('r110')
    all.stop()

    const found = await list('  COIL thickness ')
    expect(found.ids()).toEqual(['r110'])
    expect(apiMock).toHaveBeenLastCalledWith('/ai/reports?q=COIL+thickness&limit=50')
    found.stop()

    const many = await list('Report 1')
    // "Report 1", "Report 10"–"Report 19", "Report 100"–"Report 120" but r110 (renamed): 1 + 10 + 20 = 31 — one page.
    expect(many.ids()).toHaveLength(31)
    expect(many.observer.getCurrentResult().hasNextPage).toBe(false)
    many.stop()

    const question = await list('question')
    expect(question.ids()).toHaveLength(50)
    await question.observer.fetchNextPage()
    await question.observer.fetchNextPage()
    expect(question.ids()).toHaveLength(120)
    expect(question.observer.getCurrentResult().hasNextPage).toBe(false)
    question.stop()
  })
})
