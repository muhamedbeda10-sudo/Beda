// ============================================================================
// §20 — the AI assistant: administrators ask about the factory's record in
// plain words; Claude answers by running read-only queries over the views in
// schema ai, and each query can be taken to Excel. Everything here is for
// administrators only; changing the key, the switch or the cap also needs
// the right to manage admin data, and both land in the audit log (the key
// never does — only its last four characters).
//
// A question is answered as a stream of Server-Sent Events. Every check that
// can refuse it (the body, the rate, the switch, the key, the cap, the
// conversation, a send repeated) runs before the stream opens, so a refusal
// is an ordinary JSON error; once it is open, a failure is an `error` event.
//
// An answer can be kept as a report (reports.ts): personal like the
// conversations, run again on demand through the same sandbox, its creation,
// renaming and removal in the audit log (the title only, never the SQL).
// ============================================================================

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  AI_EXPORT_MAX_ROWS,
  AI_MAX_MESSAGE_CHARS,
  AI_MAX_MONTHLY_CAP_USD,
  AI_MODEL,
  isAiDay,
  type AiConversationsResponse,
  type AiMessagesResponse,
  type AiQueryExportResponse,
  type AiReport,
  type AiReportExportResponse,
  type AiReportPeriod,
  type AiReportRunResponse,
  type AiReportSection,
  type AiReportsResponse,
  type AiSaveReportResponse,
  type AiSettings,
  type AiSettingsResponse,
  type AiStatusResponse,
  type AiUsageResponse,
} from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { PG, pgCode, withTransaction } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditChanges, writeAudit } from '../audit/service'
import { answerQuestion, describeModelFailure, minCallWorstCaseUsd, worstCaseUsd } from '../ai/assistant'
import { auditKeyLabel, last4, removeApiKey, storeApiKey, storedKeyTail } from '../ai/credentials'
import { RUN_SQL_TOOL, conversationTitle, factoryDay, questionContent, renderSystemPrompt } from '../ai/prompt'
import { rangeProblem } from '../ai/reportTemplate'
import {
  AI_REPORT_TITLE_CHARS,
  FIXED_NOTICE,
  deleteReport,
  exportReportSections,
  findReport,
  findReportOfTurn,
  insertReport,
  listReports,
  loadSavedTurn,
  markReportRun,
  proposeTemplates,
  renameReport,
  reportTitle,
  runPeriod,
  runReportSections,
  templateRequest,
  verifyTemplates,
} from '../ai/reports'
import { AI_EXPORT_LIMITS, exportRows, runReadOnlyQuery } from '../ai/runQuery'
import { describeAiSchema } from '../ai/schemaDoc'
import { AI_SETTINGS_KEY, loadAiSettings, loadAvailability } from '../ai/settings'
import { SseStream } from '../ai/sse'
import {
  appendMessages,
  createConversation,
  findConversation,
  finishTurn,
  listConversations,
  loadDisplayMessages,
  loadReplay,
  repairDanglingToolUse,
  toConversation,
  type ConversationRecord,
} from '../ai/transcript'

const uuid = z.string().uuid()
/** A query run again for Excel may take this long. */
const EXPORT_QUERY_TIMEOUT_MS = 30_000
/** A turn still "running" after this long was cut off by a restart: the next question closes it. */
const STALE_TURN_MINUTES = 6

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    monthlyCapUsd: z
      .number()
      .min(0)
      .max(AI_MAX_MONTHLY_CAP_USD)
      .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'The cap is in dollars and cents: at most two decimals.'),
  })
  .strict()

const keySchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20, 'That is too short for an Anthropic API key.')
      .max(300, 'That is too long for an Anthropic API key.')
      .regex(/^sk-ant-[A-Za-z0-9_-]+$/, 'An Anthropic API key starts with sk-ant- and has no spaces.'),
  })
  .strict()

const chatSchema = z.object({
  conversationId: uuid.optional(),
  message: z.string().trim().min(1, 'Write a question.').max(AI_MAX_MESSAGE_CHARS, `A question is at most ${AI_MAX_MESSAGE_CHARS} characters.`),
  clientId: z.string().min(8).max(80),
})

const conversationsQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// Years 2000–2999 only: outside them a month's bounds are not timestamps PostgreSQL takes (or Date.UTC moves them).
const usageQuery = z.object({ month: z.string().regex(/^2\d{3}-(0[1-9]|1[0-2])$/, 'A month is YYYY-MM, from 2000-01.').optional() })

