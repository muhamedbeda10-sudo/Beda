import { describe, expect, it } from 'vitest'
import { AI_REPORT_MAX_DAYS, type AiMessage, type AiQueryPart, type AiReport, type AiReportSectionRun, type AiReportSummary, type AiSaveReportResponse } from '@qc/shared/ai'
import { ApiError } from '@/lib/api'
import {
  AI_REPORT_TITLE_MAX,
  REPORT_PERIOD_SAVED,
  canSaveAsReport,
  checkAiDayRange,
  cleanReportTitle,
  daysInRange,
  filterAiReports,
  hasAdjustablePeriod,
  mergeAiReportPages,
  reportPeriodDraft,
  reportPeriodLabel,
  reportPeriodReducer,
  runFailures,
  runPeriodText,
  sameRange,
  saveAsReportState,
  sectionAsQuery,
  sectionSqlForRun,
  type ReportPeriodAction,
  type ReportPeriodState,
} from './reports'

const ok: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 3 }
const failed: AiQueryPart = { ...ok, queryId: 'q2', ok: false, columns: [], rows: [], rowCount: 0, error: 'syntax error' }
const answer: AiMessage = { id: 'a1', role: 'assistant', parts: [ok, { type: 'text', text: 'Done.' }], createdAt: '2026-10-09T10:00:00Z', turnId: 't1', stopReason: 'end_turn' }

const summary = (id: string, title: string, extra: Partial<AiReportSummary> = {}): AiReportSummary => ({
  id,
  title,
  question: `${title}?`,
  period: { kind: 'last_days', days: 30 },
  adjustable: true,
  sectionCount: 2,
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt: '2026-10-02T08:00:00Z',
  shared: false,
  mine: true,
  ownerName: 'Admin',
  madeBy: 'answer',
  inputCount: 0,
  ...extra,
})

describe('saving an answer as a report', () => {
  it('is offered under an ended answer with a turn and a query that worked', () => {
    expect(canSaveAsReport(answer)).toBe(true)
    expect(canSaveAsReport({ ...answer, parts: [failed, ok] })).toBe(true)
  })

  it('is not offered without a working query, without its turn, or for a question', () => {
    expect(canSaveAsReport({ ...answer, parts: [failed, { type: 'text', text: 'It failed.' }] })).toBe(false)
    expect(canSaveAsReport({ ...answer, parts: [{ type: 'text', text: 'Hello.' }] })).toBe(false)
    expect(canSaveAsReport({ ...answer, turnId: undefined })).toBe(false)
    expect(canSaveAsReport({ ...answer, role: 'user' })).toBe(false)
    expect(canSaveAsReport(null)).toBe(false)
  })
})

describe('what saving an answer has come to', () => {
  const saved = (adjustable: boolean, notice?: string): AiSaveReportResponse => ({
    report: { ...summary('r1', 'Top'), adjustable, period: adjustable ? { kind: 'last_days', days: 30 } : null, sections: [{ title: 'Defects', sql: 'SELECT 1' }], inputs: [] },
    ...(notice ? { notice } : {}),
    status: { available: true, model: 'm', spentUsd: 1, capUsd: 50, monthStart: '2026-10-01T00:00:00Z' },
  })
  const none = { saving: null, savedId: null, fixedWhy: null, budgetSpent: false }

  it('is nothing before a save, and the save on its way while it runs', () => {
    expect(saveAsReportState([])).toEqual(none)
    expect(saveAsReportState([{ status: 'pending', data: undefined, error: null, variables: { turnId: 't1' } }]).saving).toBe('adjustable')
    expect(saveAsReportState([{ status: 'pending', data: undefined, error: null, variables: { turnId: 't1', adjustable: false } }]).saving).toBe('fixed')
  })

  it('names the report saved, and why its period stayed fixed only when it was to be adjustable', () => {
    expect(saveAsReportState([{ status: 'success', data: saved(true), error: null, variables: { turnId: 't1' } }])).toEqual({ ...none, savedId: 'r1' })
    expect(saveAsReportState([{ status: 'success', data: saved(false, 'Rows differ.'), error: null, variables: { turnId: 't1' } }])).toEqual({ ...none, savedId: 'r1', fixedWhy: 'Rows differ.' })
    expect(saveAsReportState([{ status: 'success', data: saved(false, 'Rows differ.'), error: null, variables: { turnId: 't1', adjustable: false } }]).fixedWhy).toBeNull()
  })

  it('offers saving as asked when the budget refused making the period adjustable, and only then', () => {
    const spent = new ApiError(402, 'ai_budget_reached', 'The monthly cap is reached.')
    expect(saveAsReportState([{ status: 'error', data: undefined, error: spent, variables: { turnId: 't1' } }]).budgetSpent).toBe(true)
    expect(saveAsReportState([{ status: 'error', data: undefined, error: spent, variables: { turnId: 't1', adjustable: false } }]).budgetSpent).toBe(false)
    expect(saveAsReportState([{ status: 'error', data: undefined, error: new Error('offline'), variables: { turnId: 't1' } }])).toEqual(none)
    // The latest save decides.
    expect(saveAsReportState([{ status: 'error', data: undefined, error: spent, variables: { turnId: 't1' } }, { status: 'pending', data: undefined, error: null, variables: { turnId: 't1', adjustable: false } }])).toEqual({ ...none, saving: 'fixed' })
  })
})

