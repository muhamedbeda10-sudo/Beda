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
// What the model wrote is not trusted to mean what the answer meant: each
// template is filled with the period as it stood on the day of the question
// and run beside the query it came from, and only when every one returns the
// very same result is the period kept adjustable. Anything less — a
// difference, an error, a placeholder out of place, the model not answering —
// and the report keeps the queries exactly as they ran, its period fixed, and
// says why.
//
// Reports are personal: someone else's report is "not found", never a hint
// that it exists.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk'
import type pg from 'pg'
import { z } from 'zod'
import {
  AI_EXPORT_MAX_ROWS,
  AI_MODEL,
  AI_PREVIEW_ROWS,
  AI_REPORT_MAX_DAYS,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  resolveAiPeriod,
  type AiDayRange,
  type AiReport,
  type AiReportExportResponse,
  type AiReportPeriod,
  type AiReportSection,
  type AiReportSectionRun,
  type AiReportSummary,
  type AiReportsResponse,
} from '@qc/shared/ai'
import type { Db, Queryable } from '../db/pool'
import { CHAT_QUERY_TIMEOUT_MS, recordCutOffUsage, usageOf, watchStream } from './assistant'
import type { AiModelClient, ModelMessage, ModelParams } from './model'
import { contextDay, conversationTitle, factoryDay } from './prompt'
import { checkTemplate, fillTemplate, ordersRows, rangeDays, sameResult } from './reportTemplate'
import { AI_EXPORT_LIMITS, exportRows, previewOf, runReadOnlyQuery } from './runQuery'
import { loadDisplayMessages, recordUsage, type UsageRecord } from './transcript'

/** The longest title a report may have. */
export const AI_REPORT_TITLE_CHARS = 120
/** A section of a report run again for Excel may take this long (as a query of an answer exported). */
export const REPORT_EXPORT_TIMEOUT_MS = 30_000

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
  conversationId?: string | null
  sections?: AiReportSection[]
}

const SUMMARY_COLUMNS = `r.id, r.title, r.question, r.period, r.adjustable, json_array_length(r.sections) AS "sectionCount",
       r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.last_run_at AS "lastRunAt"`
const REPORT_COLUMNS = `${SUMMARY_COLUMNS}, r.conversation_id AS "conversationId", r.sections`

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
  }
  if (r.lastRunAt) summary.lastRunAt = r.lastRunAt
  return summary
}

function toReport(r: ReportRow): AiReport {
  const report: AiReport = { ...toSummary(r), sections: (r.sections ?? []).map((s) => ({ title: s.title, sql: s.sql })) }
  if (r.conversationId) report.conversationId = r.conversationId
  return report
}

/** The person's own report, unless it was deleted. */
export async function findReport(q: Queryable, id: string, userId: string): Promise<AiReport | null> {
  const { rows } = await q.query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM ai_reports r WHERE r.id = $1 AND r.user_id = $2 AND r.deleted_at IS NULL`, [id, userId])
  return rows[0] ? toReport(rows[0]) : null
}

/** The report an answer was already saved as, if it was. */
export async function findReportOfTurn(q: Queryable, turnId: string, userId: string): Promise<AiReport | null> {
  const { rows } = await q.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM ai_reports r WHERE r.turn_id = $1 AND r.user_id = $2 AND r.deleted_at IS NULL`,
    [turnId, userId],
  )
  return rows[0] ? toReport(rows[0]) : null
}

/** The person's reports, last changed first; `search` matches the title or the question, ignoring case. */
export async function listReports(
  q: Queryable,
  userId: string,
  opts: { before: string | null; limit: number; search: string | null },
): Promise<AiReportsResponse> {
  const { rows } = await q.query<ReportRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM ai_reports r
      WHERE r.user_id = $1 AND r.deleted_at IS NULL AND ($2::timestamptz IS NULL OR r.updated_at < $2)
        AND ($4::text IS NULL OR strpos(lower(r.title), lower($4)) > 0 OR strpos(lower(r.question), lower($4)) > 0)
      ORDER BY r.updated_at DESC, r.id DESC LIMIT $3`,
    [userId, opts.before, opts.limit + 1, opts.search],
  )
  return { reports: rows.slice(0, opts.limit).map(toSummary), hasMore: rows.length > opts.limit }
}

export interface NewReport {
  userId: string
  conversationId: string
  turnId: string
  title: string
  question: string
  period: AiReportPeriod | null
  adjustable: boolean
  sections: AiReportSection[]
}

export async function insertReport(q: Queryable, r: NewReport): Promise<AiReport> {
  const { rows } = await q.query<ReportRow>(
    `INSERT INTO ai_reports AS r (user_id, conversation_id, turn_id, title, question, period, adjustable, sections)
     VALUES ($1, $2, $3, $4, $5, $6::json, $7, $8::json)
     RETURNING ${REPORT_COLUMNS}`,
    [r.userId, r.conversationId, r.turnId, r.title, r.question, r.period ? JSON.stringify(r.period) : null, r.adjustable, JSON.stringify(r.sections)],
  )
  return toReport(rows[0])
}

export async function renameReport(q: Queryable, id: string, title: string): Promise<AiReport> {
  const { rows } = await q.query<ReportRow>(`UPDATE ai_reports r SET title = $2 WHERE r.id = $1 RETURNING ${REPORT_COLUMNS}`, [id, title])
  return toReport(rows[0])
}

/** Removed from the person's list; the record stays (soft delete). */
export async function deleteReport(q: Queryable, id: string): Promise<void> {
  await q.query(`UPDATE ai_reports SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id])
}

