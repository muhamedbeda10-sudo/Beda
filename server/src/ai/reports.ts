// ============================================================================
// §20 — saved reports ("My reports"). An answer that ran queries can be kept
// as a report: its successful queries, in order, each a section titled by
// what it looked for. Reopening a report runs the sections again now, through
// the same sandboxed runner as the chat; no model is called and nothing is
// spent.
//
// A report keeps the period of its question as asked ("the last 30 days"
// stays the last 30 days of the day it runs), and the person may run it over
// other days. For that the queries are rewritten once, when the report is
// saved, into templates over {{from}} and {{to}}, by one call to the model.
// What the model wrote is not trusted to mean what the answer meant. Each
// template must take its days from the period and from nothing else (read
// from its text: both placeholders bounding the data, no date or clock left
// over), and so must every query left without placeholders have no days of
// its own. Then each template is filled with the period the query covered and
// run beside it, and again over days that hold no data: only when every one
// returns the very same result as the query, and something other than what
// no data gives, is the period kept adjustable. Anything less — a day left
// over, a difference, an error, an answer that found nothing to check
// against, the model not answering — and the report keeps the queries
// exactly as they ran, its period fixed, and says why.
//
// A report is its maker's, unless it is shared (a report the assistant built
// for everyone, or one the app starts with): someone else's report that is not
// shared is "not found", never a hint that it exists. Only its maker renames,
// changes or deletes it. A report runs as the current domains of whoever runs
// it: a section over data they cannot read says so, and the rest still runs.
//
// The assistant builds reports of its own too (./reportTools), with inputs a
// run asks for besides the period (./reportInputs) and sections shown as a
// table, as headline figures or as a tree.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk'
import type pg from 'pg'
import { z } from 'zod'
import {
  AI_EXPORT_MAX_ROWS,
  AI_PREVIEW_ROWS,
  AI_REPORT_MAX_DAYS,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  resolveAiPeriod,
  type AiDayRange,
  type AiEffort,
  type AiModelId,
  type AiReport,
  type AiReportExportResponse,
  type AiReportPeriod,
  type AiReportSection,
  type AiReportSectionRun,
  type AiReportSummary,
  type AiReportsResponse,
  type AiReportMadeBy,
} from '@qc/shared/ai'
import type { AiReportInput, AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { Db, Queryable } from '../db/pool'
import { CHAT_QUERY_TIMEOUT_MS, recordCutOffUsage, usageOf, watchStream } from './assistant'
import { checkChart } from './charts'
import type { AiModelClient, ModelMessage, ModelParams } from './model'
import { contextDay, conversationTitle, factoryDay } from './prompt'
import { fillInputs } from './reportInputs'
import { checkTemplate, fillTemplate, noDataRange, ordersRows, ownDays, periodProblem, rangeDays, readsClock, sameResult } from './reportTemplate'
import { AI_EXPORT_LIMITS, AI_QUERY_TIMEOUT_MS, AI_REPORT_RUN_CHARS, AI_REPORT_RUN_ROWS, exportRows, previewOf, reportPreview, runReadOnlyQuery, type QueryRun, type RunOptions } from './runQuery'
import { withQueryPurpose } from './slowQueries'
import { loadDisplayMessages, recordUsage, type UsageRecord } from './transcript'

/** The longest title a report may have. */
export const AI_REPORT_TITLE_CHARS = 120
/** A section of a report run again for Excel may take this long (as a query of an answer exported). */
export const REPORT_EXPORT_TIMEOUT_MS = AI_QUERY_TIMEOUT_MS

// ---- Stored reports ---------------------------------------------------------------

interface ReportRow {
  id: string
  title: string
  question: string
  period: AiReportPeriod | null
  adjustable: boolean
  sectionCount: number
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  description: string | null
  shared: boolean
  mine: boolean
  ownerName: string
  madeBy: AiReportMadeBy
  inputCount: number
  conversationId?: string | null
  sections?: AiReportSection[]
  inputs?: AiReportInput[]
}

/** A report's columns as one person reads them ($2: who asks). */
const SUMMARY_COLUMNS = `r.id, r.title, r.question, r.period, r.adjustable, json_array_length(r.sections) AS "sectionCount",
       r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.last_run_at AS "lastRunAt",
       r.description, r.shared, (r.user_id = $2) AS mine, COALESCE(u.name, '') AS "ownerName", r.made_by AS "madeBy",
       json_array_length(r.inputs) AS "inputCount"`
const REPORT_COLUMNS = `${SUMMARY_COLUMNS}, r.conversation_id AS "conversationId", r.sections, r.inputs`
/** The reports a person may open: their own, and the shared ones. */
const VISIBLE = `r.deleted_at IS NULL AND (r.user_id = $2 OR r.shared)`
const FROM = `ai_reports r LEFT JOIN users u ON u.id = r.user_id`

function toSummary(r: ReportRow): AiReportSummary {
  const summary: AiReportSummary = {
    id: r.id,
    title: r.title,
    question: r.question,
    period: r.period ?? null,
    adjustable: r.adjustable,
    sectionCount: r.sectionCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    shared: r.shared,
    mine: r.mine,
    ownerName: r.ownerName,
    madeBy: r.madeBy,
    inputCount: r.inputCount,
  }
  if (r.lastRunAt) summary.lastRunAt = r.lastRunAt
  if (r.description) summary.description = r.description
  return summary
}

/** A section as kept: what it holds, and how it shows its rows when not as a table. */
function toSection(s: AiReportSection): AiReportSection {
  const out: AiReportSection = { title: s.title, sql: s.sql }
  if (s.chart) out.chart = s.chart
  if (s.display && s.display !== 'table') out.display = s.display
  if (s.tree) out.tree = s.tree
  if (s.note) out.note = s.note
  return out
}

function toReport(r: ReportRow): AiReport {
  const report: AiReport = { ...toSummary(r), sections: (r.sections ?? []).map(toSection), inputs: r.inputs ?? [] }
  if (r.conversationId) report.conversationId = r.conversationId
  return report
}

/** A report the person may open: their own, or a shared one; unless it was deleted. */
export async function findReport(q: Queryable, id: string, userId: string): Promise<AiReport | null> {
  const { rows } = await q.query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM ${FROM} WHERE r.id = $1 AND ${VISIBLE}`, [id, userId])
  return rows[0] ? toReport(rows[0]) : null
}

/** The report an answer was already saved as, if it was. */
export async function findReportOfTurn(q: Queryable, turnId: string, userId: string): Promise<AiReport | null> {
  const { rows } = await q.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM ${FROM} WHERE r.turn_id = $1 AND r.user_id = $2 AND r.deleted_at IS NULL AND r.made_by = 'answer'`,
    [turnId, userId],
  )
  return rows[0] ? toReport(rows[0]) : null
}

