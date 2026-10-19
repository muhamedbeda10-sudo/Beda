// ============================================================================
// §21 — whether a draft may become an automation, and what it finds when it
// runs once (the backtest). Every check a proposal needs, the same whether
// the assistant just wrote it, a person activates it with changes, or edits
// it later on the Automations page:
//
//   • words within their limits; the kind's own part present, the other not;
//   • a watch's query passes the chat's own precheck and runs in the sandbox
//     as its creator's CURRENT data domains; its key column is a column of
//     the result, never empty and unique in what it returned; every column a
//     template, a link, a recipient or the assignee names is in the result;
//   • a report's sections (1 to 8) pass the saved reports' template rules
//     ({{from}} and {{to}} only with a period, standing alone, bounding the
//     data) and each runs over the period as of the factory's today; or it
//     sends a saved report its creator may open, with values its inputs take
//     (./savedReport), and that report runs with them as of today;
//   • the schedule's fields fit its cadence; the interval its limits, a
//     watch's hours two HH:MM times that differ and its days real ones;
//   • the people named are active accounts (never the system sender), the
//     roles real, the channels at least one, the follow-up's deadline in range;
//   • a change names one of the creator's own automations of the same kind,
//     and nobody holds more automations than allowed.
//
// The errors are written for the model as much as for a person: each names
// the field and what to do, so the assistant can fix its call and try again.
// A query's failure is the exception: the model is told what to change in its
// query (queryErrorForModel); people — a card, an activation, a run's history,
// the automation's status, the alert that it stopped, a delivered report —
// read what went wrong in plain words (queryErrorForPeople).
// ============================================================================

import type pg from 'pg'
import {
  AI_PREVIEW_ROWS,
  describeAiPeriod,
  resolveAiPeriod,
  type AiCell,
  type AiDomain,
  type AiReportSectionRun,
} from '@qc/shared/ai'
import {
  AUTOMATION_BACKTEST_SAMPLE_ROWS,
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_MAX_EVERY_MINUTES,
  AUTOMATION_MAX_PER_CREATOR,
  AUTOMATION_MAX_RECIPIENTS,
  AUTOMATION_MAX_SECTIONS,
  AUTOMATION_MIN_EVERY_MINUTES,
  AUTOMATION_NAME_MAX,
  AUTOMATION_TEMPLATE_MAX,
  AUTOMATION_WATCH_MAX_ROWS,
  FOLLOW_UP_MAX_DUE_HOURS,
  FOLLOW_UP_MIN_DUE_HOURS,
  isAutomationTime,
  isAutomationWeekday,
  templatePlaceholders,
  type AutomationAssignee,
  type AutomationBacktest,
  type AutomationDraft,
  type AutomationRecipient,
  type AutomationScheduleSpec,
  type AutomationWatchSpec,
} from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { checkChart } from '../ai/charts'
import { cutChars } from '../ai/blocks'
import { factoryDay } from '../ai/prompt'
import { checkTemplate, fillTemplate, periodProblem } from '../ai/reportTemplate'
import { precheckSql, previewOf, runReadOnlyQuery, type QueryRun } from '../ai/runQuery'
import { withQueryOrigin, withQueryPurpose } from '../ai/slowQueries'
import { clipText } from './notify'
import { checkLinkedReport, prepareReport, type PreparedSection } from './savedReport'
import { fillCaseTemplate } from './text'

/** A query an automation runs may take this long, as a query in the chat. */
export const AUTOMATION_QUERY_TIMEOUT_MS = 10_000
/** Rows of each section a report's backtest keeps for its card. */
const BACKTEST_SECTION_ROWS = 50
/** A sample cell longer than this is cut on the card and for the model. */
const SAMPLE_CELL_CHARS = 300
/** The longest title a section may have. */
const SECTION_TITLE_MAX = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where an automation's queries run: the creator's domains, as they are now. */
export interface AutomationReaders {
  readonly ready: boolean
  poolFor(domains: readonly AiDomain[]): pg.Pool | null
}

export interface ValidationContext {
  db: Queryable
  readers: AutomationReaders
  timeZone: string
  /** Whose automation it is: their domains, their limit, their automations. */
  creatorId: string
  domains: readonly AiDomain[]
  now: Date
  /**
   * Run the queries (a proposal, an activation): the backtest, and the checks
   * that need a result. Without (an edit on the page, the queries unchanged),
   * columns are checked against `knownColumns`, the result as last seen.
   */
  runQueries: boolean
  knownColumns?: readonly string[] | null
  /** The automation an edit changes: not counted against the creator's limit, and allowed as its own replacement. */
  editing?: string | null
  /** Run no query for a draft that already fails its other checks (an activation: what to fix comes first, and costs the database nothing). */
  stopEarly?: boolean
  /** Who reads the errors: the model (a proposal; the default), or the person who asked (an activation) — a query's failure then in plain words. */
  readBy?: 'model' | 'person'
  signal?: AbortSignal
}

