// ============================================================================
// §21 — what a scheduled report runs: its own sections, or a saved report
// (My reports) its creator may open, as the report stands at the run — a
// change to the report reaches the next delivery. The saved report's inputs
// take the values the schedule fixed; one it left out takes its default on
// the day the run is for (this week, this year, today). Its period is its
// own, as of that day, unless the schedule gives other days (a report whose
// period can change). Every value is checked as a run from My reports checks
// it, and filled into the SQL as a typed literal (ai/reportInputs), never as
// typed.
//
// The report is read as its creator may read it now: deleted, or no longer
// shared with them, it cannot run — the run fails and says so, as a query
// that fails does, and the automation stops after its failures in a row.
//
// Someone else's report runs as its creator's domains within its author's:
// the domains whoever last wrote its queries had when they were kept (they
// were run as them then; ai_reports.author_domains). A shared report changed
// after it was scheduled, by someone who may read less, so reads no more than
// they could, whatever the creator may read; the app's own starter reports,
// and the creator's own, run as the creator's domains alone. Pinning the
// queries at activation would hold as well, but a change to the report would
// then never reach the deliveries, which is what scheduling a saved report is
// for.
// ============================================================================

import { describeAiPeriod, resolveAiPeriod, type AiChartSpec, type AiDomain, type AiReport, type AiReportSectionDisplay, type AiReportTree } from '@qc/shared/ai'
import { inputValueText, readInputValue, readInputValues, type AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { AutomationLinkedReport, AutomationScheduleSpec } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { authorDomainsOf } from '../ai/domains'
import { factoryDay } from '../ai/prompt'
import { findReport, runPeriod, sectionSql as savedSectionSql } from '../ai/reports'
import { reportPeriodAt, sectionSql } from './validate'

/** A section ready to run: its SQL with the period and the inputs filled in, and how its rows are shown. */
export interface PreparedSection {
  title: string
  sql: string
  chart?: AiChartSpec
  display?: AiReportSectionDisplay
  tree?: AiReportTree
  note?: string
}

export interface PreparedReport {
  sections: PreparedSection[]
  period: { from: string; to: string; label: string } | null
  /** The saved report it runs, when it runs one. */
  report: { id: string; title: string } | null
  /** The values its inputs take on this run, as read. */
  inputs: { label: string; value: string }[]
  /** The domains its sections may be read within, on top of the creator's own: a saved report someone else wrote; null for none. */
  within: AiDomain[] | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A section of someone else's saved report that reads more than its author could when they last changed it. */
export const BEYOND_AUTHOR = 'It reads data that whoever last changed the saved report may not read, so it is not run for this schedule.'
/** Every section, when the creator and the saved report's author may read nothing in common. */
export const NOTHING_IN_COMMON = "Whoever last changed the saved report may read none of the data its schedule's creator may, so it is not run for this schedule."

/** Why a schedule's saved report cannot run, as its creator and its run's history read it. */
export const MISSING_REPORT = 'The saved report it sends was deleted, or is no longer shared with its creator. Choose another report, or delete this automation.'

/**
 * The domains a saved report's queries may be read within when its schedule's creator did not write it: those of
 * whoever last wrote them, as they were then. Null: the creator's own report, or the app's own.
 */
export async function authorDomains(db: Queryable, report: Pick<AiReport, 'id' | 'mine'>): Promise<AiDomain[] | null> {
  if (report.mine) return null
  const { rows } = await db.query<{ domains: string[] | null }>(`SELECT author_domains AS domains FROM ai_reports WHERE id = $1`, [report.id])
  // Not known (null, or an empty set left by an older save): the creator's own domains alone bound it.
  return authorDomainsOf(rows[0]?.domains)
}

/** The saved report a schedule names, as its creator may open it now; null when they may not (or it is gone). */
export async function linkedReportOf(db: Queryable, creatorId: string, s: Pick<AutomationScheduleSpec, 'report'>): Promise<AiReport | null> {
  const id = s.report?.reportId
  if (!id || !UUID.test(id)) return null
  return findReport(db, id.toLowerCase(), creatorId)
}

/**
 * The values a run of the saved report takes: the schedule's, each checked against the report's inputs as they are
 * now, and the defaults on `day` for those it left out; or every problem (an input the report no longer has, a value
 * that no longer fits, a required input the report gained since).
 */
export function linkedValues(report: AiReport, fixed: AiReportInputValues, day: string): { values: AiReportInputValues } | { problems: string[] } {
  const problems: string[] = []
  const known = new Set(report.inputs.map((i) => i.name))
  for (const name of Object.keys(fixed)) if (!known.has(name)) problems.push(`"${name}" is not an input of the report (it asks for ${report.inputs.map((i) => i.name).join(', ') || 'nothing'}).`)
  // A value given as null or empty means "its default on the day", as one left out does.
  const given = Object.fromEntries(Object.entries(fixed).filter(([, v]) => !(v === null || v === '' || (Array.isArray(v) && v.length === 0))))
  const read = readInputValues(report.inputs, given, day)
  if ('problems' in read) problems.push(...read.problems)
  return problems.length > 0 ? { problems } : { values: (read as { values: AiReportInputValues }).values }
}

/**
 * What a run for `at` runs: the schedule's own sections over its period, or its saved report with the values its
 * inputs take that day — or why it cannot run.
 */
export async function prepareReport(db: Queryable, creatorId: string, s: AutomationScheduleSpec, at: Date, timeZone: string): Promise<PreparedReport | { error: string }> {
  if (!s.report) {
    const period = reportPeriodAt(s, at, timeZone)
    return {
      sections: s.sections.map((x) => ({ title: x.title, sql: sectionSql(x.sql, period), ...(x.chart ? { chart: x.chart } : {}) })),
      period,
      report: null,
      inputs: [],
      within: null,
    }
  }
  const report = await linkedReportOf(db, creatorId, s)
  if (!report) return { error: MISSING_REPORT }
  const day = factoryDay(at, timeZone)
  const read = linkedValues(report, s.report.inputs, day)
  if ('problems' in read) return { error: `The saved report "${report.title}" no longer takes the values this automation gives it: ${read.problems.join(' ')}` }
  let period: PreparedReport['period'] = null
  if (s.period) {
    if (!report.adjustable) return { error: `The saved report "${report.title}" no longer runs over days chosen for it: its days are fixed in its queries.` }
    period = { ...resolveAiPeriod(s.period, day), label: describeAiPeriod(s.period) }
  } else {
    const own = runPeriod(report, null, day)
    if (own) period = { from: own.from, to: own.to, label: own.label }
  }
  return {
    sections: report.sections.map((x) => ({
      title: x.title,
      sql: savedSectionSql(report, x, period, read.values),
      ...(x.chart ? { chart: x.chart } : {}),
      ...(x.display && x.display !== 'table' ? { display: x.display } : {}),
      ...(x.tree ? { tree: x.tree } : {}),
      ...(x.note ? { note: x.note } : {}),
    })),
    period,
    report: { id: report.id, title: report.title },
    inputs: report.inputs.map((i) => ({ label: i.label, value: inputValueText(read.values[i.name] ?? null) })),
    within: await authorDomains(db, report),
  }
}

/**
 * Whether a draft's saved report may be sent, and its values made what is stored: the report one its creator may
 * open, no sections of the schedule's own beside it, each value one its input takes (as the input reads it: a list
 * typed as text is a list), every required input given or defaulted, and other days only for a report whose period
 * can change. Problems are written for the model and the person alike.
 */
export async function checkLinkedReport(db: Queryable, creatorId: string, s: AutomationScheduleSpec, day: string, errors: string[]): Promise<AiReport | null> {
  const link = s.report!
  if (s.sections.length > 0) errors.push('schedule.sections: a schedule that sends a saved report has no sections of its own; leave them out (the report\'s are sent).')
  if (!UUID.test(link.reportId)) {
    errors.push(`schedule.report.reportId: "${link.reportId}" is not a report id (read_report lists the reports this person may open).`)
    return null
  }
  const report = await linkedReportOf(db, creatorId, s)
  if (!report) {
    errors.push('schedule.report.reportId: no report with that id that this person may open (their own, or one shared). read_report lists them.')
    return null
  }
  if (!link.inputs || typeof link.inputs !== 'object' || Array.isArray(link.inputs)) {
    errors.push('schedule.report.inputs: an object of values by input name ({} for every input\'s default on the day).')
    return report
  }
  const inputs: AiReportInputValues = {}
  for (const [name, raw] of Object.entries(link.inputs)) {
    const input = report.inputs.find((i) => i.name === name)
    if (!input) {
      errors.push(`schedule.report.inputs.${name}: the report "${report.title}" has no such input (it asks for ${report.inputs.map((i) => i.name).join(', ') || 'nothing'}).`)
      continue
    }
    const read = readInputValue({ ...input, required: false }, raw)
    if ('problem' in read) errors.push(`schedule.report.inputs.${name}: ${read.problem}`)
    else if (read.value !== null) inputs[name] = read.value
  }
  link.inputs = inputs
  link.reportId = link.reportId.toLowerCase()
  const read = linkedValues(report, inputs, day)
  if ('problems' in read) for (const p of read.problems) errors.push(`schedule.report.inputs: ${p} Give it a value: it has no default.`)
  if (s.period && !report.adjustable) errors.push(`schedule.period: the days of "${report.title}" are fixed in its queries; leave the period out (it runs over its own).`)
  return report
}

/**
 * The saved reports a list of schedules sends, as people read them, by the schedule's report id: each read as its
 * schedule's creator may open it now (missing when they may not).
 */
export async function linkedReportViews(db: Queryable, items: readonly { creatorId: string; schedule?: AutomationScheduleSpec | null }[]): Promise<Map<string, AutomationLinkedReport>> {
  const out = new Map<string, AutomationLinkedReport>()
  const wanted = items.filter((i) => i.schedule?.report && UUID.test(i.schedule.report.reportId))
  if (wanted.length === 0) return out
  const { rows } = await db.query<{ id: string; title: string; inputs: AiReport['inputs']; sectionCount: number; ownerId: string; shared: boolean; deleted: boolean }>(
    `SELECT id, title, inputs, json_array_length(sections) AS "sectionCount", user_id AS "ownerId", shared, (deleted_at IS NOT NULL) AS deleted
       FROM ai_reports WHERE id = ANY($1::uuid[])`,
    [[...new Set(wanted.map((i) => i.schedule!.report!.reportId.toLowerCase()))]],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const item of wanted) {
    const link = item.schedule!.report!
    const r = byId.get(link.reportId.toLowerCase())
    const key = linkKey(item.creatorId, link.reportId)
    if (out.has(key)) continue
    out.set(key, {
      id: link.reportId.toLowerCase(),
      title: r?.title ?? 'A deleted report',
      missing: !r || r.deleted || (r.ownerId !== item.creatorId && !r.shared),
      inputs: r?.inputs ?? [],
      values: link.inputs ?? {},
      sectionCount: r?.sectionCount ?? 0,
    })
  }
  return out
}

/** Where linkedReportViews keeps a schedule's report: by its creator and the report (one may open it, another not). */
export const linkKey = (creatorId: string, reportId: string): string => `${creatorId}:${reportId.toLowerCase()}`

/** The view of one schedule's report from linkedReportViews' map, with this schedule's own values. */
export function linkedReportView(map: Map<string, AutomationLinkedReport>, creatorId: string, schedule: AutomationScheduleSpec | null | undefined): AutomationLinkedReport | undefined {
  const link = schedule?.report
  if (!link) return undefined
  const found = map.get(linkKey(creatorId, link.reportId))
  return found ? { ...found, values: link.inputs ?? {} } : undefined
}