/** The reports a person may open (their own and the shared ones), last changed first; `search` matches the title or the question, ignoring case. */
export async function listReports(
  q: Queryable,
  userId: string,
  opts: { before: string | null; beforeId?: string | null; limit: number; search: string | null },
): Promise<AiReportsResponse> {
  // The page's cursor comes back at the API's millisecond precision, so compare at that precision, the id breaking ties.
  const { rows } = await q.query<ReportRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM ${FROM}
      WHERE ${VISIBLE}
        AND ($1::timestamptz IS NULL
             OR ($5::uuid IS NULL AND date_trunc('milliseconds', r.updated_at) < $1)
             OR ($5::uuid IS NOT NULL AND (date_trunc('milliseconds', r.updated_at), r.id) < ($1, $5::uuid)))
        AND ($4::text IS NULL OR strpos(lower(r.title), lower($4)) > 0 OR strpos(lower(r.question), lower($4)) > 0)
      ORDER BY date_trunc('milliseconds', r.updated_at) DESC, r.id DESC LIMIT $3`,
    [opts.before, userId, opts.limit + 1, opts.search, opts.beforeId ?? null],
  )
  return { reports: rows.slice(0, opts.limit).map(toSummary), hasMore: rows.length > opts.limit }
}

export interface NewReport {
  /** Given for a report built by the assistant, whose card names it before it is kept. */
  id?: string
  userId: string
  conversationId: string | null
  turnId: string | null
  title: string
  question: string
  period: AiReportPeriod | null
  adjustable: boolean
  sections: AiReportSection[]
  inputs?: AiReportInput[]
  shared?: boolean
  description?: string | null
  madeBy?: AiReportMadeBy
  starterKey?: string
}

export async function insertReport(q: Queryable, r: NewReport): Promise<AiReport> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO ai_reports (id, user_id, conversation_id, turn_id, title, question, period, adjustable, sections, inputs, shared, description, made_by, starter_key)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::json, $8, $9::json, $10::json, $11, $12, $13, $14)
     RETURNING id`,
    [
      r.id ?? null,
      r.userId,
      r.conversationId,
      r.turnId,
      r.title,
      r.question,
      r.period ? JSON.stringify(r.period) : null,
      r.adjustable,
      JSON.stringify(r.sections.map(toSection)),
      JSON.stringify(r.inputs ?? []),
      r.shared ?? false,
      r.description ?? null,
      r.madeBy ?? 'answer',
      r.starterKey ?? null,
    ],
  )
  return (await findReport(q, rows[0].id, r.userId))!
}