export type Validation =
  | {
      ok: true
      draft: AutomationDraft
      backtest: AutomationBacktest | null
      /** A watch's query as it ran: the cases matching now (an activation records them as seen). */
      watchRun: QueryRun | null
    }
  | { ok: false; errors: string[]; draft: AutomationDraft; backtest: AutomationBacktest | null }

/** One line of words: spaces folded, ends trimmed. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const chars = (s: string) => Array.from(s).length
const quoted = (s: string) => `"${cutChars(s, 60, true)}"`

/** A key longer than this is cut, as its follow-up keeps it: keys are ids in practice, and an index entry has a size limit. */
const CASE_KEY_MAX = 1000

/** A case's key as stored: the key column's value as text. */
export const caseKey = (cell: AiCell): string | null => (cell === null || cell === undefined || cell === '' ? null : clipText(String(cell), CASE_KEY_MAX))

/** Check a draft, normalising its words, and run it once when asked to. Never throws for the draft's sake. */
export async function validateDraft(ctx: ValidationContext, input: AutomationDraft): Promise<Validation> {
  const errors: string[] = []
  const draft = normalise(input)
  const failedQuery = (run: QueryFailed) => (ctx.readBy === 'person' ? queryErrorForPeople(run, 'asker') : queryErrorForModel(run))

  // ---- Words
  if (!draft.name) errors.push('name: give the automation a name.')
  else if (chars(draft.name) > AUTOMATION_NAME_MAX) errors.push(`name: at most ${AUTOMATION_NAME_MAX} characters.`)
  if (!draft.description) errors.push('description: say in plain words what it watches or reports, and what it does.')
  else if (chars(draft.description) > AUTOMATION_DESCRIPTION_MAX) errors.push(`description: at most ${AUTOMATION_DESCRIPTION_MAX} characters.`)

  // ---- The kind and its part
  if (draft.kind === 'watch') {
    if (!draft.watch) errors.push('watch: a watch needs its query, key column, interval and title template.')
    if (draft.schedule) errors.push('schedule: only a report has a schedule; this is a watch. Leave it out.')
  } else {
    if (!draft.schedule) errors.push('schedule: a report needs its schedule and sections.')
    if (draft.watch) errors.push('watch: only a watch has a query of its own; this is a report. Leave it out.')
  }
  const watchSqlOk = draft.kind === 'watch' && draft.watch ? checkWatch(draft.watch, errors) : false
  const sectionsOk = draft.kind === 'report' && draft.schedule ? checkSchedule(draft.schedule, errors) : false

  // ---- What it does
  checkActions(draft, errors)
  if (!draft.channels.bell && !draft.channels.chat) errors.push('channels: choose the bell, the chat, or both.')
  const columnsNamed = checkRecipients(draft, errors)
  await checkPeople(ctx.db, draft, errors)
  await checkOwnership(ctx, draft, errors)
  // A saved report: one its creator may open, with values its inputs take (made what is stored).
  const linkedOk =
    draft.kind === 'report' && draft.schedule?.report ? (await checkLinkedReport(ctx.db, ctx.creatorId, draft.schedule, factoryDay(ctx.now, ctx.timeZone), errors)) !== null : true

  // ---- What it finds
  let backtest: AutomationBacktest | null = null
  let watchRun: QueryRun | null = null
  if (ctx.runQueries && !(ctx.stopEarly && errors.length > 0)) {
    const pool = ctx.readers.ready ? ctx.readers.poolFor(ctx.domains) : null
    if (!pool) errors.push("The assistant cannot reach the factory's data right now, so the automation could not be tried. Try again later.")
    else if (draft.kind === 'watch' && draft.watch && watchSqlOk) {
      watchRun = await withQueryOrigin({ source: 'automation', userId: ctx.creatorId, purpose: draft.name }, () =>
        runReadOnlyQuery(pool, draft.watch!.sql, {
          maxRows: AUTOMATION_WATCH_MAX_ROWS,
          timeoutMs: AUTOMATION_QUERY_TIMEOUT_MS,
          timeZone: ctx.timeZone,
          signal: ctx.signal,
        }),
      )
      backtest = watchBacktest(draft.watch, watchRun, ctx.now)
      if (!watchRun.ok) errors.push(`watch.sql: ${failedQuery(watchRun)}`)
      else {
        checkWatchResult(draft, watchRun, columnsNamed, errors)
        // Only for a change that passed everything (its automation the person's own, of this kind).
        if (errors.length === 0 && draft.replacesAutomationId) await describeChange(ctx, draft, watchRun, backtest)
      }
    } else if (draft.kind === 'report' && draft.schedule && sectionsOk && linkedOk && !(draft.schedule.report && errors.length > 0)) {
      const linked = !!draft.schedule.report
      const ran = await withQueryOrigin({ source: 'automation', userId: ctx.creatorId, purpose: draft.name }, () => reportBacktest(pool, draft.schedule!, ctx))
      if ('error' in ran) errors.push(`schedule.report: ${ran.error}`)
      else {
        backtest = ran.backtest
        ran.runs.forEach((run, i) => {
          if (run.ok) return
          const title = quoted(ran.backtest.sections![i].title)
          errors.push(linked ? `schedule.report: its section ${title}: ${failedQuery(run)}` : `schedule.sections[${i}] (${title}): ${failedQuery(run)}`)
        })
        errors.push(...ran.chartProblems)
      }
    }
  } else if (draft.kind === 'watch' && draft.watch && ctx.knownColumns) {
    checkColumns(draft, ctx.knownColumns, columnsNamed, errors)
  }

  if (errors.length > 0) return { ok: false, errors, draft, backtest }
  return { ok: true, draft, backtest, watchRun: watchRun && watchRun.ok ? watchRun : null }
}

