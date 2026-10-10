// ============================================================================
// §20 — the AI assistant: people ask about the factory's record in plain
// words; Claude answers by running read-only queries over the views in
// schema ai, and each query can be taken to Excel.
//
// One person owns the assistant (ai/owner.ts): its key, its switch and caps,
// who may use it and what it has cost are theirs alone. Every route about
// those answers 404 to anyone else — administrators included — exactly as an
// endpoint that does not exist would. The owner gives the assistant to
// people one by one (ai/access.ts), each with the data they may ask about,
// the model and effort they run on and a monthly cap of their own; those
// routes answer 403 to anyone the owner has not given it to (or has stopped).
// Both are read again on every request. Costs are never shown in the chat,
// not even to the owner: only the owner's settings page has the figures.
//
// A question is answered as a stream of Server-Sent Events. Every check that
// can refuse it (the body, the rate, the access, the switch, the key, the
// caps, the conversation, a send repeated) runs before the stream opens, so
// a refusal is an ordinary JSON error; once it is open, a failure is an
// `error` event.
//
// An answer can be kept as a report (ai/reports.ts): personal like the
// conversations, run again on demand through the same sandbox, as the
// person's current domains, its creation, renaming and removal in the audit
// log (which report and what was done to it: never its title, which is
// personal, nor its SQL).
//
// §21 — a person the owner allows to create automations (and the owner) gets
// two more tools in each NEW conversation, and the system prompt says how to
// use them; an automation the assistant proposes is activated or discarded
// from its card here, by the person who asked, while they still may (404 to
// anyone else). The Automations page has its own routes
// (automations.routes.ts).
// ============================================================================

import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import {
  AI_EXPORT_MAX_ROWS,
  AI_MAX_MESSAGE_CHARS,
  AI_MAX_MONTHLY_CAP_USD,
  AI_MODEL,
  aiMinCapUsd,
  isAiDay,
  isAiDomain,
  isAiEffort,
  isAiModel,
  type AiAccessListResponse,
  type AiAccessRequest,
  type AiConversationsResponse,
  type AiMeResponse,
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
  type AiUsageResponse,
} from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import type { AutomationActivateResponse, AutomationDiscardResponse } from '@qc/shared/automation'
import type { AppContext } from '../context'
import { PG, pgCode, withTransaction } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import {
  isGranted,
  listAccess,
  loadAccess,
  mayAutomate,
  personAvailability,
  removeAccess,
  saveAccess,
  statusFor,
  unlistedPeople,
  type AccessRecord,
  type PersonAvailability,
} from '../ai/access'
import { answerQuestion, describeModelFailure } from '../ai/assistant'
import { auditKeyLabel, last4, removeApiKey, storeApiKey, storedKeyTail } from '../ai/credentials'
import { canonicalDomains } from '../ai/domains'
import { minCallWorstCaseUsd, worstCaseUsd } from '../ai/models'
import { aiOwner } from '../ai/owner'
import { conversationTitle, conversationTools, factoryDay, questionContent, renderSystemPrompt } from '../ai/prompt'
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
  type SavedTurn,
  type SectionReader,
} from '../ai/reports'
import { AI_EXPORT_LIMITS, exportRows, runReadOnlyQuery } from '../ai/runQuery'
import { describeAiSchema } from '../ai/schemaDoc'
import { AI_SETTINGS_KEY, loadAiSettings, loadAvailability } from '../ai/settings'
import { SseStream } from '../ai/sse'
import { EditsInput } from '../automations/draft'
import { activateProposal, discardProposal } from '../automations/lifecycle'
import { AUTOMATION_TOOLS, automationToolHandlers } from '../automations/tools'
import {
  appendMessages,
  createConversation,
  findConversation,
  finishTurn,
  listConversations,
  loadDisplayMessages,
  loadReplay,
  personalMonthSpend,
  repairDanglingToolUse,
  toConversation,
  type ConversationRecord,
} from '../ai/transcript'

const uuid = z.string().uuid()
/** A query run again for Excel may take this long. */
const EXPORT_QUERY_TIMEOUT_MS = 30_000
/** A turn still "running" after this long was cut off by a restart: the next question closes it. */
const STALE_TURN_MINUTES = 6
/** Where the owner fixes what stops the assistant. */
const SETTINGS_PAGE = 'Administration → AI assistant'