/** What the assistant changes of a report it built: all of it but its maker. */
export interface ReportChanges {
  title: string
  description: string | null
  period: AiReportPeriod | null
  adjustable: boolean
  sections: AiReportSection[]
  inputs: AiReportInput[]
  shared: boolean
}

export async function changeReport(q: Queryable, id: string, userId: string, c: ReportChanges): Promise<AiReport> {
  await q.query(
    `UPDATE ai_reports SET title = $2, description = $3, period = $4::json, adjustable = $5, sections = $6::json, inputs = $7::json, shared = $8,
            made_by = CASE WHEN made_by = 'answer' THEN 'assistant' ELSE made_by END
      WHERE id = $1`,
    [id, c.title, c.description, c.period ? JSON.stringify(c.period) : null, c.adjustable, JSON.stringify(c.sections.map(toSection)), JSON.stringify(c.inputs), c.shared],
  )
  return (await findReport(q, id, userId))!
}

export async function renameReport(q: Queryable, id: string, title: string, userId: string): Promise<AiReport> {
  await q.query(`UPDATE ai_reports SET title = $2 WHERE id = $1`, [id, title])
  return (await findReport(q, id, userId))!
}

/** Removed from the person's list; the record stays (soft delete). */
export async function deleteReport(q: Queryable, id: string): Promise<void> {
  await q.query(`UPDATE ai_reports SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id])
}

/** Stamp a run (anyone's run of a shared report too); the report as it now reads. */
export async function markReportRun(q: Queryable, report: AiReport): Promise<AiReport> {
  const { rows } = await q.query<{ lastRunAt: string }>(`UPDATE ai_reports SET last_run_at = now() WHERE id = $1 RETURNING last_run_at AS "lastRunAt"`, [report.id])
  return rows[0] ? { ...report, lastRunAt: rows[0].lastRunAt } : report
}

/** A report's title as given, or the question's first words. */
export function reportTitle(given: string | null | undefined, question: string): string {
  const title = (given ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(title)
  if (chars.length === 0) return conversationTitle(question)
  return chars.length <= AI_REPORT_TITLE_CHARS ? title : `${chars.slice(0, AI_REPORT_TITLE_CHARS - 1).join('').trimEnd()}…`
}

// ---- The answer being saved --------------------------------------------------------

export interface SavedTurn {
  turnId: string
  conversationId: string
  status: 'running' | 'done'
  question: string
  /** The factory day the question was asked on, from its date line. */
  askedOn: string
  /** The answer's successful queries in the order they ran; the same SQL twice is kept once. */
  sections: AiReportSection[]
}

/** One of the person's answers, with what a report of it holds; null when it is not theirs or its conversation was deleted. */
export async function loadSavedTurn(q: Queryable, turnId: string, userId: string, timeZone: string): Promise<SavedTurn | null> {
  const { rows } = await q.query<{ conversationId: string; status: 'running' | 'done'; question: string; createdAt: string; context: string | null }>(
    `SELECT t.conversation_id AS "conversationId", t.status, t.question, t.created_at AS "createdAt",
            (SELECT m.content -> 0 ->> 'text' FROM ai_messages m WHERE m.turn_id = t.id AND m.kind = 'question' ORDER BY m.seq LIMIT 1) AS context
       FROM ai_turns t JOIN ai_conversations c ON c.id = t.conversation_id
      WHERE t.id = $1 AND t.user_id = $2 AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [turnId, userId],
  )
  const turn = rows[0]
  if (!turn) return null
  // The date line is how the model knew the day; a question stored without one counts from when it was asked.
  const askedOn = (turn.context ? contextDay(turn.context) : null) ?? factoryDay(new Date(turn.createdAt), timeZone)
  // In the order the answer showed them: the tool calls' order in the transcript, not the time stamps (one per call).
  const answer = (await loadDisplayMessages(q, turn.conversationId, turnId)).find((m) => m.role === 'assistant')
  const sections: AiReportSection[] = []
  for (const part of answer?.parts ?? []) {
    if (part.type !== 'query' || !part.ok) continue
    if (sections.some((s) => s.sql === part.sql)) continue
    // Drawn as the answer drew it: the chart goes with its section.
    sections.push(part.chart ? { title: part.purpose, sql: part.sql, chart: part.chart } : { title: part.purpose, sql: part.sql })
  }
  return { turnId, conversationId: turn.conversationId, status: turn.status, question: turn.question, askedOn, sections }
}