/** A report's title: one line, 1 to 120 characters. */
const reportTitleSchema = z
  .string()
  .transform((t) => t.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Give the report a title.').max(AI_REPORT_TITLE_CHARS, `A report's title is at most ${AI_REPORT_TITLE_CHARS} characters.`))

const saveReportSchema = z
  .object({
    turnId: uuid,
    title: reportTitleSchema.optional(),
    adjustable: z.boolean().default(true),
  })
  .strict()

const renameReportSchema = z.object({ title: reportTitleSchema }).strict()

const reportsQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).optional(),
})

/**
 * The days a person runs a report over, both or neither. Only real calendar
 * days in YYYY-MM-DD pass: they become SQL date literals.
 */
const reportDay = z.string().refine(isAiDay, 'A day is YYYY-MM-DD, and a real date.')
const reportRunQuery = z
  .object({ from: reportDay.optional(), to: reportDay.optional() })
  .superRefine((v, issue) => {
    if ((v.from === undefined) !== (v.to === undefined)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Give both the first and the last day, or neither.' })
      return
    }
    const problem = v.from && v.to ? rangeProblem({ from: v.from, to: v.to }) : null
    if (problem) issue.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })
  .transform((v) => (v.from && v.to ? { from: v.from, to: v.to } : null))

/** The refusal for a question the assistant cannot take now, by why. */
function unavailable(status: AiStatusResponse): HttpError {
  switch (status.reason) {
    case 'cap-reached':
      return new HttpError(
        402,
        'ai_budget_reached',
        `This month's spending cap ($${status.capUsd.toFixed(2)}) is reached, or too close for an answer to start. An administrator can raise it under Administration → AI assistant.`,
      )
    case 'disabled':
      return new HttpError(503, 'ai_unavailable', 'The AI assistant is switched off. An administrator can switch it on under Administration → AI assistant.')
    case 'no-key':
      return new HttpError(503, 'ai_unavailable', 'The AI assistant has no API key. An administrator sets it under Administration → AI assistant.')
    default:
      return new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')
  }
}

/** The first instant of a YYYY-MM month and of the next one, in UTC. */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() }
}