/** Stamp a run; the report as it now reads. */
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
    sections.push({ title: part.purpose, sql: part.sql })
  }
  return { turnId, conversationId: turn.conversationId, status: turn.status, question: turn.question, askedOn, sections }
}

// ---- Making the period adjustable: the model's part ---------------------------------

/** Room for the model's thinking and the rewritten queries. */
const TEMPLATE_MAX_TOKENS = 8000
/** How long the model may take to answer. */
const TEMPLATE_TIMEOUT_MS = 120_000

const PERIOD_KINDS = ['today', 'yesterday', 'last_days', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_year', 'fixed'] as const
const WEEK_STARTS = ['saturday', 'sunday', 'monday'] as const

export const TEMPLATE_SYSTEM_PROMPT = `You prepare a saved report of a factory's quality-control database so that its period can be changed when it is run again.

The input is JSON: the question an administrator asked ("question"), the factory day it was asked on ("today", YYYY-MM-DD), and the PostgreSQL queries that answered it ("sections", each with its index, purpose and sql). Dates and times in the queries are factory time.

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

/** The one request that rewrites a report's queries. No tools; it answers in JSON. */
export function templateRequest(turn: Pick<SavedTurn, 'question' | 'askedOn' | 'sections'>): ModelParams {
  const input = {
    question: turn.question,
    today: turn.askedOn,
    sections: turn.sections.map((s, index) => ({ index, purpose: s.title, sql: s.sql })),
  }
  return {
    model: AI_MODEL,
    max_tokens: TEMPLATE_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TEMPLATE_SCHEMA } },
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
  disabled: `${KEPT} the AI assistant is switched off, so it could not be made adjustable.`,
  noKey: `${KEPT} the AI assistant has no API key, so it could not be made adjustable.`,
  noReader: `${KEPT} the assistant cannot reach its data right now to check an adjustable version.`,
  model: `${KEPT} Claude could not be reached to make it adjustable.`,
  keyRefused: `${KEPT} Anthropic refused the API key, so it could not be made adjustable.`,
  unusable: `${KEPT} Claude did not return a usable adjustable version of the queries.`,
  form: `${KEPT} Claude's adjustable version of the queries was not in the form allowed.`,
  noPlaceholder: `${KEPT} Claude found no period in the queries to make adjustable.`,
  slow: `${KEPT} checking an adjustable version took too long.`,
  originalFails: (title: string) => `${KEPT} the query ${named(title)} no longer runs, so an adjustable version could not be checked against it.`,
  templateFails: (title: string) => `${KEPT} the adjustable version of ${named(title)} did not run.`,
  tooLarge: (title: string) => `${KEPT} ${named(title)} returns too many rows to check an adjustable version against the answer.`,
  mismatch: (title: string) => `${KEPT} the adjustable version of ${named(title)} did not return the same result as the answer.`,
}

/** A period as the model gave it, in the shared type; null when it is not one. */
function toPeriod(p: NonNullable<z.infer<typeof ProposalSchema>['period']>): AiReportPeriod | null {
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
    await recordCutOffUsage(args.db, args.owner, stream, watch, args.params.max_tokens)
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
    return { notice: refused ? FIXED_NOTICE.keyRefused : FIXED_NOTICE.model, detail }
  } finally {
    clearTimeout(timer)
  }
  const usage = usageOf(message)
  await recordUsage(args.db, { ...args.owner, model: usage.model, tokens: usage.tokens, costUsd: usage.costUsd, requestId: stream.request_id ?? null })
  const proposal = readProposal(message, args.sectionCount)
  return 'problem' in proposal ? { notice: FIXED_NOTICE.unusable, detail: proposal.problem } : proposal
}

// ---- Making the period adjustable: the check ------------------------------------------

/** Rows each run of the check may read: more, and the two results cannot be told apart for sure. */
const VERIFY_MAX_ROWS = 10_000
/** The whole check, every section run twice, may take this long. */
const VERIFY_DEADLINE_MS = 60_000

export type Verified =
  /** Every template returned what its query did: the period can be changed. */
  | { kind: 'adjustable'; period: AiReportPeriod; sections: AiReportSection[] }
  /** The question has no period: nothing to change, nothing wrong. */
  | { kind: 'none' }
  | ({ kind: 'fixed' } & Fixed)

/**
 * Run each template, filled with the period as it stood on the day of the
 * question, beside the query it came from, now, in the sandbox; the same
 * result from every pair, and the period is adjustable. A section the model
 * left without placeholders keeps its query exactly as it ran.
 */