describe('the SQL a run ran', () => {
  const report: Pick<AiReport, 'adjustable'> = { adjustable: true }
  const template = 'SELECT count(*) FROM ai.defects WHERE day >= {{from}} AND day < {{to}} + 1 AND note <> $${{x}}$$'

  it("fills an adjustable report's days as the server does", () => {
    expect(sectionSqlForRun(report, template, { from: '2026-09-01', to: '2026-09-30' })).toBe("SELECT count(*) FROM ai.defects WHERE day >= DATE '2026-09-01' AND day < DATE '2026-09-30' + 1 AND note <> $${{x}}$$")
  })

  it('leaves the SQL as saved without days, for a fixed report, or for days that are not days', () => {
    expect(sectionSqlForRun(report, template, null)).toBe(template)
    expect(sectionSqlForRun({ adjustable: false }, template, { from: '2026-09-01', to: '2026-09-30' })).toBe(template)
    expect(sectionSqlForRun(report, template, { from: "2026-09-01'; DROP", to: '2026-09-30' })).toBe(template)
  })
})

describe('the period control of a report', () => {
  const run = (...actions: ReportPeriodAction[]): ReportPeriodState => actions.reduce(reportPeriodReducer, REPORT_PERIOD_SAVED)
  const ran = { from: '2026-09-10', to: '2026-10-09' }

  it('starts choosing from the days on screen, and keeps what was typed', () => {
    expect(run({ type: 'choose', ran })).toEqual({ override: null, choosing: true, ...ran })
    expect(run({ type: 'from', value: '2026-09-01' }, { type: 'choose', ran })).toMatchObject({ from: '2026-09-01', to: '' })
  })

  it('applies days that can run, once', () => {
    const chosen = run({ type: 'choose', ran }, { type: 'from', value: '2026-09-01' }, { type: 'to', value: '2026-09-30' })
    expect(reportPeriodDraft(chosen)).toEqual({ problem: null, ready: true, applied: false })
    const applied = reportPeriodReducer(chosen, { type: 'apply' })
    expect(applied.override).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(reportPeriodDraft(applied).applied).toBe(true)
    // The same days again: nothing changes, so nothing runs again.
    expect(reportPeriodReducer(applied, { type: 'apply' })).toBe(applied)
    const backwards = reportPeriodReducer(applied, { type: 'to', value: '2026-08-01' })
    expect(reportPeriodDraft(backwards)).toMatchObject({ problem: 'The first day comes after the last.', ready: false })
    expect(reportPeriodReducer(backwards, { type: 'apply' })).toBe(backwards)
  })

  it('a reset from anywhere — the run error too — leaves the control saying the saved period', () => {
    // Days chosen, the run over them failed, and "Reset to the saved period" under the error.
    const failed = run({ type: 'choose', ran }, { type: 'from', value: '2026-09-01' }, { type: 'to', value: '2026-09-30' }, { type: 'apply' })
    const reset = reportPeriodReducer(failed, { type: 'reset' })
    expect(reset).toEqual({ override: null, choosing: false, from: '2026-09-01', to: '2026-09-30' })
    // "As saved" pressed again, Apply not offered for days no longer shown.
    expect(reset.choosing).toBe(false)
    expect(reportPeriodDraft(reset).applied).toBe(false)
    // Already on the saved period: the same state.
    expect(reportPeriodReducer(REPORT_PERIOD_SAVED, { type: 'reset' })).toBe(REPORT_PERIOD_SAVED)
  })
})