// ---- Making the period adjustable: the model's part ---------------------------------

/** Room for the model's thinking and the rewritten queries. */
const TEMPLATE_MAX_TOKENS = 8000
/** How long the model may take to answer. */
const TEMPLATE_TIMEOUT_MS = 120_000

export const PERIOD_KINDS = ['today', 'yesterday', 'last_days', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_year', 'fixed'] as const
export const WEEK_STARTS = ['saturday', 'sunday', 'monday'] as const

export const TEMPLATE_SYSTEM_PROMPT = `You prepare a saved report of a factory's quality-control database so that its period can be changed when it is run again.

The input is JSON: the question a person asked ("question"), the factory day it was asked on ("today", YYYY-MM-DD), and the PostgreSQL queries that answered it ("sections", each with its index, purpose and sql). Dates and times in the queries are factory time.

Return:
- title: a short name for the report, at most 80 characters, in the language of the question.
- period: the period the question is about, as it was asked, relative to the day it was asked; null when no query is limited to a period.
  kind is one of: today; yesterday; last_days (with days: "the last 30 days" is 30); this_week or last_week (with weekStart, the day the factory's week starts: saturday unless the question or the queries start it on sunday or monday); this_month; last_month; this_year; last_year; fixed (with from and to, YYYY-MM-DD: the dates the question named, e.g. "in September 2026" is 2026-09-01 to 2026-09-30). Fields a kind does not use are null.
- sections: one entry per input section, with its index and its template: the section's sql with the bounds of the period replaced by {{from}} (the period's first day, inclusive) and {{to}} (its last day, inclusive). When the report runs, each is replaced by a date literal, DATE 'YYYY-MM-DD'.

Rules for a template:
- Change nothing but the period's bounds: every other part of the query stays exactly as it is (columns, joins, filters, grouping, ordering, limits).
- Write the placeholders exactly as {{from}} and {{to}}, outside quotes and comments, each in place of a date value: recorded_at >= {{from}} AND recorded_at < {{to}} + 1; day BETWEEN {{from}} AND {{to}}; ai.production_between({{from}}, {{to}}, 'day').
- An exclusive end (< '2026-10-01') becomes < {{to}} + 1; an inclusive one (<= '2026-09-30', BETWEEN … AND '2026-09-30') becomes {{to}}.
- Bounds written with now(), current_date or intervals are replaced too, so that the template depends on {{from}} and {{to}} alone.
- Every template with the period uses both {{from}} and {{to}} and holds the data between them: a lower bound and an upper bound, or both days given to a function such as ai.production_between. A query bounded on one side only (recorded_at >= current_date - 6, "since a week ago") gets the other bound too: recorded_at >= {{from}} AND recorded_at < {{to}} + 1.
- Compare the placeholders with the data (a column, or an expression of one), never with each other or with constants alone.
- In a report with a period, no query keeps a day of its own, whether it has placeholders or not: no date or time written out ('2026-09-01', DATE '2026-09-01', '2026-09' for a month), no day made from numbers (make_date), and no reading of the clock (now(), current_date, current_timestamp, 'today'). Such a report cannot be made adjustable, and keeps its period fixed.
- Filled with the period as it stood on the day the question was asked, the template must return exactly what the query returned.
- A section whose query is not limited to the period keeps its sql unchanged, with no placeholder.
- Use no other placeholder, and no {{ or }} anywhere else.`

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

/** The answer's shape, held to by the API (structured outputs); checked again below all the same. */
export const TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short name for the report, at most 80 characters, in the language of the question.' },
    period: nullable({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...PERIOD_KINDS] },
        days: nullable({ type: 'integer', description: `last_days only: how many days, 1 to ${AI_REPORT_MAX_DAYS}.` }),
        from: nullable({ type: 'string', description: 'fixed only: the first day, YYYY-MM-DD.' }),
        to: nullable({ type: 'string', description: 'fixed only: the last day, YYYY-MM-DD.' }),
        weekStart: nullable({ type: 'string', enum: [...WEEK_STARTS], description: 'this_week and last_week only.' }),
      },
      required: ['kind', 'days', 'from', 'to', 'weekStart'],
      additionalProperties: false,
    }),
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, template: { type: 'string' } },
        required: ['index', 'template'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'period', 'sections'],
  additionalProperties: false,
}

const ProposalSchema = z.object({
  title: z.string(),
  period: z
    .object({
      kind: z.enum(PERIOD_KINDS),
      days: z.number().int().nullable().optional(),
      from: z.string().nullable().optional(),
      to: z.string().nullable().optional(),
      weekStart: z.enum(WEEK_STARTS).nullable().optional(),
    })
    .nullable(),
  sections: z.array(z.object({ index: z.number().int(), template: z.string() })),
})

