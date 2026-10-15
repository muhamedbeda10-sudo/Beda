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
//
// §23 — every NEW conversation can read notices as the app shows them to the
// person (their bell; every notice for an administrator). An administrator
// the owner allows (the owner implicitly) also gets the tools to draft a
// notice, a change, a withdrawal or a deletion as a card, applied or
// discarded here by the person who asked, while they still may — their role
// read again at the press (403 to a person who may not, 404 for a card not
// theirs).
//
// A question may carry files for Claude to read (ai/attachments.ts): photos,
// PDFs and spreadsheets, attached first — counted by Anthropic on the
// person's model, which refuses a file Claude cannot read — then taken by the
// question they are sent with. Each is the attaching person's alone to read
// back, while its conversation is theirs.
// ============================================================================

import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import {
  AI_ACTIVITY_PAGE,
  AI_SLOW_QUERIES_SHOWN,
  AI_DOMAIN_IDS,
  AI_MAX_ATTACHMENTS_PER_QUESTION,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_PDF_BYTES,
  AI_MAX_SHEET_CHARS,
  AI_EXPORT_MAX_ROWS,
  AI_MAX_MESSAGE_CHARS,
  AI_MAX_MONTHLY_CAP_USD,
  AI_MODEL,
  AI_ROUTER_MODEL,
  AI_ACTIONS,
  AI_MODELS,
  aiCheapestChatModel,
  aiMinCapUsd,
  isAiAction,
  isAiChatMode,
  resolveAiAction,
  isAiDay,
  isAiDomain,
  isAiEffort,
  isAiModel,
  type AiAccessListResponse,
  type AiAccessRequest,
  type AiAttachment,
  type AiConversation,
  type AiConversationGroup,
  type AiConversationGroupsResponse,
  type AiConversationScope,
  type AiConversationSearchResponse,
  type AiConversationsResponse,
  AI_CONVERSATION_SCOPES,
  AI_CONVERSATION_SEARCH_MAX,
  AI_CONVERSATION_SEARCH_MIN,
  type AiMeResponse,
  type AiMessagesResponse,
  type AiStopResponse,
  type AiQueryExportResponse,
  type AiReport,
  type AiReportExportResponse,
  type AiReportPeriod,
  type AiReportRunResponse,
  type AiReportSection,
  type AiReportsResponse,
  type AiSaveReportResponse,
  type AiChatMode,
  type AiChatLevel,
  type AiSettings,
  type AiSettingsResponse,
  type AiTaskProposalResponse,
  type AiActivityItem,
  type AiActivityResponse,
  type AiSlowQueriesResponse,
  type AiUsageResponse,
} from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import { AI_EXCEL_KEEP_DAYS } from '@qc/shared/aiExcel'
import type { AutomationActivateResponse, AutomationDiscardResponse } from '@qc/shared/automation'
import type { AiNoticeApplyResponse, AiNoticeDiscardResponse } from '@qc/shared/noticeAssistant'
import { PLAYBOOK_BASIS_MAX, PLAYBOOK_TEXT_MAX, type PlaybookEntry, type PlaybookResponse } from '@qc/shared/playbook'
import type { SavedTableRowsResponse, SavedTablesResponse } from '@qc/shared/savedTables'
import type { AppContext } from '../context'
import { PG, pgCode, withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import {
  isGranted,
  listAccess,
  loadAccess,
  mayAutomate,
  mayMakeExcel,
  mayUploadMtc,
  mayManageNotices,
  personAvailability,
  removeAccess,
  saveAccess,
  statusFor,
  unlistedPeople,
  type AccessRecord,
  type PersonAvailability,
} from '../ai/access'
import { LOST_TURN } from '../ai/answerRunner'
import { describeModelFailure, usageOf } from '../ai/assistant'
import { chooseLevel, type RouterResult } from '../ai/router'
import {
  attachmentBlocks,
  buildAiAttachmentKey,
  checkPending,
  checkTokens,
  findOwnAttachment,
  insertAttachment,
  isThumbnail,
  readAll,
  removePending,
  sha256Hex,
  sniffAttachment,
  takeAttachments,
  type AttachmentRecord,
} from '../ai/attachments'
import { auditKeyLabel, last4, removeApiKey, storeApiKey, storedKeyTail } from '../ai/credentials'
import { canonicalDomains } from '../ai/domains'
import { minCallWorstCaseUsd, worstCaseUsd } from '../ai/models'
import { aiOwner } from '../ai/owner'
import { conversationTitle, conversationTools, factoryDay, questionContent, renderSystemPrompt } from '../ai/prompt'
import { conversationTitleProblem, createGroup, groupNameProblem, listGroups, oneLine, removeGroup, renameGroup, updateConversation } from '../ai/conversationOrganize'
import { searchConversations } from '../ai/conversationSearch'
import { giveConversationTitle } from '../ai/conversationTitle'
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
import { AI_EXPORT_LIMITS, AI_QUERY_TIMEOUT_MS, exportRows, runReadOnlyQuery } from '../ai/runQuery'
import { SLOW_QUERY_MS, listSlowQueries, withQueryOrigin } from '../ai/slowQueries'
import { describeAiSchema } from '../ai/schemaDoc'
import { describeSavedTables, findSavedTable, listSavedTables, previewTable, refreshTable, removeTable, type SavedTableActor } from '../ai/savedTables'
import { SAVED_TABLE_TOOLS } from '../ai/savedTableTools'
import { AI_SETTINGS_KEY, loadAiSettings, loadAvailability } from '../ai/settings'
import { SseStream } from '../ai/sse'
import { EditsInput } from '../automations/draft'
import { activateProposal, discardProposal } from '../automations/lifecycle'
import { AUTOMATION_TOOLS } from '../automations/tools'
import { applyNoticeProposal, discardNoticeProposal } from '../noticeAssistant/lifecycle'
import { noticeManager, noticePromptMode } from '../noticeAssistant/scope'
import { NOTICE_MANAGE_TOOLS, NOTICE_READ_TOOLS } from '../noticeAssistant/tools'
import { TASK_TOOLS, discardTaskProposal, sendTaskProposal } from '../tasks/assistant'
import { PLAYBOOK_TOOLS } from '../playbook/assistant'
import { EXCEL_TOOLS, XLSX_CONTENT_TYPE, findExcelFile, logExcelDownload } from '../ai/excel'
import { DIAGRAM_TOOLS } from '../ai/diagram'
import { addEntry, changeEntry, listPlaybook, mayUsePlaybook, promptPlaybook, removeEntry } from '../playbook/service'
import {
  appendMessages,
  createConversation,
  findConversation,
  listConversations,
  loadDisplayMessages,
  loadReplay,
  personalMonthSpend,
  recordUsage,
  repairDanglingToolUse,
  runningAnswer,
  toConversation,
  type ConversationRecord,
} from '../ai/transcript'

const uuid = z.string().uuid()
/** A query run again for Excel may take this long. */
const EXPORT_QUERY_TIMEOUT_MS = AI_QUERY_TIMEOUT_MS
/** How long a finished answer waits for its conversation's title before it closes without it. */
const TITLE_WAIT_MS = 3_000
/** Where the owner fixes what stops the assistant. */
const SETTINGS_PAGE = 'Administration → AI assistant'

/** A cap in dollars and cents. */
const capUsd = z
  .number()
  .min(0)
  .max(AI_MAX_MONTHLY_CAP_USD)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'The cap is in dollars and cents: at most two decimals.')