describe('days chosen for a run', () => {
  it('counts both ends', () => {
    expect(daysInRange({ from: '2026-09-01', to: '2026-09-30' })).toBe(30)
    expect(daysInRange({ from: '2026-10-09', to: '2026-10-09' })).toBe(1)
    // Across a leap day and a year's end.
    expect(daysInRange({ from: '2028-02-28', to: '2028-03-01' })).toBe(3)
    expect(daysInRange({ from: '2025-12-31', to: '2026-01-01' })).toBe(2)
  })

  it('takes real days in order, at most the longest span the server runs', () => {
    expect(checkAiDayRange('2026-09-01', '2026-09-30')).toBeNull()
    expect(checkAiDayRange('2026-09-01', '2026-09-01')).toBeNull()
    expect(checkAiDayRange('', '2026-09-30')).toMatch(/first and the last/)
    expect(checkAiDayRange('2026-09-01', '')).toMatch(/first and the last/)
    expect(checkAiDayRange('2026-02-30', '2026-03-01')).toMatch(/real days/)
    expect(checkAiDayRange('2026-9-1', '2026-09-30')).toMatch(/real days/)
    expect(checkAiDayRange('2026-10-01', '2026-09-30')).toMatch(/after the last/)
    expect(checkAiDayRange('2015-01-01', '2026-01-01')).toMatch(/At most 3,660 days/)
    // Exactly the longest span runs.
    const from = '2020-01-01'
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + (AI_REPORT_MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
    expect(checkAiDayRange(from, to)).toBeNull()
  })

  it('compares ranges by their days', () => {
    expect(sameRange(null, null)).toBe(true)
    expect(sameRange({ from: 'a', to: 'b' }, null)).toBe(false)
    expect(sameRange({ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-01', to: '2026-09-30' })).toBe(true)
    expect(sameRange({ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-01', to: '2026-09-29' })).toBe(false)
  })
})

describe('a report in words', () => {
  it('names an adjustable period, and nothing for one that runs as saved', () => {
    expect(reportPeriodLabel(summary('r1', 'Top'))).toBe('Last 30 days')
    expect(reportPeriodLabel({ period: { kind: 'fixed', from: '2026-09-01', to: '2026-09-30' }, adjustable: true })).toBe('1 Sep – 30 Sep 2026')
    expect(reportPeriodLabel({ period: null, adjustable: false })).toBeNull()
    expect(hasAdjustablePeriod({ period: { kind: 'this_month' }, adjustable: true })).toBe(true)
    expect(hasAdjustablePeriod({ period: null, adjustable: true })).toBe(false)
    expect(hasAdjustablePeriod({ period: { kind: 'this_month' }, adjustable: false })).toBe(false)
  })

  it('says the days a run covered, the range once when the label is the range', () => {
    expect(runPeriodText(null)).toBeNull()
    expect(runPeriodText({ from: '2026-09-10', to: '2026-10-09', label: 'Last 30 days', overridden: false })).toBe('Last 30 days · 10 Sep – 9 Oct 2026')
    expect(runPeriodText({ from: '2026-09-01', to: '2026-09-30', label: '1 Sep – 30 Sep 2026', overridden: true })).toBe('1 Sep – 30 Sep 2026')
    expect(runPeriodText({ from: '2025-12-01', to: '2026-01-31', label: '', overridden: true })).toBe('1 Dec 2025 – 31 Jan 2026')
  })

  it('counts the sections that failed', () => {
    const s = (good: boolean): AiReportSectionRun => ({ title: 't', ok: good, columns: [], rows: [], rowCount: 0, truncated: false, ms: 1 })
    expect(runFailures([s(true), s(true)])).toBeNull()
    expect(runFailures([s(true), s(false)])).toBe('1 of 2 queries failed.')
    expect(runFailures([s(false)])).toBe('The query failed.')
    expect(runFailures([s(false), s(false)])).toBe('Every query failed.')
  })

  it('draws a section as the answer drew its query', () => {
    const section: AiReportSectionRun = { title: 'العيوب', ok: true, columns: ['n'], rows: [[3]], rowCount: 1, truncated: true, ms: 9 }
    expect(sectionAsQuery(section, 'SELECT {{from}}', 2)).toEqual({ type: 'query', queryId: 'section-2', purpose: 'العيوب', sql: 'SELECT {{from}}', ok: true, columns: ['n'], rows: [[3]], rowCount: 1, truncated: true, ms: 9 })
    expect(sectionAsQuery({ ...section, ok: false, error: 'timeout' }, 'SELECT 1', 0)).toMatchObject({ ok: false, error: 'timeout' })
  })
})

describe('My reports', () => {
  it('searches titles and questions, in any case', () => {
    const list = [summary('r1', 'Top defects'), summary('r2', 'Holds', { question: 'كام عيب على Hold؟' }), summary('r3', 'Coils')]
    expect(filterAiReports(list, '').map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
    expect(filterAiReports(list, '  DEFECTS ').map((r) => r.id)).toEqual(['r1'])
    expect(filterAiReports(list, 'hold').map((r) => r.id)).toEqual(['r2'])
    expect(filterAiReports(list, 'عيب').map((r) => r.id)).toEqual(['r2'])
  })

  it('lists each report once across pages, the earlier page winning', () => {
    const renamed = summary('r2', 'Renamed', { updatedAt: '2026-10-09T08:00:00Z' })
    const merged = mergeAiReportPages([
      { reports: [renamed, summary('r1', 'A')] },
      { reports: [summary('r2', 'Old name'), summary('r3', 'C')] },
    ])
    expect(merged.map((r) => [r.id, r.title])).toEqual([
      ['r2', 'Renamed'],
      ['r1', 'A'],
      ['r3', 'C'],
    ])
    expect(mergeAiReportPages(undefined)).toEqual([])
  })

  it('keeps a title trimmed, on one line, within the longest allowed', () => {
    expect(cleanReportTitle('  Top   defects\n this month ')).toBe('Top defects this month')
    expect(cleanReportTitle('   ')).toBeNull()
    expect(cleanReportTitle('x'.repeat(AI_REPORT_TITLE_MAX + 5))).toHaveLength(AI_REPORT_TITLE_MAX)
  })
})