/** The draft with its words tidied and its lists de-duplicated: what is stored and shown. */
function normalise(d: AutomationDraft): AutomationDraft {
  const out: AutomationDraft = {
    kind: d.kind,
    name: oneLine(d.name),
    description: d.description.trim(),
    language: d.language,
    recipients: dedupeRecipients(d.recipients),
    channels: { bell: d.channels.bell, chat: d.channels.chat },
    actions: d.actions.followUp
      ? { notify: d.actions.notify, followUp: { assignee: normaliseAssignee(d.actions.followUp.assignee), dueHours: d.actions.followUp.dueHours } }
      : { notify: d.actions.notify, followUp: null },
  }
  if (d.watch) {
    const w: AutomationWatchSpec = {
      sql: d.watch.sql.trim(),
      keyColumn: d.watch.keyColumn.trim(),
      everyMinutes: d.watch.everyMinutes,
      titleTemplate: oneLine(d.watch.titleTemplate),
    }
    if (d.watch.hours) w.hours = { from: String(d.watch.hours.from ?? '').trim(), to: String(d.watch.hours.to ?? '').trim() }
    if (d.watch.weekdays !== undefined) w.weekdays = [...new Set(d.watch.weekdays)].sort((a, b) => a - b)
    const body = d.watch.bodyTemplate?.trim()
    if (body) w.bodyTemplate = body
    for (const k of ['sessionColumn', 'sampleColumn', 'orderColumn'] as const) {
      const v = d.watch[k]?.trim()
      if (v) w[k] = v
    }
    out.watch = w
  }
  if (d.schedule) {
    const s: AutomationScheduleSpec = {
      cadence: d.schedule.cadence,
      time: d.schedule.time.trim(),
      // A chart as asked for, until the trial run checks it against the section's result (reportBacktest).
      sections: (d.schedule.sections ?? []).map((x) => (x.chart ? { title: oneLine(x.title), sql: x.sql.trim(), chart: x.chart } : { title: oneLine(x.title), sql: x.sql.trim() })),
      summary: d.schedule.summary,
    }
    // Its values are checked, and made what is stored, against the report's inputs (checkLinkedReport).
    if (d.schedule.report) s.report = { reportId: String(d.schedule.report.reportId ?? '').trim(), inputs: d.schedule.report.inputs ?? {} }
    if (d.schedule.weekdays !== undefined) s.weekdays = [...new Set(d.schedule.weekdays)].sort((a, b) => a - b)
    if (d.schedule.weekday !== undefined) s.weekday = d.schedule.weekday
    if (d.schedule.monthDay !== undefined) s.monthDay = d.schedule.monthDay
    if (d.schedule.period) s.period = d.schedule.period
    out.schedule = s
  }
  if (d.replacesAutomationId) out.replacesAutomationId = d.replacesAutomationId.trim()
  // Which proposal it revises is checked against its conversation when it is proposed (proposals.ts: checkRevision).
  if (d.revisesProposalId?.trim()) out.revisesProposalId = d.revisesProposalId.trim().toLowerCase()
  return out
}