/** The one request that rewrites a report's queries, on the person's own model. No tools; it answers in JSON. */
export function templateRequest(turn: Pick<SavedTurn, 'question' | 'askedOn' | 'sections'>, run: { model: AiModelId; effort: AiEffort }): ModelParams {
  const input = {
    question: turn.question,
    today: turn.askedOn,
    sections: turn.sections.map((s, index) => ({ index, purpose: s.title, sql: s.sql })),
  }
  return {
    model: run.model,
    max_tokens: TEMPLATE_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: run.effort, format: { type: 'json_schema', schema: TEMPLATE_SCHEMA } },
    system: [{ type: 'text', text: TEMPLATE_SYSTEM_PROMPT }],
    // JSON: the question and the SQL go in as values, whatever characters they hold.
    messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
  }
}

/** What the model proposed, in the API's terms. */
export interface TemplateProposal {
  title: string | null
  period: AiReportPeriod | null
  /** One per section, in the sections' order. */
  templates: string[]
}

/** Why the period stayed fixed: the sentence the person reads, and the detail for the log. */
export interface Fixed {
  notice: string
  detail: string
}

const KEPT = 'The period is kept as asked:'
/** A section's title inside a notice: one line, not too long. */
const named = (title: string) => {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim())
  return `“${chars.length <= 60 ? chars.join('') : `${chars.slice(0, 59).join('').trimEnd()}…`}”`
}

export const FIXED_NOTICE = {
  // Why the assistant itself could not help is the owner's to know (and fix): a person is told only that it could not.
  unavailable: `${KEPT} the assistant is not available right now, so it could not be made adjustable.`,
  noReader: `${KEPT} the assistant cannot reach its data right now to check an adjustable version.`,
  model: `${KEPT} Claude could not be reached to make it adjustable.`,
  unusable: `${KEPT} Claude did not return a usable adjustable version of the queries.`,
  form: `${KEPT} Claude's adjustable version of the queries was not in the form allowed.`,
  noPlaceholder: `${KEPT} Claude found no period in the queries to make adjustable.`,
  slow: `${KEPT} checking an adjustable version took too long.`,
  originalFails: (title: string) => `${KEPT} the query ${named(title)} no longer runs, so an adjustable version could not be checked against it.`,
  templateFails: (title: string) => `${KEPT} the adjustable version of ${named(title)} did not run.`,
  tooLarge: (title: string) => `${KEPT} ${named(title)} returns too many rows to check an adjustable version against the answer.`,
  mismatch: (title: string) => `${KEPT} the adjustable version of ${named(title)} did not return the same result as the answer.`,
  notFromPeriod: (title: string) => `${KEPT} Claude's adjustable version of ${named(title)} does not take its days from the chosen period alone.`,
  ownDays: (title: string) => `${KEPT} ${named(title)} counts days of its own, which Claude did not make adjustable.`,
  unproven: (title: string) => `${KEPT} ${named(title)} found nothing in the question's period to check an adjustable version against.`,
}

/** A period as the model writes one: a kind, and the fields that kind takes (the rest null or absent). */
export type ModelPeriod = NonNullable<z.infer<typeof ProposalSchema>['period']>

/** A period as the model gave it, in the shared type; null when it is not one. Automations' schedules take the same (§21). */
export function toPeriod(p: ModelPeriod): AiReportPeriod | null {
  switch (p.kind) {
    case 'last_days':
      return typeof p.days === 'number' && p.days >= 1 && p.days <= AI_REPORT_MAX_DAYS ? { kind: 'last_days', days: p.days } : null
    case 'this_week':
    case 'last_week':
      return { kind: p.kind, weekStart: p.weekStart ?? 'saturday' }
    case 'fixed': {
      if (!p.from || !p.to || !isAiDay(p.from) || !isAiDay(p.to) || p.from > p.to) return null
      if (rangeDays({ from: p.from, to: p.to }) > AI_REPORT_MAX_DAYS) return null
      return { kind: 'fixed', from: p.from, to: p.to }
    }
    default:
      return { kind: p.kind }
  }
}