const cents = (v: number) => Math.round(v * 100) / 100

/** One action's choice: a model and an effort, each the recommended one ("auto") or one offered. */
const actionSettingSchema = z
  .object({
    model: z.string().refine((v) => v === 'auto' || isAiModel(v), 'Choose one of the models offered, or Auto.'),
    effort: z.string().refine((v) => v === 'auto' || isAiEffort(v), 'Choose one of the effort levels, or Auto.'),
  })
  .strict()

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    monthlyCapUsd: capUsd,
    /** The Models: each left out stays as it was. */
    chatMode: z.string().refine(isAiChatMode, 'Auto, or one of the levels.').optional(),
    actions: z
      .record(z.string(), actionSettingSchema)
      .refine((a) => Object.keys(a).every(isAiAction), 'Not one of the actions.')
      .optional(),
    mtcReread: z.boolean().optional(),
  })
  .strict()

/** The settings as the audit trail shows them: one value per field, an action's choice in words. */
function settingsSnapshot(s: AiSettings): Record<string, string> {
  const model = (m: string) => (m === 'auto' ? 'Auto' : (AI_MODELS.find((x) => x.id === m)?.name ?? m))
  const out: Record<string, string> = {
    enabled: String(s.enabled),
    monthlyCapUsd: String(s.monthlyCapUsd),
    chatMode: s.chatMode,
    mtcReread: s.mtcReread ? 'on' : 'off',
  }
  for (const a of AI_ACTIONS) {
    const set = s.actions[a.id]
    out[`model: ${a.name}`] = a.usesEffort ? `${model(set.model)} · effort ${set.effort === 'auto' ? 'Auto' : set.effort}` : model(set.model)
  }
  return out
}

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
      .max(AI_DOMAIN_IDS.length)
      .refine((d) => new Set(d).size === d.length, 'Each domain once.'),
    monthlyCapUsd: capUsd,
    /** §21 — may create automations; left out, unchanged (off for a new row). */
    automations: z.boolean().optional(),
    /**
     * §23 — may have the assistant write notices; left out, unchanged (off for a new row). Kept for anyone, it
     * takes effect only while the account is an administrator (the owner's page greys it out for the others).
     */
    notices: z.boolean().optional(),
    /** §20 — may have the assistant make Excel files; left out, unchanged (off for a new row). */
    excel: z.boolean().optional(),
    /** May upload mill test certificates (MTC tab), the assistant on for them or not; left out, unchanged (off for a new row). */
    mtc: z.boolean().optional(),
  })
  .strict()

/** §21 — what activating a proposal may carry: changes made on its card, and whether to tell about the cases matching now. */
const activateSchema = z.object({ edits: EditsInput.optional(), notifyExisting: z.boolean().optional() }).strict()

