// ============================================================================
// §20 — saved reports, the words and checks around them: which answers can be
// saved and what saving one has come to, the period control of a report and
// the from–to override it sends, the period a run used in words, the SQL a
// run ran, the list's pages as one. Pure, so it is tested without a browser.
// ============================================================================

import type { MutationState } from '@tanstack/react-query'
import {
  AI_REPORT_MAX_DAYS,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  type AiDayRange,
  type AiMessage,
  type AiQueryPart,
  type AiReport,
  type AiReportRunResponse,
  type AiReportSectionRun,
  type AiReportSummary,
  type AiSaveReportRequest,
  type AiSaveReportResponse,
} from '@qc/shared/ai'
import { ApiError } from '@/lib/api'

/** The longest title a report may have (the server holds it to the same). */
export const AI_REPORT_TITLE_MAX = 120

/** What a report whose period could not be made changeable says, once, when it is saved. */
export const AI_REPORT_FIXED_TEXT = "This report's period is fixed as asked; it could not be made adjustable."

/** What saving an answer as a report has come to, as its footer shows it. */
export interface SaveAsReportState {
  /** A save on its way: asking the model to make the period adjustable, or saving it as asked (no model). */
  saving: 'adjustable' | 'fixed' | null
  /** The report the latest save made. */
  savedId: string | null
  /** Why the period stayed fixed, when it was to be made adjustable and could not be. */
  fixedWhy: string | null
  /** The latest save was refused for a monthly limit (the person's or the app's): saving with the period as asked is offered. */
  budgetSpent: boolean
}

type SaveState = Pick<MutationState<AiSaveReportResponse, Error, AiSaveReportRequest>, 'status' | 'data' | 'error' | 'variables'>

/** The footer of an answer from the saves of it (startSavingAiReport keeps them, oldest first): the latest decides. */
export function saveAsReportState(saves: readonly SaveState[]): SaveAsReportState {
  const last = saves.at(-1)
  const none: SaveAsReportState = { saving: null, savedId: null, fixedWhy: null, budgetSpent: false }
  if (!last) return none
  const adjustable = last.variables?.adjustable !== false
  if (last.status === 'pending') return { ...none, saving: adjustable ? 'adjustable' : 'fixed' }
  if (last.status === 'success' && last.data) {
    const { report, notice } = last.data
    return { ...none, savedId: report.id, fixedWhy: adjustable && !report.adjustable && notice ? notice : null }
  }
  if (last.status === 'error') return { ...none, budgetSpent: adjustable && last.error instanceof ApiError && last.error.code === 'ai_budget_reached' }
  return none
}

/** An answer can be saved as a report when it has ended, the server named its turn, and at least one of its queries worked. */
export function canSaveAsReport(message: AiMessage | null | undefined): boolean {
  if (!message || message.role !== 'assistant' || !message.turnId) return false
  return message.parts.some((p) => p.type === 'query' && p.ok)
}

const DAY_MS = 86_400_000

/** Days from `from` to `to`, both counted. */
export function daysInRange(r: AiDayRange): number {
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / DAY_MS) + 1
}

/** Why a from–to override cannot run, or null when it can. */
export function checkAiDayRange(from: string, to: string): string | null {
  if (!from || !to) return 'Choose the first and the last day.'
  if (!isAiDay(from) || !isAiDay(to)) return 'Choose real days.'
  if (from > to) return 'The first day comes after the last.'
  if (daysInRange({ from, to }) > AI_REPORT_MAX_DAYS) return `At most ${AI_REPORT_MAX_DAYS.toLocaleString('en-US')} days at once.`
  return null
}

export const sameRange = (a: AiDayRange | null, b: AiDayRange | null): boolean => (a === null || b === null ? a === b : a.from === b.from && a.to === b.to)

/**
 * The period of a report on screen: the days chosen for the run (`override`;
 * null runs the saved period), whether the from–to inputs are out, and what
 * they hold. One state for the control and the run, so every way back to the
 * saved period — the control's own, the run error's — leaves the control
 * saying so.
 */
export interface ReportPeriodState {
  override: AiDayRange | null
  choosing: boolean
  from: string
  to: string
}

export type ReportPeriodAction =
  /** "Choose days": the inputs, starting from the days on screen when nothing is typed yet. */
  | { type: 'choose'; ran: AiDayRange | null }
  | { type: 'from' | 'to'; value: string }
  /** Apply: run over the days typed, when they can run and are not the days run already. */
  | { type: 'apply' }
  /** Back to the saved period; what was typed stays for the next "Choose days". */
  | { type: 'reset' }

export const REPORT_PERIOD_SAVED: ReportPeriodState = { override: null, choosing: false, from: '', to: '' }