/** User ids in the database's own (lower) case, names trimmed: compared as they are stored. */
function normaliseAssignee(a: AutomationAssignee): AutomationAssignee {
  if (a.kind === 'user') return { kind: 'user', userId: a.userId.trim().toLowerCase() }
  if (a.kind === 'column') return { kind: 'column', column: a.column.trim() }
  return { kind: 'creator' }
}

function dedupeRecipients(list: AutomationRecipient[]): AutomationRecipient[] {
  const seen = new Set<string>()
  const out: AutomationRecipient[] = []
  for (const r of list) {
    const clean: AutomationRecipient =
      r.kind === 'user' ? { kind: 'user', userId: r.userId.trim().toLowerCase() } : r.kind === 'role' ? { kind: 'role', role: r.role } : { kind: 'column', column: r.column.trim() }
    const key = JSON.stringify(clean)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/** The watch's own fields; whether its SQL may be run. */
function checkWatch(w: AutomationWatchSpec, errors: string[]): boolean {
  if (!Number.isInteger(w.everyMinutes) || w.everyMinutes < AUTOMATION_MIN_EVERY_MINUTES || w.everyMinutes > AUTOMATION_MAX_EVERY_MINUTES) {
    errors.push(`watch.everyMinutes: from ${AUTOMATION_MIN_EVERY_MINUTES} to ${AUTOMATION_MAX_EVERY_MINUTES} minutes.`)
  }
  if (w.hours) {
    const problem = hoursProblem(w.hours)
    if (problem) errors.push(problem)
  }
  if (w.weekdays && (w.weekdays.length === 0 || w.weekdays.some((d) => !isAutomationWeekday(d)))) {
    errors.push('watch.weekdays: the days it runs, each 0 (Sunday) to 6 (Saturday); leave it out for every day.')
  }
  if (!w.titleTemplate) errors.push('watch.titleTemplate: give each case a title, e.g. "Hold on {{machine}}: {{defect}}".')
  else if (chars(w.titleTemplate) > AUTOMATION_TEMPLATE_MAX) errors.push(`watch.titleTemplate: at most ${AUTOMATION_TEMPLATE_MAX} characters.`)
  if (w.bodyTemplate && chars(w.bodyTemplate) > AUTOMATION_TEMPLATE_MAX) errors.push(`watch.bodyTemplate: at most ${AUTOMATION_TEMPLATE_MAX} characters.`)
  if (!w.keyColumn) errors.push('watch.keyColumn: name the result column whose value identifies a case.')
  const pre = precheckSql(w.sql)
  if ('error' in pre) {
    errors.push(`watch.sql: ${pre.error}`)
    return false
  }
  return true
}

/** Why a watch's hours are not a stretch of the day (two HH:MM times that differ), or null when they are. */
function hoursProblem(h: { from: string; to: string }): string | null {
  if (!isAutomationTime(h.from) || !isAutomationTime(h.to)) {
    return 'watch.hours: from and to as HH:MM on the 24-hour clock, factory time, e.g. {"from": "05:00", "to": "10:00"}; leave hours out to run around the clock.'
  }
  if (h.from === h.to) return 'watch.hours: from and to are the same time; give a later to (an earlier one crosses midnight), or leave hours out to run around the clock.'
  return null
}

/** The schedule and its sections; whether every section may be run. */
function checkSchedule(s: AutomationScheduleSpec, errors: string[]): boolean {
  if (!isAutomationTime(s.time)) errors.push('schedule.time: HH:MM on the 24-hour clock, factory time, e.g. "07:30".')
  const days = s.weekdays
  if (s.cadence === 'daily') {
    if (days && (days.length === 0 || days.some((d) => !isAutomationWeekday(d)))) {
      errors.push('schedule.weekdays: the days it runs, each 0 (Sunday) to 6 (Saturday); leave it out for every day.')
    }
  } else if (days !== undefined) errors.push(`schedule.weekdays: only a daily report takes weekdays; this one is ${s.cadence}.`)
  if (s.cadence === 'weekly') {
    if (!isAutomationWeekday(s.weekday)) errors.push('schedule.weekday: the day a weekly report runs, 0 (Sunday) to 6 (Saturday).')
  } else if (s.weekday !== undefined) errors.push(`schedule.weekday: only a weekly report takes one weekday; this one is ${s.cadence}.`)
  if (s.cadence === 'monthly') {
    if (!Number.isInteger(s.monthDay) || (s.monthDay ?? 0) < 1 || (s.monthDay ?? 0) > 28) errors.push('schedule.monthDay: the day of the month, 1 to 28 (every month has it).')
  } else if (s.monthDay !== undefined) errors.push(`schedule.monthDay: only a monthly report takes a day of the month; this one is ${s.cadence}.`)

  // A saved report's sections are its own, checked when it was saved (checkLinkedReport checks the rest).
  if (s.report) return true
  if (s.sections.length === 0 || s.sections.length > AUTOMATION_MAX_SECTIONS) {
    errors.push(`schedule.sections: from 1 to ${AUTOMATION_MAX_SECTIONS} sections, or a saved report to send (schedule.report).`)
    return false
  }
  let runnable = true
  s.sections.forEach((section, i) => {
    const where = `schedule.sections[${i}]`
    if (!section.title) errors.push(`${where}.title: give the section a title.`)
    else if (chars(section.title) > SECTION_TITLE_MAX) errors.push(`${where}.title: at most ${SECTION_TITLE_MAX} characters.`)
    const pre = precheckSql(section.sql)
    if ('error' in pre) {
      errors.push(`${where}.sql: ${pre.error}`)
      runnable = false
      return
    }
    const form = checkTemplate(section.sql)
    if (!form.ok) {
      errors.push(`${where}.sql: ${form.reason}. Write {{from}} and {{to}} on their own, in place of a date value.`)
      runnable = false
    } else if (form.placeholders > 0) {
      if (!s.period) {
        errors.push(`${where}.sql: it uses {{from}} and {{to}}, but the report has no period. Give the schedule a period, or write the query without them.`)
        runnable = false
      } else {
        const problem = periodProblem(section.sql)
        if (problem) {
          errors.push(`${where}.sql: ${problem}. Bound the data by both days, e.g. x_at >= ai.factory_day_start({{from}}) AND x_at < ai.factory_day_start({{to}} + 1).`)
          runnable = false
        }
      }
    }
  })
  return runnable
}

function checkActions(d: AutomationDraft, errors: string[]): void {
  const f = d.actions.followUp
  if (d.kind === 'report') {
    if (!d.actions.notify) errors.push('actions.notify: a report always tells its recipients; set it to true.')
    if (f) errors.push('actions.followUp: a report opens no follow-ups; set it to null.')
    return
  }
  if (!d.actions.notify && !f) errors.push('actions: a watch must tell people (notify), open a follow-up per case (followUp), or both.')
  if (f) {
    if (!Number.isInteger(f.dueHours) || f.dueHours < FOLLOW_UP_MIN_DUE_HOURS || f.dueHours > FOLLOW_UP_MAX_DUE_HOURS) {
      errors.push(`actions.followUp.dueHours: from ${FOLLOW_UP_MIN_DUE_HOURS} to ${FOLLOW_UP_MAX_DUE_HOURS} hours.`)
    }
    if (f.assignee.kind === 'user' && !UUID.test(f.assignee.userId)) errors.push(`actions.followUp.assignee.userId: ${quoted(f.assignee.userId)} is not a user id.`)
    if (f.assignee.kind === 'column' && !f.assignee.column) errors.push('actions.followUp.assignee.column: name the result column that holds the assignee\'s user id.')
  }
}

/** The recipients' count and form; the result columns they and the rest of the draft name. */
function checkRecipients(d: AutomationDraft, errors: string[]): Set<string> {
  const needed = d.kind === 'report' || d.actions.notify
  if (needed && d.recipients.length === 0) errors.push('recipients: name at least one person, role or (a watch) column of people to tell.')
  if (d.recipients.length > AUTOMATION_MAX_RECIPIENTS) errors.push(`recipients: at most ${AUTOMATION_MAX_RECIPIENTS}.`)
  const columns = new Set<string>()
  d.recipients.forEach((r, i) => {
    if (r.kind === 'user' && !UUID.test(r.userId)) errors.push(`recipients[${i}].userId: ${quoted(r.userId)} is not a user id.`)
    if (r.kind === 'column') {
      if (d.kind === 'report') errors.push(`recipients[${i}]: a report has no case rows; name people or roles.`)
      else if (!r.column) errors.push(`recipients[${i}].column: name the result column that holds user ids.`)
      else columns.add(r.column)
    }
  })
  return columns
}

/** The people named exist and can be told: active, not removed, not the system sender. */
async function checkPeople(q: Queryable, d: AutomationDraft, errors: string[]): Promise<void> {
  const named: { where: string; id: string }[] = []
  d.recipients.forEach((r, i) => {
    if (r.kind === 'user' && UUID.test(r.userId)) named.push({ where: `recipients[${i}].userId`, id: r.userId })
  })
  const a = d.kind === 'watch' ? d.actions.followUp?.assignee : undefined
  if (a?.kind === 'user' && UUID.test(a.userId)) named.push({ where: 'actions.followUp.assignee.userId', id: a.userId })
  if (named.length === 0) return
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND deleted_at IS NULL AND NOT is_system`,
    [[...new Set(named.map((n) => n.id.toLowerCase()))]],
  )
  const ok = new Set(rows.map((r) => r.id.toLowerCase()))
  for (const n of named) if (!ok.has(n.id.toLowerCase())) errors.push(`${n.where}: no active account has the id ${n.id}.`)
}

/** A change names the creator's own automation of the same kind; and the creator has room for one more. */
async function checkOwnership(ctx: ValidationContext, d: AutomationDraft, errors: string[]): Promise<void> {
  const replaces = d.replacesAutomationId ?? null
  if (replaces) {
    if (!UUID.test(replaces)) errors.push(`replacesAutomationId: ${quoted(replaces)} is not an automation id.`)
    else {
      const { rows } = await ctx.db.query<{ kind: string }>(`SELECT kind FROM ai_automations WHERE id = $1 AND creator_id = $2 AND deleted_at IS NULL`, [replaces, ctx.creatorId])
      if (!rows[0]) {
        errors.push(
          ctx.readBy === 'person'
            ? 'The automation this proposal changes no longer exists.'
            : "replacesAutomationId: none of this person's automations has that id (my_automations lists them).",
        )
      } else if (rows[0].kind !== d.kind) errors.push(`replacesAutomationId: that automation is a ${rows[0].kind}; a change keeps its kind.`)
    }
  }
  // A change of one already counted takes no room.
  if (replaces || ctx.editing) return
  const { rows } = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_automations WHERE creator_id = $1 AND deleted_at IS NULL`, [ctx.creatorId])
  if (rows[0].n >= AUTOMATION_MAX_PER_CREATOR) {
    errors.push(
      ctx.readBy === 'person'
        ? `You already have ${AUTOMATION_MAX_PER_CREATOR} automations, the most allowed. Delete one first.`
        : `This person already has ${AUTOMATION_MAX_PER_CREATOR} automations, the most allowed. Delete one, or change one of them instead.`,
    )
  }
}

/** Whether a change of a watch keeps what its cases are: the same query, keyed by the same column. Its cases carry on: none is recorded afresh. */
export const keepsCases = (before: AutomationWatchSpec | null | undefined, after: AutomationWatchSpec | null | undefined): boolean =>
  !!before && !!after && before.sql === after.sql && before.keyColumn === after.keyColumn

/** What a change of a watch means for the cases matching now: how many its automation has not told yet, and whether its cases carry on. */
async function describeChange(ctx: ValidationContext, d: AutomationDraft, run: QueryRun, backtest: AutomationBacktest): Promise<void> {
  const { rows } = await ctx.db.query<{ watch: AutomationWatchSpec | null }>(
    `SELECT watch FROM ai_automations WHERE id = $1 AND creator_id = $2 AND deleted_at IS NULL AND kind = 'watch'`,
    [d.replacesAutomationId, ctx.creatorId],
  )
  if (!rows[0]) return
  const at = run.columns.indexOf(d.watch!.keyColumn)
  const keys = [...new Set(run.rows.map((r) => caseKey(r[at])).filter((k): k is string => k !== null))]
  const told = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_automation_hits WHERE automation_id = $1 AND case_key = ANY($2::text[])`, [
    d.replacesAutomationId,
    keys,
  ])
  backtest.newCases = keys.length - told.rows[0].n
  backtest.keepsCases = keepsCases(rows[0].watch, d.watch)
}

/** What a failed query run says about itself: the model's sentence, and what it was. */
export type QueryFailed = Pick<QueryRun, 'error' | 'failure' | 'code' | 'dbMessage'>

/** A database message quoted to people is cut here: it may quote a value. */
const DB_MESSAGE_CHARS = 200

/** A query's failure in the words the model needs: a grant refused is the person's data, not a typo. */
export function queryErrorForModel(run: QueryFailed): string {
  if (run.code === '42501') return 'it reads data this person cannot read. Use only the views described in the system prompt.'
  return run.error ?? 'the query failed.'
}

/**
 * A query's failure as people read it — on a card, in a run's history, in
 * the automation's status, in the alert that it stopped, in a delivered
 * report: what went wrong, in a sentence, and never what the model is told
 * to do about it. `reader`: an automation's (its creator's data), or the
 * person who asked for it, reading their own card or activation.
 */
export function queryErrorForPeople(run: QueryFailed, reader: 'creator' | 'asker' = 'creator'): string {
  switch (run.failure) {
    case 'database': {
      if (run.code === '42501') return reader === 'asker' ? 'It reads data you cannot read.' : 'It reads data its creator can no longer read.'
      const said = oneLine(run.dbMessage ?? '')
      if (!said) return 'The query failed.'
      const short = cutChars(said, DB_MESSAGE_CHARS, true)
      return `The query failed: ${/[.!?…]$/.test(short) ? short : `${short}.`}`
    }
    case 'timeout':
      return 'The query took too long and was stopped.'
    case 'row-too-large':
      return 'A row of its result was too large to read.'
    case 'reply-too-large':
      return "The database's reply was too large to read."
    case 'stopped':
      return 'The query was stopped before it finished.'
    case 'busy':
      return 'Another long analysis was running; it can run again in a few minutes.'
    case 'unavailable':
      return "The factory's data could not be reached just now."
    case 'rejected':
      return 'The app no longer accepts this query.'
    default:
      return 'The query failed.'
  }
}

/** Every column the draft names is in the result. */
function checkColumns(d: AutomationDraft, columns: readonly string[], recipientColumns: Set<string>, errors: string[]): void {
  const w = d.watch
  if (!w) return
  const has = (c: string) => columns.includes(c)
  const list = columns.map((c) => `"${c}"`).join(', ')
  if (w.keyColumn && !has(w.keyColumn)) errors.push(`watch.keyColumn: the result has no column "${w.keyColumn}" (it has ${list}).`)
  for (const [field, template] of [
    ['titleTemplate', w.titleTemplate],
    ['bodyTemplate', w.bodyTemplate ?? ''],
  ] as const) {
    for (const p of templatePlaceholders(template)) if (!has(p)) errors.push(`watch.${field}: {{${p}}} is not a column of the result (it has ${list}).`)
  }
  for (const k of ['sessionColumn', 'sampleColumn', 'orderColumn'] as const) {
    const c = w[k]
    if (c && !has(c)) errors.push(`watch.${k}: the result has no column "${c}".`)
  }
  for (const c of recipientColumns) if (!has(c)) errors.push(`recipients: the result has no column "${c}" to take people from.`)
  const a = d.actions.followUp?.assignee
  if (a?.kind === 'column' && a.column && !has(a.column)) errors.push(`actions.followUp.assignee.column: the result has no column "${a.column}".`)
}

/** What a watch's result must be: its columns as named, and its key unique and never empty. */
function checkWatchResult(d: AutomationDraft, run: QueryRun, recipientColumns: Set<string>, errors: string[]): void {
  checkColumns(d, run.columns, recipientColumns, errors)
  const w = d.watch!
  const at = run.columns.indexOf(w.keyColumn)
  if (at < 0) return
  if (run.columns.lastIndexOf(w.keyColumn) !== at) {
    errors.push(`watch.keyColumn: two columns of the result are named "${w.keyColumn}"; give them different names.`)
    return
  }
  const seen = new Set<string>()
  const repeated = new Set<string>()
  let empty = 0
  for (const row of run.rows) {
    const key = caseKey(row[at])
    if (key === null) empty++
    else if (seen.has(key)) repeated.add(key)
    else seen.add(key)
  }
  if (empty > 0) errors.push(`watch.keyColumn: "${w.keyColumn}" is empty in ${empty} of the ${run.rows.length} rows; a case needs a key. Choose a column that always has a value.`)
  if (repeated.size > 0) {
    const examples = [...repeated].slice(0, 3).map(quoted).join(', ')
    errors.push(`watch.keyColumn: "${w.keyColumn}" repeats (${examples}${repeated.size > 3 ? ', …' : ''}); each row must be one case with its own key. Choose a column unique per row, or return one row per case.`)
  }
}

const sampleCell = (c: AiCell): AiCell => (typeof c === 'string' ? cutChars(c, SAMPLE_CELL_CHARS, true) : c)

/** A watch run once: how many cases match now, a few of them, and how the first reads as a message. */
export function watchBacktest(w: AutomationWatchSpec, run: QueryRun, now: Date): AutomationBacktest {
  // On the card of the person who asked for it.
  if (!run.ok) return { ranAt: now.toISOString(), ok: false, error: queryErrorForPeople(run, 'asker') }
  const sampleRows = run.rows.slice(0, AUTOMATION_BACKTEST_SAMPLE_ROWS).map((r) => r.map(sampleCell))
  const bt: AutomationBacktest = { ranAt: now.toISOString(), ok: true, matched: run.rows.length, truncated: run.truncated, columns: run.columns, sampleRows }
  const first = run.rows[0]
  if (first) {
    // As the alerts will read: each value set apart, so an order number keeps its order in an Arabic title.
    bt.sampleTitle = fillCaseTemplate(w.titleTemplate, run.columns, first)
    if (w.bodyTemplate) bt.sampleBody = fillCaseTemplate(w.bodyTemplate, run.columns, first)
  }
  return bt
}

/** The period a report covers when it runs at `now`, in words too; null for one without a period. */
export function reportPeriodAt(s: Pick<AutomationScheduleSpec, 'period'>, now: Date, timeZone: string): { from: string; to: string; label: string } | null {
  if (!s.period) return null
  return { ...resolveAiPeriod(s.period, factoryDay(now, timeZone)), label: describeAiPeriod(s.period) }
}

/** A section's SQL for a run over `period`: its placeholders filled (checked when the draft was), or as written. */
export function sectionSql(sql: string, period: { from: string; to: string } | null): string {
  return period && /\{\{(?:from|to)\}\}/.test(sql) ? fillTemplate(sql, period) : sql
}

/**
 * A report run once over its period as of today: each section's first rows (no summary), and each section's run as
 * it went. Its own sections' charts are checked against today's result here; a saved report's were when it was saved
 * (each run draws them when its rows fit).
 */
async function reportBacktest(
  pool: pg.Pool,
  s: AutomationScheduleSpec,
  ctx: ValidationContext,
): Promise<{ backtest: AutomationBacktest; runs: QueryRun[]; chartProblems: string[] } | { error: string }> {
  const prepared = await prepareReport(ctx.db, ctx.creatorId, s, ctx.now, ctx.timeZone)
  if ('error' in prepared) return { error: prepared.error }
  const period = prepared.period
  const sections: AiReportSectionRun[] = []
  const runs: QueryRun[] = []
  const chartProblems: string[] = []
  for (const [i, ready] of prepared.sections.entries()) {
    // The schedule's own section (its chart checked here), or the saved report's as prepared.
    const section: PreparedSection | AutomationScheduleSpec['sections'][number] = s.report ? ready : s.sections[i]
    const run = await withQueryPurpose(section.title, () =>
      runReadOnlyQuery(pool, ready.sql, {
        maxRows: Math.min(BACKTEST_SECTION_ROWS, AI_PREVIEW_ROWS),
        timeoutMs: AUTOMATION_QUERY_TIMEOUT_MS,
        timeZone: ctx.timeZone,
        signal: ctx.signal,
      }),
    )
    runs.push(run)
    const preview = previewOf(run)
    const out: AiReportSectionRun = {
      title: section.title,
      ok: run.ok,
      columns: preview.columns,
      rows: preview.rows,
      rowCount: preview.rowCount,
      truncated: preview.truncated,
      ms: Math.round(run.ms),
    }
    // On the card of the person who asked for it.
    if (!run.ok) out.error = queryErrorForPeople(run, 'asker')
    if (ready.display) out.display = ready.display
    if (ready.tree) out.tree = ready.tree
    if (ready.note) out.note = ready.note
    if (s.report) {
      const chart = ready.chart && run.ok ? checkChart(ready.chart, preview).chart : undefined
      if (chart) out.chart = chart
    } else if (section.chart && run.ok) {
      // Its chart, checked against what the section returns today: kept as it is drawn, or a problem for the model to fix.
      const checked = checkChart(section.chart, preview)
      if (checked.chart) {
        section.chart = checked.chart
        out.chart = checked.chart
      } else {
        delete section.chart
        chartProblems.push(`schedule.sections[${sections.length}].chart (${quoted(section.title)}): ${checked.note ?? 'it cannot be drawn.'}`)
      }
    }
    sections.push(out)
  }
  const bt: AutomationBacktest = { ranAt: ctx.now.toISOString(), ok: sections.every((x) => x.ok), sections }
  if (period) bt.period = period
  return { backtest: bt, runs, chartProblems }
}