/** A cap in dollars and cents. */
const capUsd = z
  .number()
  .min(0)
  .max(AI_MAX_MONTHLY_CAP_USD)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'The cap is in dollars and cents: at most two decimals.')
const cents = (v: number) => Math.round(v * 100) / 100

const settingsSchema = z.object({ enabled: z.boolean(), monthlyCapUsd: capUsd }).strict()

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

const accessSchema = z
  .object({
    enabled: z.boolean(),
    domains: z
      .array(z.string().refine(isAiDomain, 'Not one of the data domains.'))
      .max(4)
      .refine((d) => new Set(d).size === d.length, 'Each domain once.'),
    model: z.string().refine(isAiModel, 'Not one of the models the assistant offers.'),
    effort: z.string().refine(isAiEffort, 'Not one of the effort levels.'),
    monthlyCapUsd: capUsd,
    /** §21 — may create automations; left out, unchanged (off for a new row). */
    automations: z.boolean().optional(),
  })
  .strict()

/** §21 — what activating a proposal may carry: changes made on its card, and whether to tell about the cases matching now. */
const activateSchema = z.object({ edits: EditsInput.optional(), notifyExisting: z.boolean().optional() }).strict()

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
  /** With `before`, the last report of the page read: two changed in one millisecond are both reached. */
  beforeId: z.string().uuid().optional(),
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

/**
 * The owner's routes, by path: every request under them, whatever its method,
 * is the owner's alone. A route of the owner's goes under one of these.
 */
const OWNER_PATHS = ['/status', '/settings', '/key', '/access', '/people', '/usage']

/** What anyone but the owner gets from the owner's routes: what an endpoint that does not exist answers. */
const noSuchEndpoint = () => new HttpError(404, 'not_found', 'No such endpoint.')
/** What someone the owner has not given the assistant (or has stopped) gets from its routes. */
const notGranted = () => new HttpError(403, 'forbidden', 'You do not have access to the assistant.')

const LIMIT = {
  app: "The assistant's monthly limit is reached. It is available again on the 1st.",
  personal: "You have reached this month's limit for the assistant. It is available again on the 1st.",
}

/**
 * The refusal for a question the person cannot ask now, by why. No amounts
 * for anyone; the owner is also told where to put it right, and precisely
 * what stops the assistant, which is nobody else's to know.
 */
function unavailable(p: PersonAvailability): HttpError {
  const owner = p.me.owner
  switch (p.me.reason) {
    case 'cap-reached':
      return new HttpError(402, 'ai_budget_reached', owner ? `${LIMIT.app} You can raise it under ${SETTINGS_PAGE}.` : LIMIT.app)
    case 'personal-cap':
      return new HttpError(402, 'ai_budget_reached', owner ? `${LIMIT.personal} You can raise your own limit under ${SETTINGS_PAGE}.` : LIMIT.personal)
    case 'not-granted':
      return notGranted()
  }
  if (!owner) return new HttpError(503, 'ai_unavailable', 'The assistant is not available right now. Try again later.')
  switch (p.app.status.reason) {
    case 'disabled':
      return new HttpError(503, 'ai_unavailable', `The AI assistant is switched off. Switch it on under ${SETTINGS_PAGE}.`)
    case 'no-key':
      return new HttpError(503, 'ai_unavailable', `The AI assistant has no API key. Set it under ${SETTINGS_PAGE}.`)
    default:
      return new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')
  }
}