const chatSchema = z
  .object({
    conversationId: uuid.optional(),
    message: z.string().trim().max(AI_MAX_MESSAGE_CHARS, `A question is at most ${AI_MAX_MESSAGE_CHARS} characters.`),
    clientId: z.string().min(8).max(80),
    attachmentIds: z
      .array(uuid)
      .max(AI_MAX_ATTACHMENTS_PER_QUESTION, `A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each file once.')
      .default([]),
  })
  // Files alone are a question too: Claude reads them and says what they hold.
  .refine((b) => b.message !== '' || b.attachmentIds.length > 0, { message: 'Write a question.', path: ['message'] })

/** A spreadsheet read on the device: its text as Claude will read it, and its outline. */
const sheetSchema = z
  .object({
    name: z.string().trim().min(1, 'The file has no name.').max(255),
    text: z
      .string()
      .min(1, 'The spreadsheet is empty.')
      .max(AI_MAX_SHEET_CHARS, `A spreadsheet's text may be at most ${AI_MAX_SHEET_CHARS.toLocaleString('en-US')} characters. Attach only the sheets or rows you need.`)
      .refine((t) => t.trim() !== '', 'The spreadsheet is empty.'),
    summary: z.string().trim().max(300).default(''),
  })
  .strict()

const conversationsQuery = z
  .object({
    scope: z.enum(AI_CONVERSATION_SCOPES as [AiConversationScope, ...AiConversationScope[]]).default('all'),
    /** For scope group: which. */
    groupId: z.string().uuid().optional(),
    before: z.string().datetime({ offset: true }).optional(),
    /** With `before`, the last conversation of the page read: two at one millisecond are both reached. */
    beforeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => q.scope !== 'group' || q.groupId !== undefined, { message: 'Say which group.', path: ['groupId'] })

const conversationSearchQuery = z.object({
  q: z
    .string()
    .transform((t) => t.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(AI_CONVERSATION_SEARCH_MIN, `Search for at least ${AI_CONVERSATION_SEARCH_MIN} characters.`)
        .max(AI_CONVERSATION_SEARCH_MAX, `Search for at most ${AI_CONVERSATION_SEARCH_MAX} characters.`),
    ),
})

/** A conversation's title, or a group's name: on one line; its length counted as a person counts it. */
const conversationTitleSchema = z
  .string()
  .transform(oneLine)
  .superRefine((t, ctx) => {
    const problem = conversationTitleProblem(t)
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })
const groupNameSchema = z
  .string()
  .transform(oneLine)
  .superRefine((t, ctx) => {
    const problem = groupNameProblem(t)
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })

const conversationUpdateSchema = z
  .object({
    title: conversationTitleSchema.optional(),
    pinned: z.boolean().optional(),
    groupId: z.string().uuid().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((u) => Object.values(u).some((v) => v !== undefined), 'Say what to change.')

const groupSchema = z.object({ name: groupNameSchema }).strict()

// Years 2000–2999 only: outside them a month's bounds are not timestamps PostgreSQL takes (or Date.UTC moves them).
const usageQuery = z.object({ month: z.string().regex(/^2\d{3}-(0[1-9]|1[0-2])$/, 'A month is YYYY-MM, from 2000-01.').optional() })
/** The Activity list: a month, perhaps one person or one kind, and where the page starts (the last one's `next`). */
const activityQuery = usageQuery.extend({
  userId: z.string().uuid().optional(),
  kind: z.enum(['question', 'automation', 'mtc']).optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{1,36}$/, 'Not a place in the list.')
    .optional(),
})

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
const OWNER_PATHS = ['/status', '/settings', '/key', '/access', '/people', '/usage', '/activity', '/slow-queries']

/** What anyone but the owner gets from the owner's routes: what an endpoint that does not exist answers. */
const noSuchEndpoint = () => new HttpError(404, 'not_found', 'No such endpoint.')
/** What someone the owner has not given the assistant (or has stopped) gets from its routes. */
const notGranted = () => new HttpError(403, 'forbidden', 'You do not have access to the assistant.')

/** A download's Content-Disposition: the name as written (RFC 5987), and a plain one for clients that read only that. */
function attachmentDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim()
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${plain === '.xlsx' || plain === '' ? 'file.xlsx' : plain}"; filename*=UTF-8''${encoded}`
}

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

/** A conversation begun with files alone is named after the first of them. */
async function firstAttachmentName(q: Queryable, userId: string, ids: readonly string[]): Promise<string> {
  if (ids.length === 0) return 'Attached files'
  const { rows } = await q.query<{ name: string }>(`SELECT original_filename AS name FROM ai_attachments WHERE id = $1 AND user_id = $2`, [ids[0], userId])
  return rows[0]?.name ?? 'Attached files'
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

  /**
   * Excel from the assistant — its files, and Excel of its queries and
   * reports — is for the owner and the people the owner allows (§20); anyone
   * else is refused, whatever the button they found.
   */
  async function mayHaveExcel(user: AuthUser, access: AccessRecord): Promise<void> {
    if (!mayMakeExcel(access, (await ownerId()) === user.id)) throw new HttpError(403, 'forbidden', "The assistant's owner has not given you Excel files.")
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
      // Certificates are not the assistant: someone may upload them with the assistant off for them.
      const body: AiMeResponse = {
        granted: false,
        owner: owner === user.id,
        available: false,
        reason: 'not-granted',
        automations: false,
        excel: false,
        notices: false,
        mtc: mayUploadMtc(access, owner === user.id, true),
      }
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
    await withTransaction(db, async (tx) => {
      const before = (await loadAiSettings(tx)).settings
      const next: AiSettings = {
        enabled: body.enabled,
        monthlyCapUsd: cents(body.monthlyCapUsd),
        chatMode: (body.chatMode as AiChatMode | undefined) ?? before.chatMode,
        actions: { ...before.actions, ...(body.actions as Partial<AiSettings['actions']> | undefined) },
        mtcReread: body.mtcReread ?? before.mtcReread,
      }
      await tx.query(
        `INSERT INTO app_settings (key, value, updated_by_id, updated_by_name, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id,
           updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [AI_SETTINGS_KEY, JSON.stringify(next), user.id, user.name],
      )
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'AppSettings', entityId: AI_SETTINGS_KEY }, settingsSnapshot(before), settingsSnapshot(next))
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
    // The least is the cheapest model a question may run on now (Models); a dearer level is held to the cap call by call.
    const least = aiMinCapUsd(aiCheapestChatModel((await loadAiSettings(db)).settings))
    if (next.enabled && next.monthlyCapUsd < least) {
      throw badRequest(`The monthly cap must be at least $${least.toFixed(2)}, the most one question may cost on the cheapest model set under Models.`)
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
    const body: AiConversationsResponse = await listConversations(db, user.id, {
      scope: q.scope,
      groupId: q.groupId ?? null,
      before: q.before ?? null,
      beforeId: q.beforeId ?? null,
      limit: q.limit,
    })
    res.json(body)
  })

  r.get('/conversations/search', async (req, res) => {
    const { user } = await aiUser(req)
    const { q } = parse(conversationSearchQuery, req.query)
    const body: AiConversationSearchResponse = await searchConversations(db, user.id, q)
    res.json(body)
  })

  /** Rename, pin or unpin, put in a group or take out, archive or unarchive one of the person's conversations. */
  r.patch('/conversations/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const update = parse(conversationUpdateSchema, req.body)
    const body: AiConversation = await withTransaction(db, (tx) => updateConversation(tx, user.id, id, update))
    res.json(body)
  })

  // ---- Groups of conversations ---------------------------------------------------------

  r.get('/conversation-groups', async (req, res) => {
    const { user } = await aiUser(req)
    const body: AiConversationGroupsResponse = { groups: await listGroups(db, user.id) }
    res.json(body)
  })

  r.post('/conversation-groups', async (req, res) => {
    const { user } = await aiUser(req)
    const { name } = parse(groupSchema, req.body)
    const body: AiConversationGroup = await withTransaction(db, (tx) => createGroup(tx, user.id, name))
    res.status(201).json(body)
  })

  r.patch('/conversation-groups/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const { name } = parse(groupSchema, req.body)
    const body: AiConversationGroup = await withTransaction(db, (tx) => renameGroup(tx, user.id, id, name))
    res.json(body)
  })

  /** The group goes; its conversations go back to the list. */
  r.delete('/conversation-groups/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, (tx) => removeGroup(tx, user.id, id))
    res.status(204).end()
  })

  r.get('/conversations/:id/messages', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const conversation = await findConversation(db, id, user.id)
    if (!conversation) throw notFound('That conversation')
    // Asked while an answer is being written: the asker has it on screen (a device polls it only while it shows it),
    // so it is not told in the bell when it ends.
    await ctx.answers.watched(id)
    const running = await runningAnswer(db, id)
    const body: AiMessagesResponse = { conversation: { ...toConversation(conversation), ...(running ? { answering: true } : {}) }, messages: await loadDisplayMessages(db, id), running }
    res.json(body)
  })

  /** Stop the answer being written in the conversation, wherever it is written. Nothing to stop is not an error: it ended. */
  r.post('/conversations/:id/stop', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    if (!(await findConversation(db, id, user.id))) throw notFound('That conversation')
    const body: AiStopResponse = { stopping: await ctx.answers.requestStop(id, user.id) }
    res.json(body)
  })

  /** Removed from the person's list; the record stays (soft delete). An answer still being written in it stops. */
  r.delete('/conversations/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const { rowCount } = await db.query(`UPDATE ai_conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, user.id])
    if (!rowCount) throw notFound('That conversation')
    await ctx.answers.requestStop(id, user.id)
    res.status(204).end()
  })

  // ---- Asking -------------------------------------------------------------------------

  r.post('/chat', async (req, res) => {
    // The browser leaving closes the response before it has ended. Before the question is kept that means nobody
    // asked it (listened for from the start; not req's close, which fires as soon as the body is read); once it is
    // kept the answer goes on without them, and only POST /conversations/:id/stop ends it early.
    const ac = new AbortController()
    const left = new Promise<'left'>((resolve) =>
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
        resolve('left')
      }),
    )
    const { user, access, avail } = await asker(req)
    const owner = avail.me.owner
    const body = parse(chatSchema, req.body)
    const wait = ctx.aiLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many questions in a short time. Try again in ${wait} seconds.`)
    if (!avail.me.available || !avail.app.apiKey) throw unavailable(avail)

    // A new conversation's prompt carries the data dictionary of the person's domains as the catalog has it now, for good,
    // and — for a person who may create automations as it starts — how to propose one, with the tools to do it (§21);
    // and what the person sees of notices, with the tools to read them, and — for an administrator the owner allows —
    // how to draft one as a card, with the tools to do it (§23); and, as for everyone given the assistant, how to draft
    // a task as a card and follow their tasks, and their playbook as it is now, with the tool to keep it. Their role is
    // the one this request was signed in with.
    const automations = avail.me.automations ? { id: user.id, name: user.name, role: user.role } : null
    const managesNotices = mayManageNotices(access, owner, user.permissions)
    // Excel files, for the people the owner allows (and the owner).
    const excel = mayMakeExcel(access, owner)
    const notices = noticePromptMode({ permissions: [...user.permissions] }, managesNotices)
    // The data dictionary: the views the person may read, then the saved tables built from what they may read.
    const dictionary = async () => [await describeAiSchema(db, access.domains), await describeSavedTables(db, access.domains)].filter(Boolean).join('\n\n')
    const systemPrompt = body.conversationId
      ? null
      : renderSystemPrompt(tz, await dictionary(), access.domains, { automations, notices, tasks: true, excel, playbook: await promptPlaybook(db, user.id, tz), savedTables: true, diagrams: true })
    // Gone already (Stop, or the connection lost, while the checks ran): nobody to answer, so nothing is kept.
    if (ac.signal.aborted) return

    // The question's level, and so its model and effort (the owner's Models): files have a level of their own; otherwise
    // the router chooses (auto), or the level the owner fixed. The router reads the question before it for a follow-up.
    const settings = avail.app.settings.settings
    let routed: RouterResult | null = null
    let level: AiChatLevel
    if (body.attachmentIds.length > 0) level = 'chat-files'
    else if (settings.chatMode !== 'auto') level = settings.chatMode
    else {
      const previous = body.conversationId
        ? (
            await db.query<{ question: string; level: AiChatLevel | null }>(
              `SELECT t.question, t.level FROM ai_turns t JOIN ai_conversations c ON c.id = t.conversation_id
                WHERE t.conversation_id = $1 AND c.user_id = $2 ORDER BY t.created_at DESC LIMIT 1`,
              [body.conversationId, user.id],
            )
          ).rows[0]
        : null
      routed = await chooseLevel({ model: ctx.ai, apiKey: avail.app.apiKey, question: body.message, previous, signal: ac.signal })
      level = routed.level
    }
    const chosen = resolveAiAction(settings, level)
    /** The router's call when no question is kept to carry it (refused, or the asker gone): billed all the same, to the asker. */
    const keepRouterCost = async () => {
      if (!routed?.message) return
      const usage = usageOf(routed.message, AI_ROUTER_MODEL)
      await recordUsage(db, { userId: user.id, conversationId: null, turnId: null, model: usage.model, tokens: usage.tokens, costUsd: usage.costUsd }).catch((err: unknown) =>
        console.error('[ai] could not record the router call of a question not kept', err),
      )
    }
    if (ac.signal.aborted) {
      await keepRouterCost()
      return
    }
    const askedAt = new Date()
    const started = await withTransaction(db, async (tx) => {
      const repeated = await tx.query(`SELECT 1 FROM ai_turns WHERE user_id = $1 AND client_id = $2`, [user.id, body.clientId])
      if (repeated.rowCount) throw new HttpError(409, 'conflict', 'This question was already sent.')
      let conversation: ConversationRecord
      if (body.conversationId) {
        const found = await findConversation(tx, body.conversationId, user.id, true)
        if (!found) throw notFound('That conversation')
        conversation = found
        // An answer still being written comes first, wherever it is written. One whose instance went silent is
        // taken over and continued (answerRunner.ts): look for it now rather than at the next sweep.
        const running = await tx.query<{ lost: boolean }>(`SELECT (${LOST_TURN}) AS lost FROM ai_turns WHERE conversation_id = $1 AND status = 'running'`, [conversation.id])
        if (running.rows[0]?.lost) ctx.answers.kick()
        if (running.rows[0]) throw new HttpError(409, 'conflict', 'Still answering the previous question. Wait for it, or stop it.')
      } else {
        conversation = await createConversation(tx, {
          userId: user.id,
          title: conversationTitle(body.message || (await firstAttachmentName(tx, user.id, body.attachmentIds))),
          model: chosen.model,
          systemPrompt: systemPrompt!,
          tools: conversationTools(
            automations ? AUTOMATION_TOOLS : null,
            managesNotices ? [...NOTICE_READ_TOOLS, ...NOTICE_MANAGE_TOOLS] : NOTICE_READ_TOOLS,
            [...TASK_TOOLS, ...PLAYBOOK_TOOLS, ...DIAGRAM_TOOLS, ...(excel ? EXCEL_TOOLS : [])],
            SAVED_TABLE_TOOLS,
          ),
        })
      }
      // The model and effort of the question's level, and the level and why: the answer runs on them whoever takes it over.
      const { rows } = await tx.query<{ id: string }>(
        // Written by this instance from the start: its runner and heartbeat set as it is kept, so no other takes it.
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, model, effort, runner, heartbeat_at, level, level_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9) RETURNING id`,
        [conversation.id, user.id, body.clientId, body.message, chosen.model, chosen.effort, ctx.answers.id, level, routed?.reason ?? null],
      )
      const turnId = rows[0].id
      // The router's call is the question's cost, with the answer's.
      if (routed?.message) {
        const usage = usageOf(routed.message, AI_ROUTER_MODEL)
        await recordUsage(tx, { userId: user.id, conversationId: conversation.id, turnId, model: usage.model, tokens: usage.tokens, costUsd: usage.costUsd })
      }
      await repairDanglingToolUse(tx, conversation.id, turnId)
      // The question's files, taken for it in order: each the asker's, attached and not yet sent.
      const files = await takeAttachments(tx, { userId: user.id, conversationId: conversation.id, turnId, ids: body.attachmentIds })
      const [question] = await appendMessages(tx, conversation.id, turnId, [{ role: 'user', kind: 'question', content: questionContent(body.message, askedAt, tz, files) }])
      const replay = await loadReplay(tx, conversation.id)
      const asked = (await findConversation(tx, conversation.id, user.id))!
      // The loop's own test before its first call (on what the loop is handed), made before anything is kept
      // or streamed: a question it would stop without calling the model is refused here, no turn left behind.
      const worst = minCallWorstCaseUsd(chosen.model, { conversation: asked, messages: replay })
      const hint = body.conversationId ? ' A new conversation costs less to start.' : ''
      if (avail.app.status.spentUsd + worst > avail.app.status.capUsd) throw tooClose('app', 'Answering this', owner, hint)
      if ((await personalMonthSpend(tx, user.id)) + worst > access.monthlyCapUsd) throw tooClose('personal', 'Answering this', owner, hint)
      return { conversation: asked, turnId, questionId: question.id, replay }
    }).catch(async (e: unknown) => {
      await keepRouterCost()
      // Two sends racing past the checks above: the database keeps one.
      if (pgCode(e) === PG.UNIQUE_VIOLATION) {
        const running = (e as { constraint?: string }).constraint === 'ai_turns_one_running'
        throw new HttpError(409, 'conflict', running ? 'Still answering the previous question. Wait for it, or stop it.' : 'This question was already sent.')
      }
      throw e
    })

    const { conversation, turnId } = started
    // The answer is written by the runner, whatever happens to this response; the response watches it while it is open.
    const run = ctx.answers.begin({ turnId, conversationId: conversation.id, userId: user.id })
    // Gone while the question was kept (a Stop before the asker heard it was, or the connection lost): the asker never
    // learnt it was asked, so it is not answered — stopped at once, as their Stop would.
    if (ac.signal.aborted) {
      await ctx.answers.requestStop(conversation.id, user.id)
      return
    }
    const sse = new SseStream(res)
    sse.open()
    // A new conversation's title in a few words, asked beside the answer: kept whoever watches, and sent on this
    // stream as soon as it is. Not stopped with the request, nor by Stop.
    const titled =
      body.conversationId || !body.message.trim()
        ? null
        : giveConversationTitle({
            db,
            model: ctx.ai,
            apiKey: avail.app.apiKey,
            userId: user.id,
            conversationId: conversation.id,
            turnId,
            question: body.message,
            titleModel: resolveAiAction(settings, 'title').model,
          })
            .then((c) => {
              if (c) sse.send({ type: 'title', conversation: c })
            })
            .catch((e) => console.warn(`[ai] conversation ${conversation.id}: the title could not be kept:`, e instanceof Error ? e.message : String(e)))
    const unsubscribe = run.subscribe((event) => sse.send(event))
    sse.send({ type: 'start', conversation: toConversation(conversation), userMessageId: started.questionId, turnId })
    // Left: the answer goes on, and the bell tells the asker when it is ready. Stay only to end the stream politely.
    try {
      const end = await Promise.race([run.done, left])
      if (end === 'left') return
      if (end.kind === 'done') {
        // The title is in before the answer closes for this stream (it is far quicker), so the list read then has it.
        if (titled) await Promise.race([titled, new Promise((done) => setTimeout(done, TITLE_WAIT_MS).unref())])
        const answer = (await loadDisplayMessages(db, conversation.id, turnId)).find((m) => m.role === 'assistant')!
        sse.send({ type: 'done', message: answer, status: await statusAfter(user.id) })
      } else if (end.kind === 'error') {
        sse.send({ type: 'error', code: end.code, message: end.message })
      }
      // Handed over (the server is stopping): the stream ends without a word; the asker's device follows the answer
      // in the conversation, where whichever instance continues it writes it.
    } catch (e) {
      console.error(`[ai] conversation ${conversation.id}: the answer's stream failed`, e)
      sse.send({ type: 'error', code: 'internal', message: 'Something went wrong while answering. Nothing was lost; try again.' })
    } finally {
      unsubscribe()
      sse.end()
    }
  })

  // ---- Files a question carries ----------------------------------------------------------
  //
  // Attached before the question is sent: checked by their bytes, counted by Anthropic on the
  // person's model (which proves Claude can read them), then kept. Only someone the owner gave
  // the assistant to, while it can answer, may attach one: counting needs the key.

  // A name in Arabic arrives as UTF-8: read it so, not as Latin-1 (multer's default; its types do not list the option yet).
  const attachOptions: multer.Options & { defParamCharset: string } = {
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: AI_MAX_PDF_BYTES, files: 1, fields: 2 },
  }
  const attachUpload = multer(attachOptions)
  /** Read only for someone given the assistant: the bytes of anyone else are never taken in. */
  const grantedOnly: RequestHandler = async (req, _res, next) => {
    await aiUser(req)
    next()
  }
  const receiveFile: RequestHandler = (req, res, next) =>
    attachUpload.single('file')(req, res, (err: unknown) => {
      if ((err as { code?: string } | undefined)?.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'payload_too_large', `A file may be at most ${AI_MAX_PDF_BYTES / 1024 / 1024} MB.`))
      }
      next(err)
    })

  /** What Claude makes of a file, counted on the person's model; a file it cannot read is refused with a word on why. */
  async function countFile(apiKey: string, model: string, owner: boolean, file: AttachmentRecord, bytes: Buffer | null): Promise<number> {
    try {
      return await ctx.ai.countTokens(apiKey, { model, messages: [{ role: 'user', content: attachmentBlocks(file, bytes) }] })
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        throw badRequest(
          file.kind === 'pdf'
            ? 'Claude cannot read this PDF. It may be damaged, password-protected or too long: attach another copy, or only the pages you need.'
            : file.kind === 'image'
              ? 'Claude cannot read this photo. Take it again, or attach another one.'
              : 'Claude cannot read this spreadsheet as it is. Attach only the sheets or rows you need.',
        )
      }
      const failure = describeModelFailure(e, 'none (counting an attached file)', owner)
      const status = failure.code === 'rate_limited' ? 429 : failure.code === 'ai_unavailable' ? 503 : 502
      throw new HttpError(status, failure.code, failure.message)
    }
  }

  /** A photo (as the app prepares it: a JPEG at most AI_IMAGE_LONG_EDGE on its long side) or a PDF. */
  r.post('/attachments', grantedOnly, receiveFile, async (req, res) => {
    const { user, access, avail } = await asker(req)
    if (!avail.me.available || !avail.app.apiKey) throw unavailable(avail)
    if (!req.file) throw badRequest('Attach the file as the "file" field.')
    const bytes = req.file.buffer
    const sniffed = sniffAttachment(bytes)
    if (sniffed.kind === 'image' && bytes.length > AI_MAX_IMAGE_BYTES) throw new HttpError(413, 'payload_too_large', `A photo may be at most ${AI_MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
    const thumbnail = typeof req.body?.thumbnail === 'string' && sniffed.kind === 'image' && isThumbnail(req.body.thumbnail) ? req.body.thumbnail : null
    await checkPending(db, user.id)
    const id = randomUUID()
    const name = (req.file.originalname || (sniffed.kind === 'pdf' ? 'document.pdf' : 'photo.jpg')).replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'file'
    const record: AttachmentRecord = { id, kind: sniffed.kind, name, mimeType: sniffed.mimeType, storageKey: null, contentText: null, summary: null }
    // Counted on the model a question with files is answered on (Models).
    const filesModel = resolveAiAction(avail.app.settings.settings, 'chat-files').model
    const tokens = await countFile(avail.app.apiKey, filesModel, avail.me.owner, record, bytes)
    checkTokens(tokens)
    const key = buildAiAttachmentKey(id, sniffed.kind)
    await ctx.images.put(key, bytes, sniffed.mimeType)
    try {
      const body: AiAttachment = await insertAttachment(db, {
        id,
        userId: user.id,
        kind: sniffed.kind,
        name,
        mimeType: sniffed.mimeType,
        byteSize: bytes.length,
        sha256: sha256Hex(bytes),
        storageKey: key,
        driver: ctx.images.driver,
        width: sniffed.width,
        height: sniffed.height,
        thumbnailDataUrl: thumbnail,
        tokens,
        tokenModel: filesModel,
      })
      res.status(201).json(body)
    } catch (e) {
      await ctx.images.remove(key).catch(() => undefined)
      throw e
    }
  })

  /** A spreadsheet, read on the device into the text Claude reads (one block per sheet). */
  r.post('/attachments/sheet', async (req, res) => {
    const { user, access, avail } = await asker(req)
    if (!avail.me.available || !avail.app.apiKey) throw unavailable(avail)
    const body = parse(sheetSchema, req.body)
    await checkPending(db, user.id)
    const id = randomUUID()
    const name = body.name.replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'spreadsheet'
    const record: AttachmentRecord = { id, kind: 'sheet', name, mimeType: 'text/plain', storageKey: null, contentText: body.text, summary: body.summary || null }
    // Counted on the model a question with files is answered on (Models).
    const filesModel = resolveAiAction(avail.app.settings.settings, 'chat-files').model
    const tokens = await countFile(avail.app.apiKey, filesModel, avail.me.owner, record, null)
    checkTokens(tokens)
    const saved: AiAttachment = await insertAttachment(db, {
      id,
      userId: user.id,
      kind: 'sheet',
      name,
      mimeType: 'text/plain; charset=utf-8',
      byteSize: Buffer.byteLength(body.text, 'utf8'),
      sha256: sha256Hex(body.text),
      storageKey: null,
      driver: null,
      contentText: body.text,
      summary: body.summary || undefined,
      tokens,
      tokenModel: filesModel,
    })
    res.status(201).json(saved)
  })

  /** Taken off a question before it was sent; a file sent with a question stays with it. */
  r.delete('/attachments/:id', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    if (!(await removePending(db, user.id, id))) throw notFound('That file')
    res.status(204).end()
  })

  /** A file's bytes (a spreadsheet's text), for the person who attached it, while its conversation is theirs. */
  r.get('/attachments/:id/content', async (req, res) => {
    const { user } = await aiUser(req)
    const id = parse(uuid, req.params.id)
    const meta = await findOwnAttachment(db, user.id, id)
    if (!meta) throw notFound('That file')
    const etag = `"${meta.sha256}"`
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    if (req.headers['if-none-match'] === etag) return res.status(304).end()
    if (!meta.storageKey) {
      const { rows } = await db.query<{ text: string }>(`SELECT content_text AS text FROM ai_attachments WHERE id = $1`, [id])
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      return res.send(rows[0]?.text ?? '')
    }
    const bytes = await readAll(ctx.images, meta.storageKey)
    if (!bytes) throw new HttpError(404, 'not_found', 'The file bytes are missing from storage. The record and its hash are still kept.')
    const safeName = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    res.setHeader('Content-Type', meta.mimeType)
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
    res.send(bytes)
  })

  // ---- Excel ----------------------------------------------------------------------------

  /** A query of an answer, run again now in full (up to AI_EXPORT_MAX_ROWS rows), as the person's current domains; for someone allowed Excel. */
  r.get('/queries/:id/export', async (req, res) => {
    const { user, access } = await aiUser(req)
    await mayHaveExcel(user, access)
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
    const run = await withQueryOrigin({ source: 'export', userId: user.id, purpose: query.purpose }, () =>
      runReadOnlyQuery(ctx.aiReader.poolFor(access.domains), query.sql, {
        maxRows: AI_EXPORT_MAX_ROWS,
        timeoutMs: EXPORT_QUERY_TIMEOUT_MS,
        timeZone: tz,
        ...AI_EXPORT_LIMITS,
      }),
    )
    if (!run.ok) throw badRequest(`The query could not be run again: ${run.code === '42501' ? 'you no longer have access to this data.' : run.error}`)
    const body: AiQueryExportResponse = { purpose: query.purpose, sql: query.sql, columns: run.columns, rows: exportRows(run), truncated: run.truncated, ranAt }
    res.json(body)
  })

  /**
   * An Excel file the assistant made (make_excel): that very file, as it was
   * made, for the person who asked, while it is kept (AI_EXCEL_KEEP_DAYS) and
   * while they may still have Excel files made. Every download is logged.
   */
  r.get('/excel-files/:id/download', async (req, res) => {
    const { user, access } = await aiUser(req)
    await mayHaveExcel(user, access)
    const id = parse(uuid, req.params.id)
    const file = await findExcelFile(db, user.id, id)
    const gone = () => new HttpError(410, 'not_found', `This file is no longer kept (files are kept ${AI_EXCEL_KEEP_DAYS} days). Ask the assistant for it again.`)
    if (file.expired) throw gone()
    const stored = await ctx.images.get(file.storageKey)
    if (!stored) throw gone()
    await logExcelDownload(db, id, user.id)
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE)
    res.setHeader('Content-Disposition', attachmentDisposition(`${file.fileName}.xlsx`))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Length', String(stored.byteSize ?? file.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[ai] an Excel file could not be read from storage', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  // ---- The owner's: usage -----------------------------------------------------------------

  /**
   * Activity: each question of the month and what its answer cost (a report saved from it included, being the
   * same turn's), and each scheduled report's summary, newest first, a page at a time. The page is cut before the
   * costs are added up, so a month of thousands reads one page's worth. Its place is the row's time to the
   * microsecond and its id, so a page never repeats or skips a row that shares a second with another.
   */
  /** §20 — the assistant's queries that took SLOW_QUERY_MS or more, newest first: which questions are heavy. */
  r.get('/slow-queries', async (_req, res) => {
    const body: AiSlowQueriesResponse = {
      queries: await listSlowQueries(db, AI_SLOW_QUERIES_SHOWN),
      thresholdSeconds: SLOW_QUERY_MS / 1000,
      limitSeconds: AI_QUERY_TIMEOUT_MS / 1000,
    }
    res.json(body)
  })

  r.get('/activity', async (req, res) => {
    const q = parse(activityQuery, req.query)
    const month = q.month ?? new Date().toISOString().slice(0, 7)
    const { from, to } = monthRange(month)
    const params: unknown[] = [from, to, q.userId ?? null, q.kind ?? null, AI_ACTIVITY_PAGE + 1]
    let after = ''
    if (q.before) {
      const [at, id] = q.before.split('|')
      after = `WHERE (i.at, i.id) < ($${params.push(at)}::timestamptz, $${params.push(id)}::text)`
    }
    const page = await db.query<AiActivityItem & { place: string }>(
      `WITH items AS (
         SELECT 'question'::text AS kind, t.id::text AS id, t.created_at AS at, t.user_id, t.question AS text,
                CASE WHEN t.status = 'done' THEN t.stop_reason END AS stop_reason, t.id AS turn_id, NULL::bigint AS usage_id,
                NULL::uuid AS reading_id, t.level, t.level_reason
           FROM ai_turns t
          WHERE t.created_at >= $1 AND t.created_at < $2 AND ($3::uuid IS NULL OR t.user_id = $3) AND ($4::text IS NULL OR $4 = 'question')
         UNION ALL
         SELECT 'automation', g.id::text, g.created_at, g.user_id, a.name, NULL, NULL, g.id, NULL, NULL, NULL
           FROM ai_usage g JOIN ai_automations a ON a.id = g.automation_id
          WHERE g.turn_id IS NULL AND g.created_at >= $1 AND g.created_at < $2 AND ($3::uuid IS NULL OR g.user_id = $3) AND ($4::text IS NULL OR $4 = 'automation')
         UNION ALL
         -- A certificate read on the MTC tab, once however many calls it took: its file, and what was read from it.
         SELECT 'mtc', m.id::text, m.created_at, m.user_id,
                m.file_name || ' — ' || CASE m.outcome
                  WHEN 'read' THEN m.items || ' ' || CASE m.kind WHEN 'coils' THEN 'coil' WHEN 'welding-wire' THEN 'welding wire batch' ELSE 'mesh wire' END
                                  || CASE WHEN m.items = 1 THEN '' WHEN m.kind = 'welding-wire' THEN 'es' ELSE 's' END || ' read'
                  WHEN 'not-certificate' THEN 'not a certificate of coils or wire'
                  WHEN 'stopped' THEN 'stopped before the end'
                  ELSE 'could not be read' END
                || CASE WHEN m.reread THEN ' (unclear, read again on a stronger model)' ELSE '' END,
                NULL, NULL, NULL, m.id, NULL, NULL
           FROM mtc_readings m
          WHERE m.created_at >= $1 AND m.created_at < $2 AND ($3::uuid IS NULL OR m.user_id = $3) AND ($4::text IS NULL OR $4 = 'mtc')
       ),
       page AS (SELECT * FROM items i ${after} ORDER BY i.at DESC, i.id DESC LIMIT $5)
       SELECT p.kind, p.id, p.at, to_char(p.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id AS place,
              p.user_id AS "userId", u.name AS "userName", p.text, p.stop_reason AS "stopReason", p.level, p.level_reason AS "levelReason",
              COALESCE(c.cost, 0)::numeric(14, 6) AS "costUsd", COALESCE(c.models, '{}') AS models, COALESCE(c.partial, false) AS partial,
              COALESCE(n.lookups, 0)::int AS lookups
         FROM page p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN LATERAL (
           SELECT sum(m.cost) AS cost, bool_or(m.partial) AS partial, array_agg(m.model ORDER BY m.first) AS models
             FROM (SELECT g.model, sum(g.cost_usd) AS cost, bool_or(g.partial) AS partial, min(g.id) AS first
                     FROM (SELECT model, cost_usd, partial, id FROM ai_usage WHERE turn_id = p.turn_id
                           UNION ALL
                           SELECT model, cost_usd, partial, id FROM ai_usage WHERE id = p.usage_id
                           UNION ALL
                           SELECT model, cost_usd, partial, id FROM ai_usage WHERE mtc_reading_id = p.reading_id) g
                    GROUP BY g.model) m
         ) c ON true
         LEFT JOIN LATERAL (SELECT count(*) AS lookups FROM ai_queries WHERE turn_id = p.turn_id) n ON true
        ORDER BY p.at DESC, p.id DESC`,
      params,
    )
    const people = await db.query<{ id: string; name: string }>(
      `SELECT u.id, u.name
         FROM (SELECT user_id FROM ai_turns WHERE created_at >= $1 AND created_at < $2
               UNION
               SELECT user_id FROM ai_usage WHERE (automation_id IS NOT NULL OR mtc_reading_id IS NOT NULL) AND turn_id IS NULL AND created_at >= $1 AND created_at < $2) x
         JOIN users u ON u.id = x.user_id
        ORDER BY u.name, u.id`,
      [from, to],
    )
    const rows = page.rows.slice(0, AI_ACTIVITY_PAGE)
    const body: AiActivityResponse = {
      month,
      items: rows.map(({ place: _place, ...item }) => item),
      next: page.rows.length > AI_ACTIVITY_PAGE ? rows[rows.length - 1].place : null,
      people: people.rows,
    }
    res.json(body)
  })

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
    // Each day's spend and calls, and the questions asked that day (a day may have spend and no question: a summary).
    const byDay = await db.query<AiUsageResponse['byDay'][number]>(
      `WITH spend AS (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, sum(cost_usd) AS cost, count(*) AS calls
                        FROM ai_usage WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
            asked AS (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n
                        FROM ai_turns WHERE created_at >= $1 AND created_at < $2 GROUP BY 1)
       SELECT COALESCE(s.day, a.day) AS day, COALESCE(s.cost, 0)::numeric(14, 6) AS "costUsd", COALESCE(s.calls, 0)::int AS calls, COALESCE(a.n, 0)::int AS questions
         FROM spend s FULL JOIN asked a ON a.day = s.day
        ORDER BY 1`,
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

  // ---- Notice cards (§23) -----------------------------------------------------------------------

  /**
   * The person asking, while they may have the assistant write notices: given
   * the assistant, an administrator by their role now, and allowed by the owner
   * (or the owner). A card is pressed by the person who asked only: someone
   * else's is "not found".
   */
  async function noticeWriter(req: Request): Promise<AuthUser> {
    const user = requireUser(req)
    if (!(await noticeManager(db, ctx.config, user.id))) {
      throw new HttpError(403, 'forbidden', "Only an administrator the assistant's owner allows can manage notices through the assistant.")
    }
    return user
  }

  /** Apply a card: the notice written exactly as the Notices page writes it, as the person pressing the button. */
  r.post('/notice-proposals/:id/apply', async (req, res) => {
    const user = await noticeWriter(req)
    const id = parse(uuid, req.params.id)
    const reply: AiNoticeApplyResponse = await applyNoticeProposal(db, tz, id, { id: user.id, name: user.name })
    res.json(reply)
  })

  r.post('/notice-proposals/:id/discard', async (req, res) => {
    const user = await noticeWriter(req)
    const id = parse(uuid, req.params.id)
    const reply: AiNoticeDiscardResponse = await discardNoticeProposal(db, id, { id: user.id, name: user.name })
    res.json(reply)
  })

  // ---- Task cards ---------------------------------------------------------------------------------

  /**
   * Send task from a card: the person who asked only (anyone else's is "not
   * found"), while they may still send tasks, checked again as the Tasks page
   * checks a new task. Each person it goes to is told; the card says so.
   */
  r.post('/task-proposals/:id/send', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const part = await withTransaction(db, (tx) => sendTaskProposal(tx, id, { id: user.id, name: user.name }, tz))
    const reply: AiTaskProposalResponse = { part }
    res.json(reply)
  })

  r.post('/task-proposals/:id/discard', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const part = await withTransaction(db, (tx) => discardTaskProposal(tx, id, user.id))
    const reply: AiTaskProposalResponse = { part }
    res.json(reply)
  })

  // ---- The playbook ---------------------------------------------------------------------------------

  /** The person asking, while they keep a playbook (given the assistant), and whether they are its owner. */
  async function playbookActor(req: Request) {
    const user = requireUser(req)
    if (!(await mayUsePlaybook(db, user.id))) throw new HttpError(403, 'forbidden', 'The playbook is for the people given the AI assistant.')
    return { id: user.id, name: user.name, owner: (await ownerId()) === user.id }
  }

  const playbookEntry = async (viewer: { id: string; owner: boolean }, id: string): Promise<PlaybookEntry> => (await listPlaybook(db, viewer)).find((e) => e.id === id)!

  r.get('/playbook', async (req, res) => {
    const by = await playbookActor(req)
    const reply: PlaybookResponse = { entries: await listPlaybook(db, by), mayShare: by.owner }
    res.json(reply)
  })

  const playbookText = z.string().max(PLAYBOOK_TEXT_MAX * 2)
  const playbookBasis = z.string().max(PLAYBOOK_BASIS_MAX * 2)

  r.post('/playbook', async (req, res) => {
    const by = await playbookActor(req)
    const body = parse(z.object({ scope: z.enum(['personal', 'shared']), kind: z.enum(['instruction', 'conclusion']), text: playbookText, basis: playbookBasis.optional() }).strict(), req.body)
    const change = await withTransaction(db, (tx) => addEntry(tx, by, body))
    res.status(201).json(await playbookEntry(by, change.entry.id))
  })

  r.patch('/playbook/:id', async (req, res) => {
    const by = await playbookActor(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ text: playbookText.optional(), basis: playbookBasis.optional() }).strict(), req.body)
    await withTransaction(db, (tx) => changeEntry(tx, by, id, body))
    res.json(await playbookEntry(by, id))
  })

  r.delete('/playbook/:id', async (req, res) => {
    const by = await playbookActor(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, (tx) => removeEntry(tx, by, id))
    res.status(204).end()
  })

  // ---- Saved tables ------------------------------------------------------------------------
  //
  // For the people given the assistant: the tables they may read (what each one's query reads, all
  // of it theirs), a preview read as their own domains, computing one again, and removing one they
  // made (any, for the owner). The assistant makes and replaces them in a conversation.

  const savedTableDeps = () => ({ db, readers: ctx.aiReader, timeZone: tz })

  async function savedTableActor(req: Request): Promise<SavedTableActor> {
    const { user, access } = await aiUser(req)
    return { id: user.id, name: user.name, owner: (await ownerId()) === user.id, domains: access.domains }
  }

  async function readableTable(actor: SavedTableActor, id: string) {
    const table = await findSavedTable(db, actor, { id })
    if (!table) throw notFound('That saved table')
    return table
  }

  r.get('/saved-tables', async (req, res) => {
    const actor = await savedTableActor(req)
    const reply: SavedTablesResponse = { tables: await listSavedTables(db, actor) }
    res.json(reply)
  })

  r.get('/saved-tables/:id/rows', async (req, res) => {
    const actor = await savedTableActor(req)
    const id = parse(uuid, req.params.id)
    if (!ctx.aiReader.ready) throw readerDown()
    const reply: SavedTableRowsResponse | null = await previewTable(savedTableDeps(), actor, id)
    if (!reply) throw notFound('That saved table')
    res.json(reply)
  })

  r.post('/saved-tables/:id/refresh', async (req, res) => {
    const actor = await savedTableActor(req)
    const table = await readableTable(actor, parse(uuid, req.params.id))
    if (!ctx.aiReader.ready) throw readerDown()
    const outcome = await refreshTable(savedTableDeps(), table.id, actor)
    if (!outcome.ok) throw new HttpError(409, 'conflict', outcome.error)
    res.json(await readableTable(actor, table.id))
  })

  r.delete('/saved-tables/:id', async (req, res) => {
    const actor = await savedTableActor(req)
    const table = await readableTable(actor, parse(uuid, req.params.id))
    if (!table.mayRemove) throw new HttpError(403, 'forbidden', `Only ${table.createdByName}, who made it, or the assistant's owner may remove this table.`)
    const outcome = await removeTable(savedTableDeps(), actor, table.id)
    if (!outcome.ok) throw new HttpError(409, 'conflict', outcome.error)
    res.status(204).end()
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
        // On the model and effort the owner set for it (Models), and counted with the person's questions against both caps.
        const params = templateRequest(turn, resolveAiAction(app.settings.settings, 'report-template'))
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
          const verified = await withQueryOrigin({ source: 'report', userId: user.id, purpose: `Saving "${proposal.title}": checking its period` }, () =>
            verifyTemplates({
              reader: ctx.aiReader.poolFor(now.domains),
              timeZone: tz,
              sections: turn.sections,
              proposal,
              askedOn: turn.askedOn,
              today: factoryDay(new Date(), tz),
            }),
          )
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
    const sections = await withQueryOrigin({ source: 'report', userId: requireUser(req).id, purpose: report.title }, () =>
      runReportSections(reader, report, period, { timeZone: tz, signal }),
    )
    const body: AiReportRunResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  /** A report run now in full for Excel: up to AI_EXPORT_MAX_ROWS rows a section; for someone allowed Excel. */
  r.get('/reports/:id/export', async (req, res) => {
    const { user, access } = await aiUser(req)
    await mayHaveExcel(user, access)
    const { report, period, reader, signal } = await reportToRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await withQueryOrigin({ source: 'export', userId: user.id, purpose: report.title }, () =>
      exportReportSections(reader, report, period, { timeZone: tz, signal }),
    )
    const body: AiReportExportResponse = { report: await markReportRun(db, report), period, sections, ranAt }
    res.json(body)
  })

  return r
}