export function aiRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const tz = ctx.config.FACTORY_TIMEZONE
  r.use(requireCapability('use-ai-assistant'))

  const availability = () => loadAvailability(db, ctx.config, ctx.aiReader.ready)

  async function settingsResponse(): Promise<AiSettingsResponse> {
    const a = await availability()
    return { settings: a.settings.settings, key: a.key, status: a.status, updatedAt: a.settings.updatedAt, updatedByName: a.settings.updatedByName }
  }

  // ---- Status, settings, key -------------------------------------------------------

  r.get('/status', async (_req, res) => {
    res.json((await availability()).status)
  })

  r.get('/settings', async (_req, res) => {
    res.json(await settingsResponse())
  })

  r.put('/settings', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(settingsSchema, req.body)
    const next: AiSettings = { enabled: body.enabled, monthlyCapUsd: Math.round(body.monthlyCapUsd * 100) / 100 }
    await withTransaction(db, async (tx) => {
      const before = (await loadAiSettings(tx)).settings
      await tx.query(
        `INSERT INTO app_settings (key, value, updated_by_id, updated_by_name, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id,
           updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [AI_SETTINGS_KEY, JSON.stringify(next), user.id, user.name],
      )
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'AppSettings', entityId: AI_SETTINGS_KEY }, { ...before }, { ...next })
    })
    res.json(await settingsResponse())
  })

  /** Set the key: Anthropic is asked first, and only a key it accepts is kept. */
  r.put('/key', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const { apiKey } = parse(keySchema, req.body)
    const check = await ctx.ai.verifyKey(apiKey)
    if (!check.ok) {
      if (check.reason === 'refused') throw badRequest('Anthropic refused this key.')
      if (check.reason === 'no-model') throw badRequest(`This key cannot use the assistant's model (${AI_MODEL}).`)
      throw new HttpError(503, 'ai_unavailable', 'Anthropic could not be reached to check the key. Try again in a minute.')
    }
    await withTransaction(db, async (tx) => {
      const before = await storedKeyTail(tx)
      await storeApiKey(tx, ctx.config, apiKey, user)
      await writeAudit(tx, [
        auditEvent('update', { userId: user.id, userName: user.name, entity: 'AiAssistant', entityId: 'api-key' }, new Date().toISOString(), {
          field: 'apiKey',
          oldValue: auditKeyLabel(before),
          newValue: auditKeyLabel(last4(apiKey)),
        }),
      ])
    })
    res.json(await settingsResponse())
  })

  r.delete('/key', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    await withTransaction(db, async (tx) => {
      const before = await storedKeyTail(tx)
      if (!(await removeApiKey(tx))) return
      await writeAudit(tx, [
        auditEvent('update', { userId: user.id, userName: user.name, entity: 'AiAssistant', entityId: 'api-key' }, new Date().toISOString(), {
          field: 'apiKey',
          oldValue: auditKeyLabel(before),
          newValue: 'removed',
        }),
      ])
    })
    res.json(await settingsResponse())
  })

  // ---- Conversations ------------------------------------------------------------------

  r.get('/conversations', async (req, res) => {
    const user = requireUser(req)
    const q = parse(conversationsQuery, req.query)
    const body: AiConversationsResponse = await listConversations(db, user.id, q.before ?? null, q.limit)
    res.json(body)
  })

  r.get('/conversations/:id/messages', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const conversation = await findConversation(db, id, user.id)
    if (!conversation) throw notFound('That conversation')
    const body: AiMessagesResponse = { conversation: toConversation(conversation), messages: await loadDisplayMessages(db, id) }
    res.json(body)
  })

  /** Removed from the person's list; the record stays (soft delete). */
  r.delete('/conversations/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { rowCount } = await db.query(`UPDATE ai_conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, user.id])
    if (!rowCount) throw notFound('That conversation')
    res.status(204).end()
  })

  // ---- Asking -------------------------------------------------------------------------

  r.post('/chat', async (req, res) => {
    // The browser leaving (or Stop) closes the response before it has ended; listened for from the
    // start, so leaving while the question is being set up counts too. Not req's close: that fires
    // as soon as the body is read.
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const user = requireUser(req)
    const body = parse(chatSchema, req.body)
    const wait = ctx.aiLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many questions in a short time. Try again in ${wait} seconds.`)
    const avail = await availability()
    if (!avail.status.available || !avail.apiKey) throw unavailable(avail.status)
    const apiKey = avail.apiKey

    // A new conversation's prompt carries the data dictionary as the catalog has it now, for good.
    const systemPrompt = body.conversationId ? null : renderSystemPrompt(tz, await describeAiSchema(db))
    // Gone already (Stop, or the connection lost, while the checks ran): nobody to answer, so nothing is kept.
    if (ac.signal.aborted) return
    const askedAt = new Date()
    const started = await withTransaction(db, async (tx) => {
      const repeated = await tx.query(`SELECT 1 FROM ai_turns WHERE user_id = $1 AND client_id = $2`, [user.id, body.clientId])
      if (repeated.rowCount) throw new HttpError(409, 'conflict', 'This question was already sent.')
      let conversation: ConversationRecord
      if (body.conversationId) {
        const found = await findConversation(tx, body.conversationId, user.id, true)
        if (!found) throw notFound('That conversation')
        conversation = found
        const running = await tx.query<{ id: string; stale: boolean }>(
          `SELECT id, created_at < now() - make_interval(mins => $2) AS stale FROM ai_turns WHERE conversation_id = $1 AND status = 'running'`,
          [conversation.id, STALE_TURN_MINUTES],
        )
        if (running.rows[0] && !running.rows[0].stale) throw new HttpError(409, 'conflict', 'Still answering the previous question. Wait for it, or stop it.')
        if (running.rows[0]) await finishTurn(tx, running.rows[0].id, 'error', 'This answer was cut off (the server restarted).')
      } else {
        conversation = await createConversation(tx, {
          userId: user.id,
          title: conversationTitle(body.message),
          model: AI_MODEL,
          systemPrompt: systemPrompt!,
          tools: [RUN_SQL_TOOL],
        })
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question) VALUES ($1, $2, $3, $4) RETURNING id`,
        [conversation.id, user.id, body.clientId, body.message],
      )
      const turnId = rows[0].id
      await repairDanglingToolUse(tx, conversation.id, turnId)
      const [question] = await appendMessages(tx, conversation.id, turnId, [{ role: 'user', kind: 'question', content: questionContent(body.message, askedAt, tz) }])
      const replay = await loadReplay(tx, conversation.id)
      const asked = (await findConversation(tx, conversation.id, user.id))!
      // The loop's own test before its first call (on what the loop is handed), made before anything is kept
      // or streamed: a question it would stop without calling the model is refused here, no turn left behind.
      if (avail.status.spentUsd + minCallWorstCaseUsd({ conversation: asked, messages: replay }) > avail.status.capUsd) {
        throw new HttpError(
          402,
          'ai_budget_reached',
          `Answering this could pass this month's spending cap ($${avail.status.capUsd.toFixed(2)}), so it was not started. ` +
            `${body.conversationId ? 'A new conversation costs less to start; ' : ''}an administrator can raise the cap under Administration → AI assistant.`,
        )
      }
      return { conversation: asked, turnId, questionId: question.id, replay }
    }).catch((e) => {
      // Two sends racing past the checks above: the database keeps one.
      if (pgCode(e) === PG.UNIQUE_VIOLATION) {
        const running = (e as { constraint?: string }).constraint === 'ai_turns_one_running'
        throw new HttpError(409, 'conflict', running ? 'Still answering the previous question. Wait for it, or stop it.' : 'This question was already sent.')
      }
      throw e
    })

    const { conversation, turnId } = started
    const sse = new SseStream(res)
    sse.open()
    try {
      sse.send({ type: 'start', conversation: toConversation(conversation), userMessageId: started.questionId })
      const outcome = await answerQuestion({
        db,
        reader: ctx.aiReader.pool,
        model: ctx.ai,
        apiKey,
        config: ctx.config,
        userId: user.id,
        conversation,
        turnId,
        messages: started.replay,
        capUsd: avail.status.capUsd,
        emit: (event) => sse.send(event),
        signal: ac.signal,
      })
      await finishTurn(db, turnId, outcome.stopReason, outcome.notice)
      const answer = (await loadDisplayMessages(db, conversation.id, turnId)).find((m) => m.role === 'assistant')!
      sse.send({ type: 'done', message: answer, status: (await availability()).status })
    } catch (e) {
      const failure = describeModelFailure(e, conversation.id)
      await finishTurn(db, turnId, 'error', failure.message).catch((err) => console.error('[ai] could not close a failed answer', err))
      sse.send({ type: 'error', code: failure.code, message: failure.message })
    } finally {
      sse.end()
    }
  })

  // ---- Excel ----------------------------------------------------------------------------

  /** A query of an answer, run again now in full (up to AI_EXPORT_MAX_ROWS rows). */
  r.get('/queries/:id/export', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { rows } = await db.query<{ purpose: string; sql: string }>(
      `SELECT q.purpose, q.sql FROM ai_queries q JOIN ai_conversations c ON c.id = q.conversation_id
        WHERE q.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
      [id, user.id],
    )
    const query = rows[0]
    if (!query) throw notFound('That query')
    if (!ctx.aiReader.ready) throw new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')
    const ranAt = new Date().toISOString()
    // The export's own room: longer rows and more of them than a chat query may hold.
    const run = await runReadOnlyQuery(ctx.aiReader.pool, query.sql, { maxRows: AI_EXPORT_MAX_ROWS, timeoutMs: EXPORT_QUERY_TIMEOUT_MS, timeZone: tz, ...AI_EXPORT_LIMITS })
    if (!run.ok) throw badRequest(`The query could not be run again: ${run.error}`)
    const body: AiQueryExportResponse = { purpose: query.purpose, sql: query.sql, columns: run.columns, rows: exportRows(run), truncated: run.truncated, ranAt }
    res.json(body)
  })

  // ---- Usage ------------------------------------------------------------------------------

  r.get('/usage', async (req, res) => {
    const q = parse(usageQuery, req.query)
    const month = q.month ?? new Date().toISOString().slice(0, 7)
    const { from, to } = monthRange(month)
    const totals = await db.query<{
      spent: number
      calls: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }>(
      `SELECT COALESCE(sum(cost_usd), 0)::numeric(14, 6) AS spent, count(*)::int AS calls,
              COALESCE(sum(input_tokens), 0)::bigint AS "inputTokens", COALESCE(sum(output_tokens), 0)::bigint AS "outputTokens",
              COALESCE(sum(cache_read_tokens), 0)::bigint AS "cacheReadTokens",
              COALESCE(sum(cache_write_5m_tokens + cache_write_1h_tokens), 0)::bigint AS "cacheWriteTokens"
         FROM ai_usage WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    )
    const questions = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_turns WHERE created_at >= $1 AND created_at < $2`, [from, to])
    const byDay = await db.query<AiUsageResponse['byDay'][number]>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, sum(cost_usd)::numeric(14, 6) AS "costUsd", count(*)::int AS calls
         FROM ai_usage WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`,
      [from, to],
    )
    const byUser = await db.query<AiUsageResponse['byUser'][number]>(
      `WITH spend AS (SELECT user_id, sum(cost_usd) AS cost FROM ai_usage WHERE created_at >= $1 AND created_at < $2 GROUP BY user_id),
            asked AS (SELECT user_id, count(*) AS n FROM ai_turns WHERE created_at >= $1 AND created_at < $2 GROUP BY user_id)
       SELECT u.id AS "userId", u.name AS "userName", COALESCE(s.cost, 0)::numeric(14, 6) AS "costUsd", COALESCE(a.n, 0)::int AS questions
         FROM spend s FULL JOIN asked a ON a.user_id = s.user_id
         JOIN users u ON u.id = COALESCE(s.user_id, a.user_id)
        ORDER BY 3 DESC, u.name`,
      [from, to],
    )
    const t = totals.rows[0]
    const body: AiUsageResponse = {
      month,
      spentUsd: t.spent,
      capUsd: (await loadAiSettings(db)).settings.monthlyCapUsd,
      calls: t.calls,
      questions: questions.rows[0].n,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      byDay: byDay.rows,
      byUser: byUser.rows,
    }
    res.json(body)
  })

  // ---- Saved reports ------------------------------------------------------------------------

  const readerDown = () => new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')

  /** An answer kept as a report. With `adjustable` (the default), one call to the model makes its period changeable, if it can. */
  r.post('/reports', async (req, res) => {
    const user = requireUser(req)
    const body = parse(saveReportSchema, req.body)
    const turn = await loadSavedTurn(db, body.turnId, user.id, tz)
    if (!turn) throw notFound('That answer')
    if (turn.status !== 'done') throw new HttpError(409, 'conflict', 'This answer is still being written. Save it once it is finished.')
    if (turn.sections.length === 0) throw badRequest('This answer ran no query that worked, so there is nothing to keep as a report.')
    // Saved already (a second click, another tab): that report, not a second one.
    const existing = await findReportOfTurn(db, turn.turnId, user.id)
    if (existing) {
      const reply: AiSaveReportResponse = { report: existing, status: (await availability()).status }
      res.status(200).json(reply)
      return
    }

    let period: AiReportPeriod | null = null
    let adjustable = false
    let sections: AiReportSection[] = turn.sections
    let proposedTitle: string | null = null
    let notice: string | undefined
    if (body.adjustable) {
      const avail = await availability()
      if (!avail.settings.settings.enabled) notice = FIXED_NOTICE.disabled
      else if (!avail.apiKey) notice = FIXED_NOTICE.noKey
      else if (!ctx.aiReader.ready) notice = FIXED_NOTICE.noReader
      else {
        const params = templateRequest(turn)
        // The loop's own test before a call: refused here, the person can still save the report as it ran.
        if (avail.status.spentUsd + worstCaseUsd(params) > avail.status.capUsd) {
          throw new HttpError(
            402,
            'ai_budget_reached',
            `Making this report's period adjustable could pass this month's spending cap ($${avail.status.capUsd.toFixed(2)}). ` +
              'Save it with its period as asked instead, which needs no call to Claude; an administrator can raise the cap under Administration → AI assistant.',
          )
        }
        // A call to the model, like a question: counted with them.
        const wait = ctx.aiLimiter.hit(user.id)
        if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many requests to Claude in a short time. Try again in ${wait} seconds.`)
        const owner = { userId: user.id, conversationId: turn.conversationId, turnId: turn.turnId }
        const proposal = await proposeTemplates({ db, model: ctx.ai, apiKey: avail.apiKey, owner, params, sectionCount: turn.sections.length })
        if ('notice' in proposal) {
          notice = proposal.notice
          console.warn(`[ai] report of answer ${turn.turnId}: period kept as asked (${proposal.detail})`)
        } else {
          proposedTitle = proposal.title
          const verified = await verifyTemplates({ reader: ctx.aiReader.pool, timeZone: tz, sections: turn.sections, proposal, askedOn: turn.askedOn })
          if (verified.kind === 'adjustable') {
            period = verified.period
            adjustable = true
            sections = verified.sections
          } else if (verified.kind === 'fixed') {
            notice = verified.notice
            console.warn(`[ai] report of answer ${turn.turnId}: period kept as asked (${verified.detail})`)
          }
        }
      }
    }

    const title = reportTitle(body.title ?? proposedTitle, turn.question)
    let report: AiReport
    try {
      report = await withTransaction(db, async (tx) => {
        const saved = await insertReport(tx, {
          userId: user.id,
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          title,
          question: turn.question,
          period,
          adjustable,
          sections,
        })
        await writeAudit(tx, [
          auditEvent('create', { userId: user.id, userName: user.name, entity: 'AiReport', entityId: saved.id }, new Date().toISOString(), { field: 'title', newValue: title }),
        ])
        return saved
      })
    } catch (e) {
      // Saved meanwhile by a request racing this one: the database keeps one, and that is the answer.
      const raced = pgCode(e) === PG.UNIQUE_VIOLATION ? await findReportOfTurn(db, turn.turnId, user.id) : null
      if (!raced) throw e
      const reply: AiSaveReportResponse = { report: raced, status: (await availability()).status }
      res.status(200).json(reply)
      return
    }
    const reply: AiSaveReportResponse = { report, status: (await availability()).status }
    if (notice) reply.notice = notice
    res.status(201).json(reply)
  })

  r.get('/reports', async (req, res) => {
    const user = requireUser(req)
    const q = parse(reportsQuery, req.query)
    const body: AiReportsResponse = await listReports(db, user.id, { before: q.before ?? null, limit: q.limit, search: q.q || null })
    res.json(body)
  })

  r.get('/reports/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const report = await findReport(db, id, user.id)
    if (!report) throw notFound('That report')
    res.json(report)
  })

  r.patch('/reports/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { title } = parse(renameReportSchema, req.body)
    const report = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ title: string }>(`SELECT title FROM ai_reports WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, user.id])
      if (!rows[0]) throw notFound('That report')
      if (rows[0].title === title) return (await findReport(tx, id, user.id))!
      const renamed = await renameReport(tx, id, title)
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'AiReport', entityId: id }, { title: rows[0].title }, { title })
      return renamed
    })
    res.json(report)
  })

  /** Removed from the person's list; the record stays (soft delete). */
  r.delete('/reports/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ title: string }>(`SELECT title FROM ai_reports WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, user.id])
      if (!rows[0]) throw notFound('That report')
      await deleteReport(tx, id)
      await writeAudit(tx, [
        auditEvent('delete', { userId: user.id, userName: user.name, entity: 'AiReport', entityId: id }, new Date().toISOString(), { field: 'title', oldValue: rows[0].title }),
      ])
    })
    res.status(204).end()
  })

  /**
   * A report, its period resolved (or the days asked for), the queries it
   * runs before they run: a person asking for days the report cannot take is
   * told so, and runs count against the person's limit.
   */
  async function reportToRun(req: Request, res: Response) {
    // The browser leaving stops the queries still to run, inside PostgreSQL too.
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const range = parse(reportRunQuery, req.query)
    const report = await findReport(db, id, user.id)
    if (!report) throw notFound('That report')
    if (range && !report.adjustable) throw badRequest("This report's period cannot be changed: it runs over the days its queries name.")
    const wait = ctx.aiReportLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many report runs in a short time. Try again in ${wait} seconds.`)
    if (!ctx.aiReader.ready) throw readerDown()
    // Today where the factory sits, at the moment of the run: "the last 30 days" ends today.
    const period = runPeriod(report, range, factoryDay(new Date(), tz))
    return { report, period, signal: ac.signal }
  }

  /** A report run now: each section's first rows, as an answer's cards show a query. No call to the model. */
  r.get('/reports/:id/run', async (req, res) => {
    const { report, period, signal } = await reportToRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await runReportSections(ctx.aiReader.pool, report, period, { timeZone: tz, signal })
    const body: AiReportRunResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  /** A report run now in full for Excel: up to AI_EXPORT_MAX_ROWS rows a section. */
  r.get('/reports/:id/export', async (req, res) => {
    const { report, period, signal } = await reportToRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await exportReportSections(ctx.aiReader.pool, report, period, { timeZone: tz, signal })
    const body: AiReportExportResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  return r
}
