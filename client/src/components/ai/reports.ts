// ============================================================================
// §20 — saved reports, the words and checks around them: which answers can be
// saved, a from–to override checked before it is sent, the period a run used
// in words, the list searched and paged. Pure, so it is tested without a
// browser.
// ============================================================================

import {
  AI_REPORT_MAX_DAYS,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  type AiDayRange,
  type AiMessage,
  type AiQueryPart,
  type AiReportRunResponse,
  type AiReportSectionRun,
  type AiReportSummary,
} from '@qc/shared/ai'

/** The longest title a report may have (the server holds it to the same). */
export const AI_REPORT_TITLE_MAX = 120

/** What a report whose period could not be made changeable says, once, when it is saved. */
export const AI_REPORT_FIXED_TEXT = "This report's period is fixed as asked; it could not be made adjustable."

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

/** The first page (kept fresh) and the older pages loaded since, each report once, the first page's copy winning. */
export function mergeAiReportPages(first: readonly AiReportSummary[], older: readonly AiReportSummary[]): AiReportSummary[] {
  const seen = new Set<string>()
  const out: AiReportSummary[] = []
  for (const r of [...first, ...older]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/** A title as typed, ready to keep, or null when there is nothing to keep. */
export function cleanReportTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, AI_REPORT_TITLE_MAX) : null
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