/** The model's answer, read and checked; a reason when it is not usable. */
export function readProposal(message: ModelMessage, sectionCount: number): TemplateProposal | { problem: string } {
  if (message.stop_reason !== 'end_turn') return { problem: `the call ended with ${message.stop_reason ?? 'no stop reason'}` }
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { problem: 'the answer is not JSON' }
  }
  const parsed = ProposalSchema.safeParse(json)
  if (!parsed.success) return { problem: `the answer does not have the shape asked for (${parsed.error.issues[0]?.message ?? 'invalid'})` }
  const { title, period, sections } = parsed.data
  // Every section once, by its index.
  const templates: string[] = new Array<string>(sectionCount)
  for (const s of sections) {
    if (s.index < 0 || s.index >= sectionCount || templates[s.index] !== undefined) return { problem: `section index ${s.index} is out of place` }
    templates[s.index] = s.template
  }
  if (sections.length !== sectionCount) return { problem: `${sections.length} sections for ${sectionCount}` }
  let resolved: AiReportPeriod | null = null
  if (period) {
    resolved = toPeriod(period)
    if (!resolved) return { problem: `the period ${JSON.stringify(period)} is not one a report can have` }
  }
  // At most the 80 characters asked for, by characters: an Arabic letter or an emoji is never cut in half.
  const shortTitle = Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 80).join('').trimEnd()
  return { title: shortTitle || null, period: resolved, templates }
}

/** Who a call is counted against. */
type UsageOwner = Pick<UsageRecord, 'userId' | 'conversationId' | 'turnId'>

/**
 * Ask the model for templates, once. The call is counted in the month's spend
 * as soon as it ends (or as far as it got, when it fails). Never throws for
 * the model's sake: a failure is a reason to keep the period fixed.
 */