/** The refusal for a call whose worst case could pass a cap: which one, without its amount. */
function tooClose(which: 'app' | 'personal', what: string, owner: boolean, hint = ''): HttpError {
  const limit = which === 'app' ? "the assistant's monthly limit" : 'your monthly limit for the assistant'
  const raise = owner ? ` You can raise ${which === 'app' ? 'it' : 'your own limit'} under ${SETTINGS_PAGE}.` : ''
  return new HttpError(402, 'ai_budget_reached', `${what} could pass ${limit}, so it was not started.${hint}${raise}`)
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

  /** The owner's account id as of now, pinning the configured account the first time it exists. */
  const ownerId = () => aiOwner(db, ctx.config)

  /** The owner's routes: anyone else is answered as if they did not exist. */
  const ownerOnly: RequestHandler = async (req, _res, next) => {
    const user = requireUser(req)
    if ((await ownerId()) !== user.id) return next(noSuchEndpoint())
    next()
  }
  // Gated by path, ahead of every route: Express answers OPTIONS from the routes alone, listing their
  // methods, so a gate on each route would still tell anyone that the owner's routes exist.
  r.use(OWNER_PATHS, ownerOnly)

  /** The person asking, given the assistant; 403 when they are not (any more). Read on every request. */
  async function aiUser(req: Request): Promise<{ user: AuthUser; access: AccessRecord }> {
    const user = requireUser(req)
    const access = await loadAccess(db, user.id)
    if (!isGranted(access)) throw notGranted()
    return { user, access }
  }

  /** The same, with whether they may ask now. */
  async function asker(req: Request): Promise<{ user: AuthUser; access: AccessRecord; avail: PersonAvailability }> {
    const user = requireUser(req)
    const avail = await personAvailability(db, ctx.config, ctx.aiReader.ready, user.id, await ownerId())
    if (!isGranted(avail.access)) throw notGranted()
    return { user, access: avail.access, avail }
  }

  /** Whether the person may ask on, as an answer or a saved report hands it back. */
  const statusAfter = async (userId: string) => statusFor(await personAvailability(db, ctx.config, ctx.aiReader.ready, userId, await ownerId()))

  /** The assistant as the owner sees it: on the default model, the way the settings page judges it. */
  const availability = () => loadAvailability(db, ctx.config, ctx.aiReader.ready)

  async function settingsResponse(): Promise<AiSettingsResponse> {
    const a = await availability()
    return { settings: a.settings.settings, key: a.key, status: a.status, updatedAt: a.settings.updatedAt, updatedByName: a.settings.updatedByName }
  }

  // ---- Anyone signed in ---------------------------------------------------------------

  /** Whether to show the assistant at all, and whether it can answer now: no amounts, no model, no settings. */
  r.get('/me', async (req, res) => {
    const user = requireUser(req)
    const owner = await ownerId()
    const access = await loadAccess(db, user.id)
    // Most people were never given the assistant: asked on every page, they cost two reads and no more.
    if (!isGranted(access)) {
      const body: AiMeResponse = { granted: false, owner: owner === user.id, available: false, reason: 'not-granted', automations: false }
      res.json(body)
      return
    }
    res.json((await personAvailability(db, ctx.config, ctx.aiReader.ready, user.id, owner, access)).me)
  })

  // ---- The owner's: status, settings, key ---------------------------------------------

  r.get('/status', async (_req, res) => {
    res.json((await availability()).status)
  })

  r.get('/settings', async (_req, res) => {
    res.json(await settingsResponse())
  })

  r.put('/settings', async (req, res) => {
    const user = requireUser(req)
    const body = parse(settingsSchema, req.body)
    const next: AiSettings = { enabled: body.enabled, monthlyCapUsd: cents(body.monthlyCapUsd) }
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
  r.put('/key', async (req, res) => {
    const user = requireUser(req)
    const { apiKey } = parse(keySchema, req.body)
    const check = await ctx.ai.verifyKey(apiKey)
    if (!check.ok) {
      if (check.reason === 'refused') throw badRequest('Anthropic refused this key.')
      if (check.reason === 'no-model') throw badRequest(`This key cannot use the assistant's default model (${AI_MODEL}).`)
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

  r.delete('/key', async (req, res) => {
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

  // ---- The owner's: who may use it ------------------------------------------------------

  r.get('/access', async (_req, res) => {
    const body: AiAccessListResponse = { people: await listAccess(db, await ownerId()) }
    res.json(body)
  })

  /** Active accounts not listed yet: whom "Add person" offers. */
  r.get('/people', async (_req, res) => {
    res.json(await unlistedPeople(db))
  })

  /** Give a person the assistant, or change what they have. Audited, field by field. */
  r.put('/access/:userId', async (req, res) => {
    const owner = requireUser(req)
    const userId = parse(uuid, req.params.userId)
    const body = parse(accessSchema, req.body)
    const next = { ...body, domains: canonicalDomains(body.domains), monthlyCapUsd: cents(body.monthlyCapUsd) } as AiAccessRequest
    // A cap no single call fits in would close the assistant to them every month: say so now, as the owner's page does.
    if (next.enabled && next.monthlyCapUsd < aiMinCapUsd(next.model)) {
      throw badRequest(`On this model the monthly cap must be at least $${aiMinCapUsd(next.model).toFixed(2)}, the most one call may cost.`)
    }
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; name: string; username: string; active: boolean; listed: boolean }>(
        `SELECT u.id, u.name, u.username, (u.is_active AND u.deleted_at IS NULL) AS active,
                EXISTS (SELECT 1 FROM ai_access a WHERE a.user_id = u.id) AS listed
           FROM users u WHERE u.id = $1 AND NOT u.is_system FOR UPDATE OF u`,
        [userId],
      )
      const person = rows[0]
      if (!person) throw notFound('That account')
      // A new row only for an account that can sign in; one already listed can still be changed (switched off, say).
      if (!person.listed && !person.active) throw badRequest('That account is not active: only an active account can be given the assistant.')
      await saveAccess(tx, person, next, owner)
    })
    const [saved] = await listAccess(db, await ownerId(), userId)
    res.json(saved)
  })

  /** Take the assistant away: the row goes; the person's conversations stay theirs, unreachable until it is given back. */
  r.delete('/access/:userId', async (req, res) => {
    const owner = requireUser(req)
    const userId = parse(uuid, req.params.userId)
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; name: string; username: string }>(`SELECT id, name, username FROM users WHERE id = $1`, [userId])
      if (!rows[0] || !(await removeAccess(tx, rows[0], owner))) throw notFound('That person')
    })
    res.status(204).end()
  })

  // ---- Conversations ------------------------------------------------------------------

  r.get('/conversations', async (req, res) => {
    const { user } = await aiUser(req)
    const q = parse(conversationsQuery, req.query)
    const body: AiConversationsResponse = await listConversations(db, user.id, q.before ?? null, q.limit)
    res.json(body)
  })

  r.get('/conversations/:id/messages', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const conversation = await findConversation(db, id, user.id)
    if (!conversation) throw notFound('That conversation')
    const body: AiMessagesResponse = { conversation: toConversation(conversation), messages: await loadDisplayMessages(db, id) }
    res.json(body)
  })

  /** Removed from the person's list; the record stays (soft delete). */
  r.delete('/conversations/:id', async (req, res) => {
    const { user } = await aiUser(req)
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
    const { user, access, avail } = await asker(req)
    const owner = avail.me.owner
    const body = parse(chatSchema, req.body)
    const wait = ctx.aiLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many questions in a short time. Try again in ${wait} seconds.`)
    if (!avail.me.available || !avail.app.apiKey) throw unavailable(avail)
    const apiKey = avail.app.apiKey

    // A new conversation's prompt carries the data dictionary of the person's domains as the catalog has it now, for good,
    // and — for a person who may create automations as it starts — how to propose one, with the tools to do it (§21).
    const automations = avail.me.automations
    const systemPrompt = body.conversationId ? null : renderSystemPrompt(tz, await describeAiSchema(db, access.domains), access.domains, { automations })
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
          model: access.model,
          systemPrompt: systemPrompt!,
          tools: conversationTools(automations ? AUTOMATION_TOOLS : null),
        })
      }
      // The model and effort the owner set for the person now: an earlier conversation goes on with them too.
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, model, effort) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [conversation.id, user.id, body.clientId, body.message, access.model, access.effort],
      )
      const turnId = rows[0].id
      await repairDanglingToolUse(tx, conversation.id, turnId)
      const [question] = await appendMessages(tx, conversation.id, turnId, [{ role: 'user', kind: 'question', content: questionContent(body.message, askedAt, tz) }])
      const replay = await loadReplay(tx, conversation.id)
      const asked = (await findConversation(tx, conversation.id, user.id))!
      // The loop's own test before its first call (on what the loop is handed), made before anything is kept
      // or streamed: a question it would stop without calling the model is refused here, no turn left behind.
      const worst = minCallWorstCaseUsd(access.model, { conversation: asked, messages: replay })
      const hint = body.conversationId ? ' A new conversation costs less to start.' : ''
      if (avail.app.status.spentUsd + worst > avail.app.status.capUsd) throw tooClose('app', 'Answering this', owner, hint)
      if ((await personalMonthSpend(tx, user.id)) + worst > access.monthlyCapUsd) throw tooClose('personal', 'Answering this', owner, hint)
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
        readers: ctx.aiReader,
        model: ctx.ai,
        apiKey,
        config: ctx.config,
        userId: user.id,
        modelId: access.model,
        effort: access.effort,
        owner,
        conversation,
        turnId,
        messages: started.replay,
        emit: (event) => sse.send(event),
        signal: ac.signal,
        // Run only for a conversation that was given these tools; each checks the person may still use them.
        tools: automationToolHandlers({
          db,
          config: ctx.config,
          readers: ctx.aiReader,
          userId: user.id,
          conversationId: conversation.id,
          turnId,
          emit: (event) => sse.send(event),
        }),
      })
      await finishTurn(db, turnId, outcome.stopReason, outcome.notice)
      const answer = (await loadDisplayMessages(db, conversation.id, turnId)).find((m) => m.role === 'assistant')!
      sse.send({ type: 'done', message: answer, status: await statusAfter(user.id) })
    } catch (e) {
      const failure = describeModelFailure(e, conversation.id, owner)
      await finishTurn(db, turnId, 'error', failure.message).catch((err) => console.error('[ai] could not close a failed answer', err))
      sse.send({ type: 'error', code: failure.code, message: failure.message })
    } finally {
      sse.end()
    }
  })

  // ---- Excel ----------------------------------------------------------------------------

  /** A query of an answer, run again now in full (up to AI_EXPORT_MAX_ROWS rows), as the person's current domains. */
  r.get('/queries/:id/export', async (req, res) => {
    const { user, access } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const { rows } = await db.query<{ purpose: string; sql: string }>(
      `SELECT q.purpose, q.sql FROM ai_queries q JOIN ai_conversations c ON c.id = q.conversation_id
        WHERE q.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
      [id, user.id],
    )
    const query = rows[0]
    if (!query) throw notFound('That query')
    if (!ctx.aiReader.ready) throw readerDown()
    const ranAt = new Date().toISOString()
    // The export's own room: longer rows and more of them than a chat query may hold.
    const run = await runReadOnlyQuery(ctx.aiReader.poolFor(access.domains), query.sql, {
      maxRows: AI_EXPORT_MAX_ROWS,
      timeoutMs: EXPORT_QUERY_TIMEOUT_MS,
      timeZone: tz,
      ...AI_EXPORT_LIMITS,
    })
    if (!run.ok) throw badRequest(`The query could not be run again: ${run.code === '42501' ? 'you no longer have access to this data.' : run.error}`)
    const body: AiQueryExportResponse = { purpose: query.purpose, sql: query.sql, columns: run.columns, rows: exportRows(run), truncated: run.truncated, ranAt }
    res.json(body)
  })

  // ---- The owner's: usage -----------------------------------------------------------------

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
    // §21 — what scheduled reports' summaries cost, by automation (in byDay and their creator's byUser too).
    const byAutomation = await db.query<AiUsageResponse['byAutomation'][number]>(
      `SELECT a.id AS "automationId", a.name, u.name AS "creatorName", sum(g.cost_usd)::numeric(14, 6) AS "costUsd", count(*)::int AS runs
         FROM ai_usage g JOIN ai_automations a ON a.id = g.automation_id JOIN users u ON u.id = a.creator_id
        WHERE g.created_at >= $1 AND g.created_at < $2
        GROUP BY a.id, a.name, u.name
        ORDER BY 4 DESC, a.name`,
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
      byAutomation: byAutomation.rows,
    }
    res.json(body)
  })

  // ---- Automations proposed in answers (§21) -------------------------------------------------

  /** The person asking, while they may create automations; to anyone else these routes do not exist. */
  async function automator(req: Request): Promise<{ user: AuthUser; access: AccessRecord }> {
    const user = requireUser(req)
    const access = await loadAccess(db, user.id)
    if (!mayAutomate(access, (await ownerId()) === user.id)) throw noSuchEndpoint()
    return { user, access }
  }

  const automationDeps = { db, config: ctx.config, readers: ctx.aiReader, model: ctx.ai }

  /**
   * Activate a proposal from its card: the person who asked only, once, after
   * the same checks again. Its queries run again, so attempts count against
   * the person's report runs, and stop when the person leaves. Audited.
   */
  r.post('/automation-proposals/:id/activate', async (req, res) => {
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const { user, access } = await automator(req)
    const id = parse(uuid, req.params.id)
    const body = parse(activateSchema, req.body ?? {})
    const wait = ctx.aiReportLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many tries in a short time. Try again in ${wait} seconds.`)
    const reply: AutomationActivateResponse = await activateProposal(automationDeps, id, { id: user.id, name: user.name }, access, body, new Date(), ac.signal)
    res.json(reply)
  })

  r.post('/automation-proposals/:id/discard', async (req, res) => {
    const { user } = await automator(req)
    const id = parse(uuid, req.params.id)
    const reply: AutomationDiscardResponse = await discardProposal(automationDeps, id, { id: user.id, name: user.name })
    res.json(reply)
  })

  // ---- Saved reports ------------------------------------------------------------------------

  function readerDown(): HttpError {
    return new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')
  }

  /**
   * Saves under way, by person and answer. A second request for an answer
   * being saved (another tab, the panel reopened while the first runs) waits
   * for the first and gets its report, instead of paying for a second call to
   * Claude. One process serves the API, as the limiters above assume.
   */
  const savesUnderWay = new Map<string, Promise<void>>()

  /** An answer kept as a report. With `adjustable` (the default), one call to the model makes its period changeable, if it can. */
  r.post('/reports', async (req, res) => {
    const { user, access } = await aiUser(req)
    const body = parse(saveReportSchema, req.body)
    const turn = await loadSavedTurn(db, body.turnId, user.id, tz)
    if (!turn) throw notFound('That answer')
    if (turn.status !== 'done') throw new HttpError(409, 'conflict', 'This answer is still being written. Save it once it is finished.')
    if (turn.sections.length === 0) throw badRequest('This answer ran no query that worked, so there is nothing to keep as a report.')
    const key = `${user.id}:${turn.turnId}`
    // Whatever save of this answer is under way is waited for; the claim below follows the last wait with no await between.
    for (let underWay = savesUnderWay.get(key); underWay; underWay = savesUnderWay.get(key)) await underWay
    let release = () => {}
    savesUnderWay.set(key, new Promise<void>((resolve) => (release = resolve)))
    try {
      const { status, reply } = await saveReport(user, access, body, turn)
      res.status(status).json(reply)
    } finally {
      savesUnderWay.delete(key)
      release()
    }
  })

  /** One save, alone for its answer: the report already made of it, or a new one. */
  async function saveReport(
    user: AuthUser,
    access: AccessRecord,
    body: z.infer<typeof saveReportSchema>,
    turn: SavedTurn,
  ): Promise<{ status: 200 | 201; reply: AiSaveReportResponse }> {
    // Saved already (a second click, another tab): that report, not a second one.
    const existing = await findReportOfTurn(db, turn.turnId, user.id)
    if (existing) return { status: 200, reply: { report: existing, status: await statusAfter(user.id) } }

    let period: AiReportPeriod | null = null
    let adjustable = false
    let sections: AiReportSection[] = turn.sections
    let proposedTitle: string | null = null
    let notice: string | undefined
    if (body.adjustable) {
      const avail = await personAvailability(db, ctx.config, ctx.aiReader.ready, user.id, await ownerId())
      const app = avail.app
      if (!app.settings.settings.enabled || !app.apiKey) notice = FIXED_NOTICE.unavailable
      else if (!ctx.aiReader.ready) notice = FIXED_NOTICE.noReader
      else {
        // On the person's own model, like their questions, and counted with them against both caps.
        const params = templateRequest(turn, access.model)
        const worst = worstCaseUsd(params)
        const what = "Making this report's period adjustable"
        const instead = ' Save it with its period as asked instead, which needs no call to Claude.'
        // The loop's own test before a call: refused here, the person can still save the report as it ran.
        if (app.status.spentUsd + worst > app.status.capUsd) throw tooClose('app', what, avail.me.owner, instead)
        if ((await personalMonthSpend(db, user.id)) + worst > access.monthlyCapUsd) throw tooClose('personal', what, avail.me.owner, instead)
        const wait = ctx.aiLimiter.hit(user.id)
        if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many requests to Claude in a short time. Try again in ${wait} seconds.`)
        const owner = { userId: user.id, conversationId: turn.conversationId, turnId: turn.turnId }
        const proposal = await proposeTemplates({ db, model: ctx.ai, apiKey: app.apiKey, owner, params, sectionCount: turn.sections.length })
        // The person's access as it is after the call to Claude, which can take a while: the owner may have changed it.
        const now = await loadAccess(db, user.id)
        if (!isGranted(now)) throw notGranted()
        if ('notice' in proposal) {
          notice = proposal.notice
          console.warn(`[ai] report of answer ${turn.turnId}: period kept as asked (${proposal.detail})`)
        } else {
          proposedTitle = proposal.title
          const verified = await verifyTemplates({
            reader: ctx.aiReader.poolFor(now.domains),
            timeZone: tz,
            sections: turn.sections,
            proposal,
            askedOn: turn.askedOn,
            today: factoryDay(new Date(), tz),
          })
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
        // Which report, not its title: a title is personal (by default the question word for word).
        await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'AiReport', entityId: saved.id })
        return saved
      })
    } catch (e) {
      // Saved meanwhile by a request racing this one (one from another process): the database keeps one, and that is the answer.
      const raced = pgCode(e) === PG.UNIQUE_VIOLATION ? await findReportOfTurn(db, turn.turnId, user.id) : null
      if (!raced) throw e
      return { status: 200, reply: { report: raced, status: await statusAfter(user.id) } }
    }
    const reply: AiSaveReportResponse = { report, status: await statusAfter(user.id) }
    if (notice) reply.notice = notice
    return { status: 201, reply }
  }

  r.get('/reports', async (req, res) => {
    const { user } = await aiUser(req)
    const q = parse(reportsQuery, req.query)
    const body: AiReportsResponse = await listReports(db, user.id, { before: q.before ?? null, beforeId: q.beforeId ?? null, limit: q.limit, search: q.q || null })
    res.json(body)
  })

  r.get('/reports/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const report = await findReport(db, id, user.id)
    if (!report) throw notFound('That report')
    res.json(report)
  })

  r.patch('/reports/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const { title } = parse(renameReportSchema, req.body)
    const report = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ title: string }>(`SELECT title FROM ai_reports WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, user.id])
      if (!rows[0]) throw notFound('That report')
      if (rows[0].title === title) return (await findReport(tx, id, user.id))!
      const renamed = await renameReport(tx, id, title)
      // That the title changed, not what it says (see the save above).
      await writeAudit(tx, [auditEvent('update', { userId: user.id, userName: user.name, entity: 'AiReport', entityId: id }, new Date().toISOString(), { field: 'title' })])
      return renamed
    })
    res.json(report)
  })

  /** Removed from the person's list; the record stays (soft delete). */
  r.delete('/reports/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`SELECT 1 FROM ai_reports WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, user.id])
      if (!rows[0]) throw notFound('That report')
      await deleteReport(tx, id)
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'AiReport', entityId: id })
    })
    res.status(204).end()
  })

  /**
   * A report, its period resolved (or the days asked for), the queries it
   * runs before they run: a person asking for days the report cannot take is
   * told so, and runs count against the person's limit. Each section runs as
   * the person's domains as they are when it starts.
   */
  async function reportToRun(req: Request, res: Response) {
    // The browser leaving stops the queries still to run, inside PostgreSQL too.
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const { user } = await aiUser(req)
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
    // Read again before every section: sections run one after another, an export's for up to 30 s each.
    const reader: SectionReader = async () => {
      const now = await loadAccess(db, user.id)
      return isGranted(now) ? ctx.aiReader.poolFor(now.domains) : 'withdrawn'
    }
    return { report, period, reader, signal: ac.signal }
  }

  /** A report run now: each section's first rows, as an answer's cards show a query. No call to the model. */
  r.get('/reports/:id/run', async (req, res) => {
    const { report, period, reader, signal } = await reportToRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await runReportSections(reader, report, period, { timeZone: tz, signal })
    const body: AiReportRunResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  /** A report run now in full for Excel: up to AI_EXPORT_MAX_ROWS rows a section. */
  r.get('/reports/:id/export', async (req, res) => {
    const { report, period, reader, signal } = await reportToRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await exportReportSections(reader, report, period, { timeZone: tz, signal })
    const body: AiReportExportResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  return r
}