export async function verifyTemplates(args: {
  reader: pg.Pool | null
  timeZone: string
  sections: AiReportSection[]
  proposal: TemplateProposal
  askedOn: string
}): Promise<Verified> {
  const { period, templates } = args.proposal
  if (!period) return { kind: 'none' }
  const fixed = (notice: string, detail: string): Verified => ({ kind: 'fixed', notice, detail })
  const range = resolveAiPeriod(period, args.askedOn)
  const checked: { placeholders: number }[] = []
  for (const [i, template] of templates.entries()) {
    const check = checkTemplate(template)
    if (!check.ok) return fixed(FIXED_NOTICE.form, `section ${i + 1}: ${check.reason}`)
    checked.push(check)
  }
  if (checked.every((c) => c.placeholders === 0)) return fixed(FIXED_NOTICE.noPlaceholder, `a period (${period.kind}) but no placeholder`)

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
      const opts = { maxRows: VERIFY_MAX_ROWS, timeoutMs: CHAT_QUERY_TIMEOUT_MS, timeZone: args.timeZone, signal: ac.signal }
      const asRan = await runReadOnlyQuery(args.reader, original.sql, opts)
      const asTemplate = await runReadOnlyQuery(args.reader, fillTemplate(templates[i], range), opts)
      if (ac.signal.aborted) return fixed(FIXED_NOTICE.slow, `over ${VERIFY_DEADLINE_MS / 1000} s`)
      if (!asRan.ok) return fixed(FIXED_NOTICE.originalFails(original.title), `section ${i + 1} as it ran: ${asRan.error}`)
      if (!asTemplate.ok) return fixed(FIXED_NOTICE.templateFails(original.title), `section ${i + 1} as a template: ${asTemplate.error}`)
      if (asRan.truncated || asTemplate.truncated) return fixed(FIXED_NOTICE.tooLarge(original.title), `section ${i + 1}: over ${VERIFY_MAX_ROWS} rows`)
      if (!sameResult(asRan, asTemplate, ordersRows(original.sql))) {
        return fixed(FIXED_NOTICE.mismatch(original.title), `section ${i + 1}: ${asRan.rows.length} rows as it ran, ${asTemplate.rows.length} as a template`)
      }
      sections.push({ title: original.title, sql: templates[i] })
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

/** A section's SQL for one run: a template filled with the run's days, or the query as it ran. */
function sectionSql(report: AiReport, section: AiReportSection, period: AiDayRange | null): string {
  return report.adjustable && period ? fillTemplate(section.sql, period) : section.sql
}

/** Every section run now, as the answer's cards show a query: the first rows, how many, and whether there were more. */
export async function runReportSections(
  reader: pg.Pool | null,
  report: AiReport,
  period: AiDayRange | null,
  opts: { timeZone: string; signal?: AbortSignal },
): Promise<AiReportSectionRun[]> {
  const out: AiReportSectionRun[] = []
  // One after another: the reader's few connections are shared with every answer being written.
  for (const section of report.sections) {
    const run = await runReadOnlyQuery(reader, sectionSql(report, section, period), {
      maxRows: AI_PREVIEW_ROWS,
      timeoutMs: CHAT_QUERY_TIMEOUT_MS,
      timeZone: opts.timeZone,
      signal: opts.signal,
    })
    const preview = previewOf(run)
    const result: AiReportSectionRun = {
      title: section.title,
      ok: run.ok,
      columns: preview.columns,
      rows: preview.rows,
      rowCount: preview.rowCount,
      truncated: preview.truncated,
      ms: Math.round(run.ms),
    }
    if (run.error) result.error = run.error
    out.push(result)
  }
  return out
}

/**
 * Every section run now in full, for Excel: up to AI_EXPORT_MAX_ROWS rows
 * each, all of them together within one export's room.
 */
export async function exportReportSections(
  reader: pg.Pool | null,
  report: AiReport,
  period: AiDayRange | null,
  opts: { timeZone: string; signal?: AbortSignal },
): Promise<AiReportExportResponse['sections']> {
  const out: AiReportExportResponse['sections'] = []
  let room = AI_EXPORT_LIMITS.maxChars
  for (const section of report.sections) {
    const run = await runReadOnlyQuery(reader, sectionSql(report, section, period), {
      maxRows: AI_EXPORT_MAX_ROWS,
      timeoutMs: REPORT_EXPORT_TIMEOUT_MS,
      timeZone: opts.timeZone,
      maxRowBytes: AI_EXPORT_LIMITS.maxRowBytes,
      maxChars: Math.max(1, room),
      signal: opts.signal,
    })
    const rows = exportRows(run)
    for (const row of rows) for (const c of row) room -= typeof c === 'string' ? c.length : 8
    const result: AiReportExportResponse['sections'][number] = { title: section.title, ok: run.ok, columns: run.columns, rows, truncated: run.truncated }
    if (run.error) result.error = run.error
    out.push(result)
  }
  return out
}