export function reportPeriodReducer(s: ReportPeriodState, a: ReportPeriodAction): ReportPeriodState {
  switch (a.type) {
    case 'choose':
      return { ...s, choosing: true, ...(!s.from && !s.to && a.ran ? { from: a.ran.from, to: a.ran.to } : {}) }
    case 'from':
      return { ...s, from: a.value }
    case 'to':
      return { ...s, to: a.value }
    case 'apply': {
      const range = { from: s.from, to: s.to }
      return checkAiDayRange(s.from, s.to) === null && !sameRange(s.override, range) ? { ...s, override: range } : s
    }
    case 'reset':
      return s.override === null && !s.choosing ? s : { ...s, override: null, choosing: false }
  }
}

/** What the inputs of the period control say: why the days typed cannot run, whether Apply can run them, whether they are the days run. */
export function reportPeriodDraft(s: ReportPeriodState): { problem: string | null; ready: boolean; applied: boolean } {
  const problem = s.from || s.to ? checkAiDayRange(s.from, s.to) : null
  return { problem, ready: !!s.from && !!s.to && !problem, applied: s.override !== null && sameRange(s.override, { from: s.from, to: s.to }) }
}

/** A report's period in the list: "Last 30 days", or null when it runs as saved. */
export function reportPeriodLabel(r: Pick<AiReportSummary, 'period' | 'adjustable'>): string | null {
  return r.adjustable && r.period ? describeAiPeriod(r.period) : null
}

/** Whether a report offers its period to change: an adjustable period it has. */
export const hasAdjustablePeriod = (r: Pick<AiReportSummary, 'period' | 'adjustable'>): boolean => r.adjustable && r.period !== null

/** The days a run covered, in words: "Last 30 days · 10 Sep – 9 Oct 2026", the range once when the label is the range. */
export function runPeriodText(period: AiReportRunResponse['period']): string | null {
  if (!period) return null
  const days = describeAiDays(period)
  const label = period.label.trim()
  return !label || label === days ? days : `${label} · ${days}`
}

/** The reports matching a search, in their title or their question. */
export function filterAiReports<T extends Pick<AiReportSummary, 'title' | 'question'>>(reports: readonly T[], term: string): T[] {
  const q = term.trim().toLowerCase()
  if (!q) return [...reports]
  return reports.filter((r) => r.title.toLowerCase().includes(q) || r.question.toLowerCase().includes(q))
}

/**
 * The pages of My reports as one list, each report once: a report changed
 * while the pages were fetched one after another can be on two of them, and
 * the earlier page (its newer place) wins.
 */
export function mergeAiReportPages(pages: readonly { reports: readonly AiReportSummary[] }[] | undefined): AiReportSummary[] {
  const seen = new Set<string>()
  const out: AiReportSummary[] = []
  for (const page of pages ?? []) {
    for (const r of page.reports) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

/** A title as typed, ready to keep, or null when there is nothing to keep. */
export function cleanReportTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, AI_REPORT_TITLE_MAX) : null
}

/** The placeholders of an adjustable report's SQL: its period's first and last day. */
const PLACEHOLDERS = /\{\{(from|to)\}\}/g

/**
 * A section's SQL as one run of it ran: an adjustable report's template with
 * {{from}} and {{to}} filled in as the server fills them (DATE 'YYYY-MM-DD',
 * the run's first and last day), or the query as saved. For reading — the
 * server never takes SQL from the browser.
 */
export function sectionSqlForRun(report: Pick<AiReport, 'adjustable'>, sql: string, period: AiDayRange | null): string {
  if (!report.adjustable || !period || !isAiDay(period.from) || !isAiDay(period.to)) return sql
  return sql.replace(PLACEHOLDERS, (_, which: 'from' | 'to') => `DATE '${period[which]}'`)
}

/**
 * A section as run, in the shape the answer's query cards draw (its preview
 * table and its "Open table"): the same pieces show a report and an answer.
 */
export function sectionAsQuery(section: AiReportSectionRun, sql: string, index: number): AiQueryPart {
  return {
    type: 'query',
    queryId: `section-${index}`,
    purpose: section.title,
    sql,
    ok: section.ok,
    columns: section.columns,
    rows: section.rows,
    rowCount: section.rowCount,
    truncated: section.truncated,
    ms: section.ms,
    ...(section.error ? { error: section.error } : {}),
  }
}

/** A word on a whole run: how many sections failed, when any did. */
export function runFailures(sections: readonly AiReportSectionRun[]): string | null {
  const failed = sections.filter((s) => !s.ok).length
  if (failed === 0) return null
  return failed === sections.length ? (failed === 1 ? 'The query failed.' : 'Every query failed.') : `${failed} of ${sections.length} queries failed.`
}