export async function proposeTemplates(args: {
  db: Db
  model: AiModelClient
  apiKey: string
  owner: UsageOwner
  params: ModelParams
  sectionCount: number
}): Promise<TemplateProposal | Fixed> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TEMPLATE_TIMEOUT_MS)
  timer.unref()
  const stream = args.model.stream(args.apiKey, args.params, { signal: ac.signal })
  const watch = watchStream(stream)
  let message: ModelMessage
  try {
    message = await stream.finalMessage()
  } catch (err) {
    // A stream that failed on its own may still be reading the response, which would go uncounted: stop it.
    if (!(err instanceof Anthropic.APIUserAbortError)) stream.abort()
    await recordCutOffUsage(args.db, args.owner, stream, watch, args.params)
    const detail =
      err instanceof Anthropic.APIUserAbortError
        ? `no answer within ${TEMPLATE_TIMEOUT_MS / 1000} s`
        : err instanceof Anthropic.APIError
          ? // The message and the request id only: an error's request details are never logged.
            `${err.constructor.name}${err.requestID ? ` (request ${err.requestID})` : ''}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
    const refused = err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
    return { notice: refused ? FIXED_NOTICE.unavailable : FIXED_NOTICE.model, detail }
  } finally {
    clearTimeout(timer)
  }
  const usage = usageOf(message, args.params.model)
  await recordUsage(args.db, { ...args.owner, model: usage.model, tokens: usage.tokens, costUsd: usage.costUsd, requestId: stream.request_id ?? null })
  const proposal = readProposal(message, args.sectionCount)
  return 'problem' in proposal ? { notice: FIXED_NOTICE.unusable, detail: proposal.problem } : proposal
}

// ---- Making the period adjustable: the check ------------------------------------------

/** Rows each run of the check may read: more, and the two results cannot be told apart for sure. */
const VERIFY_MAX_ROWS = 10_000
/** The whole check, every section run twice, may take this long: two of the slowest queries allowed. */
const VERIFY_DEADLINE_MS = 2 * AI_QUERY_TIMEOUT_MS

export type Verified =
  /** Every template returned what its query did: the period can be changed. */
  | { kind: 'adjustable'; period: AiReportPeriod; sections: AiReportSection[] }
  /** The question has no period: nothing to change, nothing wrong. */
  | { kind: 'none' }
  | ({ kind: 'fixed' } & Fixed)

/**
 * Whether the period can be kept adjustable. First the text: each template
 * takes its days from {{from}} and {{to}} alone, and each query left as it
 * ran has no days of its own (otherwise it would stay on the question's days
 * while the report shows others). Then, in the sandbox, each template is run
 * beside the query it came from, filled with the period that query covered:
 * the period as it stood on the day of the question, or today for a query
 * that counts from the clock (run now, it covers the period as it stands
 * today). The same result from every pair, and none of them what days with no
 * data give (a comparison that could not tell a right template from a wrong
 * one), and the period is adjustable.
 */
export async function verifyTemplates(args: {
  reader: pg.Pool | null
  timeZone: string
  sections: AiReportSection[]
  proposal: TemplateProposal
  /** The factory day the question was asked on. */
  askedOn: string
  /** The factory day it is now. */
  today: string
}): Promise<Verified> {
  const { period, templates } = args.proposal
  if (!period) return { kind: 'none' }
  const fixed = (notice: string, detail: string): Verified => ({ kind: 'fixed', notice, detail })
  const checked: { placeholders: number }[] = []
  for (const [i, template] of templates.entries()) {
    const check = checkTemplate(template)
    if (!check.ok) return fixed(FIXED_NOTICE.form, `section ${i + 1}: ${check.reason}`)
    checked.push(check)
  }
  if (checked.every((c) => c.placeholders === 0)) return fixed(FIXED_NOTICE.noPlaceholder, `a period (${period.kind}) but no placeholder`)
  // Read before anything runs: one run at one period cannot see a bound left out when the data there happens to agree.
  for (const [i, original] of args.sections.entries()) {
    if (checked[i].placeholders > 0) {
      const problem = periodProblem(templates[i])
      if (problem) return fixed(FIXED_NOTICE.notFromPeriod(original.title), `section ${i + 1}: ${problem}`)
    } else {
      const own = ownDays(original.sql)
      if (own) return fixed(FIXED_NOTICE.ownDays(original.title), `section ${i + 1}, left as it ran: ${own}`)
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), VERIFY_DEADLINE_MS)
  timer.unref()
  try {
    const sections: AiReportSection[] = []
    for (const [i, original] of args.sections.entries()) {
      if (checked[i].placeholders === 0) {
        sections.push(original)
        continue
      }
      const range = resolveAiPeriod(period, readsClock(original.sql) ? args.today : args.askedOn)
      const ordered = ordersRows(original.sql)
      const opts = { maxRows: VERIFY_MAX_ROWS, timeoutMs: CHAT_QUERY_TIMEOUT_MS, timeZone: args.timeZone, signal: ac.signal }
      const asRan = await withQueryPurpose(original.title, () => runReadOnlyQuery(args.reader, original.sql, opts))
      const asTemplate = await withQueryPurpose(original.title, () => runReadOnlyQuery(args.reader, fillTemplate(templates[i], range), opts))
      if (ac.signal.aborted) return fixed(FIXED_NOTICE.slow, `over ${VERIFY_DEADLINE_MS / 1000} s`)
      if (!asRan.ok) return fixed(FIXED_NOTICE.originalFails(original.title), `section ${i + 1} as it ran: ${asRan.error}`)
      if (!asTemplate.ok) return fixed(FIXED_NOTICE.templateFails(original.title), `section ${i + 1} as a template: ${asTemplate.error}`)
      if (asRan.truncated || asTemplate.truncated) return fixed(FIXED_NOTICE.tooLarge(original.title), `section ${i + 1}: over ${VERIFY_MAX_ROWS} rows`)
      if (!sameResult(asRan, asTemplate, ordered)) {
        return fixed(FIXED_NOTICE.mismatch(original.title), `section ${i + 1}: ${asRan.rows.length} rows as it ran, ${asTemplate.rows.length} as a template`)
      }
      // What the template gives over days no record reaches: the answer found nothing a wrong template would not find too.
      // (A run that fails or overflows there differs from the answer, which is all this asks.)
      const asNothing = await runReadOnlyQuery(args.reader, fillTemplate(templates[i], noDataRange(range)), opts)
      if (ac.signal.aborted) return fixed(FIXED_NOTICE.slow, `over ${VERIFY_DEADLINE_MS / 1000} s`)
      if (asNothing.ok && !asNothing.truncated && sameResult(asRan, asNothing, ordered)) {
        return fixed(FIXED_NOTICE.unproven(original.title), `section ${i + 1}: the answer is what days with no data give`)
      }
      sections.push({ ...original, sql: templates[i] })
    }
    return { kind: 'adjustable', period, sections }
  } finally {
    clearTimeout(timer)
  }
}

// ---- Running a report --------------------------------------------------------------------

export type RunPeriod = AiDayRange & { label: string; overridden: boolean }

/**
 * The days a run covers: those asked for, else the saved period counted from
 * `today` (a factory day). Null for a report whose period cannot change.
 */
export function runPeriod(report: AiReport, override: AiDayRange | null, today: string): RunPeriod | null {
  if (!report.adjustable || !report.period) return null
  if (override) return { from: override.from, to: override.to, label: describeAiDays(override), overridden: true }
  return { ...resolveAiPeriod(report.period, today), label: describeAiPeriod(report.period), overridden: false }
}

/** What a section over data the person can no longer read shows instead of its rows. */
export const NO_ACCESS = 'You no longer have access to this data.'

/**
 * Where a report's next section runs: the pool of the person's domains as
 * they are when it starts (the owner may change them while a report runs,
 * section after section), null when the readers are down, or 'withdrawn'
 * once the person may no longer use the assistant at all.
 */
export type SectionReader = () => Promise<pg.Pool | null | 'withdrawn'>

/** Run one section's SQL as the person's domains as they are now; a person stopped meanwhile reads nothing. */
async function runSection(reader: SectionReader, sql: string, opts: RunOptions): Promise<QueryRun> {
  const pool = await reader()
  if (pool === 'withdrawn') return { ok: false, columns: [], rows: [], truncated: false, ms: 0, error: NO_ACCESS }
  return runReadOnlyQuery(pool, sql, opts)
}

/** A run's error as the report shows it: refused for want of a grant, it is the person's access that changed. */
const sectionError = (run: { error?: string; code?: string }): string | undefined => (run.code === '42501' ? NO_ACCESS : run.error)

/**
 * A section's SQL for one run: a template filled with the run's days, or the query as it ran; then its inputs, from
 * the run's checked values. The days first: a value typed into an input is never read as a placeholder.
 */
export function sectionSql(report: Pick<AiReport, 'adjustable' | 'inputs'>, section: Pick<AiReportSection, 'sql'>, period: AiDayRange | null, values: AiReportInputValues = {}): string {
  const dated = report.adjustable && period ? fillTemplate(section.sql, period) : section.sql
  return report.inputs.length > 0 ? fillInputs(dated, report.inputs, values) : dated
}

/** Every section run now, as the answer's cards show a query: the first rows, how many, and whether there were more. */
export async function runReportSections(
  reader: SectionReader,
  report: AiReport,
  period: AiDayRange | null,
  opts: { timeZone: string; signal?: AbortSignal; values?: AiReportInputValues },
): Promise<AiReportSectionRun[]> {
  const out: AiReportSectionRun[] = []
  // One after another: the reader's few connections are shared with every answer being written.
  for (const section of report.sections) {
    const run = await withQueryPurpose(section.title, () =>
      runSection(reader, sectionSql(report, section, period, opts.values), {
        maxRows: AI_REPORT_RUN_ROWS,
        maxChars: AI_REPORT_RUN_CHARS,
        timeoutMs: CHAT_QUERY_TIMEOUT_MS,
        timeZone: opts.timeZone,
        signal: opts.signal,
      }),
    )
    // Every row read (up to AI_REPORT_RUN_ROWS): a report is read on a page, not by the model.
    const preview = reportPreview(run)
    const result: AiReportSectionRun = {
      title: section.title,
      ok: run.ok,
      columns: preview.columns,
      rows: preview.rows,
      rowCount: preview.rowCount,
      truncated: preview.truncated,
      ms: Math.round(run.ms),
    }
    if (section.display && section.display !== 'table') result.display = section.display
    if (section.tree) result.tree = section.tree
    if (section.note) result.note = section.note
    const error = sectionError(run)
    if (error) result.error = error
    // Drawn again from this run's rows, when they still fit the chart (another period may hold one row, or none).
    const chart = run.ok ? checkChart(section.chart, preview).chart : undefined
    if (chart) result.chart = chart
    out.push(result)
  }
  return out
}

/**
 * Every section run now in full, for Excel: up to AI_EXPORT_MAX_ROWS rows
 * each, all of them together within one export's room.
 */
export async function exportReportSections(
  reader: SectionReader,
  report: AiReport,
  period: AiDayRange | null,
  opts: { timeZone: string; signal?: AbortSignal; values?: AiReportInputValues },
): Promise<AiReportExportResponse['sections']> {
  const out: AiReportExportResponse['sections'] = []
  let room = AI_EXPORT_LIMITS.maxChars
  for (const section of report.sections) {
    const run = await withQueryPurpose(section.title, () =>
      runSection(reader, sectionSql(report, section, period, opts.values), {
        maxRows: AI_EXPORT_MAX_ROWS,
        timeoutMs: REPORT_EXPORT_TIMEOUT_MS,
        timeZone: opts.timeZone,
        maxRowBytes: AI_EXPORT_LIMITS.maxRowBytes,
        maxChars: Math.max(1, room),
        signal: opts.signal,
      }),
    )
    const rows = exportRows(run)
    for (const row of rows) for (const c of row) room -= typeof c === 'string' ? c.length : 8
    const result: AiReportExportResponse['sections'][number] = { title: section.title, ok: run.ok, columns: run.columns, rows, truncated: run.truncated }
    const error = sectionError(run)
    if (error) result.error = error
    out.push(result)
  }
  return out
}
