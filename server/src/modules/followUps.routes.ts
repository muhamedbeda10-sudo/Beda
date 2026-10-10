// ============================================================================
// §21 — follow-ups as people work them (opened by watches: see
// automations/followUps.ts).
//
// Who sees one: its assignee, the automation's creator, supervisors,
// administrators and the assistant's owner — the last three see everyone's
// ("all"). Anyone who sees one may move its status and comment; only the
// creator, supervisors, administrators and the owner may reassign it or move
// its deadline. Closing it ('done') takes a closing note. Every change is in
// its timeline and in the audit log (entity 'FollowUp'), and the people it
// concerns are told: a new assignee that it is theirs, the assignee and the
// creator when someone else changes it or comments. Whom it can be given to
// (/people) is answered to those who may reassign one; to anyone else that
// endpoint does not exist.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  FOLLOW_UP_COMMENT_MAX,
  FOLLOW_UP_STATUSES,
  type FollowUp,
  type FollowUpCountsResponse,
  type FollowUpDetail,
  type FollowUpEvent,
  type FollowUpPeopleResponse,
  type FollowUpStatus,
  type FollowUpsResponse,
} from '@qc/shared/automation'
import type { AiCell } from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import { STOCK_ORDER_NUMBER } from '@qc/shared/rules'
import type { Role } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, type AuthUser } from '../auth/middleware'
import { auditChanges, writeAudit } from '../audit/service'
import { currentAiOwner } from '../ai/owner'
import { LIVE_PERSON } from '../automations/people'
import { clipText, createNotifications } from '../automations/notify'
import { addFollowUpEvents, followUpAuditContext, followUpLink, sessionContexts, type FollowUpEventDraft } from '../automations/followUps'

const uuid = z.string().uuid()
const PAGE = 50
/** How far ahead a deadline may be moved. */
const DUE_MAX_AHEAD_MS = 365 * 86_400_000

const STATUS_LABEL: Record<FollowUpStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done' }
const statusSchema = z.enum(FOLLOW_UP_STATUSES as unknown as [FollowUpStatus, ...FollowUpStatus[]])

// ---- Reading -----------------------------------------------------------------------

interface FollowUpRow {
  id: string
  automationId: string | null
  automationName: string
  caseKey: string
  title: string
  body: string
  status: FollowUpStatus
  assigneeId: string | null
  assigneeName: string | null
  creatorId: string | null
  dueAt: string
  overdue: boolean
  escalatedAt: string | null
  sessionId: string | null
  sessionLabel: string | null
  sampleId: string | null
  orderNumber: string | null
  caseColumns: string[]
  caseRow: AiCell[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  closedByName: string | null
  closingNote: string | null
  commentCount: number
}

/**
 * A follow-up with its automation's current name, its assignee's name and
 * how its session reads in the app (order, item, machine, number) — the
 * session only while it is on record. Requires nothing; aliases f, a, au, s, o, m.
 */
const FOLLOW_UP_FROM = `follow_ups f
  LEFT JOIN ai_automations a ON a.id = f.automation_id
  LEFT JOIN users au ON au.id = f.assignee_id
  LEFT JOIN inspection_sessions s ON s.id = f.session_id AND s.deleted_at IS NULL
  LEFT JOIN production_orders o ON o.id = s.order_id
  LEFT JOIN LATERAL (
    SELECT m.display_name FROM machines m
     WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true`

const FOLLOW_UP_SELECT = `
  f.id, f.automation_id AS "automationId", COALESCE(a.name, f.automation_name) AS "automationName", f.case_key AS "caseKey",
  f.title, f.body, f.status, f.assignee_id AS "assigneeId", au.name AS "assigneeName", f.creator_id AS "creatorId",
  f.due_at AS "dueAt", (f.status <> 'done' AND f.due_at < now()) AS overdue, f.escalated_at AS "escalatedAt",
  s.id AS "sessionId",
  CASE WHEN s.id IS NULL THEN NULL ELSE concat_ws(' · ',
    CASE WHEN upper(btrim(COALESCE(o.order_number, ''))) = '${STOCK_ORDER_NUMBER}' THEN 'For stock' ELSE NULLIF(btrim(o.order_number), '') END,
    NULLIF(btrim(o.item), ''),
    COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code),
    '#' || s.seq) END AS "sessionLabel",
  f.sample_id AS "sampleId", f.order_number AS "orderNumber", f.case_columns AS "caseColumns", f.case_row AS "caseRow",
  f.created_at AS "createdAt", f.updated_at AS "updatedAt", f.closed_at AS "closedAt", f.closed_by_name AS "closedByName",
  f.closing_note AS "closingNote",
  (SELECT count(*)::int FROM follow_up_events e WHERE e.follow_up_id = f.id AND e.kind = 'comment') AS "commentCount"`

/**
 * The list's order: overdue first (the longest overdue first), then the rest
 * not done by deadline, then the done ones, the latest closed first. One
 * ascending key, so a page is walked on from its last row.
 */
const sortKey = (t: string) => ({
  rank: `CASE WHEN ${t}.status = 'done' THEN 2 WHEN ${t}.due_at < now() THEN 0 ELSE 1 END`,
  at: `CASE WHEN ${t}.status = 'done' THEN -extract(epoch FROM ${t}.closed_at) ELSE extract(epoch FROM ${t}.due_at) END`,
})

interface Viewer {
  id: string
  /** Sees everyone's: a supervisor, an administrator, the assistant's owner. */
  all: boolean
}

const sees = (f: Pick<FollowUpRow, 'assigneeId' | 'creatorId'>, v: Viewer) => v.all || f.assigneeId === v.id || f.creatorId === v.id
const mayReassign = (f: Pick<FollowUpRow, 'creatorId'>, v: Viewer) => v.all || f.creatorId === v.id

/** What anyone who may reassign no follow-up gets from the people list: what an endpoint that does not exist answers. */
const noSuchEndpoint = () => new HttpError(404, 'not_found', 'No such endpoint.')

function toFollowUp(r: FollowUpRow, v: Viewer): FollowUp {
  const out: FollowUp = {
    id: r.id,
    automationId: r.automationId,
    automationName: r.automationName,
    caseKey: r.caseKey,
    title: r.title,
    body: r.body,
    status: r.status,
    assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? 'Unknown' } : null,
    dueAt: r.dueAt,
    overdue: r.overdue,
    caseColumns: r.caseColumns,
    caseRow: r.caseRow,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    commentCount: r.commentCount,
    canEdit: sees(r, v),
    canReassign: mayReassign(r, v),
  }
  if (r.escalatedAt) out.escalatedAt = r.escalatedAt
  if (r.sessionId) out.sessionId = r.sessionId
  if (r.sessionLabel) out.sessionLabel = r.sessionLabel
  if (r.sampleId) out.sampleId = r.sampleId
  if (r.orderNumber) out.orderNumber = r.orderNumber
  if (r.closedAt) out.closedAt = r.closedAt
  if (r.closedByName) out.closedByName = r.closedByName
  if (r.closingNote) out.closingNote = r.closingNote
  return out
}

async function loadFollowUp(q: Queryable, id: string, lock = false): Promise<FollowUpRow | null> {
  const { rows } = await q.query<FollowUpRow>(`SELECT ${FOLLOW_UP_SELECT} FROM ${FOLLOW_UP_FROM} WHERE f.id = $1${lock ? ' FOR UPDATE OF f' : ''}`, [id])
  return rows[0] ?? null
}

async function toDetail(q: Queryable, r: FollowUpRow, v: Viewer): Promise<FollowUpDetail> {
  const { rows } = await q.query<FollowUpEvent>(
    `SELECT id, kind, author_name AS "authorName", body, created_at AS "createdAt"
       FROM follow_up_events WHERE follow_up_id = $1 ORDER BY created_at, id`,
    [r.id],
  )
  return { ...toFollowUp(r, v), events: rows }
}

/** A moment as the factory reads it: YYYY-MM-DD HH:MM in its time zone. */
function factoryStamp(at: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

// ---- Requests ----------------------------------------------------------------------

const listQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  /** Statuses, comma separated; none: every status. */
  status: z
    .string()
    .max(100)
    .optional()
    .transform((v) => [...new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(statusSchema)),
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  automationId: uuid.optional(),
  /** The follow-ups of one session: what its page lists under "Needs review". */
  sessionId: uuid.optional(),
  /** The last follow-up of the page already read. */
  before: uuid.optional(),
})

const updateSchema = z
  .object({
    status: statusSchema.optional(),
    assigneeId: uuid.optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    closingNote: z.string().max(FOLLOW_UP_COMMENT_MAX).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.')

const commentSchema = z.object({ body: z.string().trim().min(1, 'Write a comment.').max(FOLLOW_UP_COMMENT_MAX) })

export function followUpsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const tz = ctx.config.FACTORY_TIMEZONE

  /** Who is asking, and whether they see everyone's. The owner is read again every time; nothing is pinned from here. */
  async function viewerOf(user: AuthUser): Promise<Viewer> {
    const all = user.role === 'supervisor' || user.role === 'admin' || (await currentAiOwner(db, ctx.config)) === user.id
    return { id: user.id, all }
  }

  /** The follow-up, if the viewer may see it; otherwise "not found", never a hint that it exists. */
  async function visible(q: Queryable, id: string, v: Viewer, lock = false): Promise<FollowUpRow> {
    const row = await loadFollowUp(q, id, lock)
    if (!row || !sees(row, v)) throw notFound('That follow-up')
    return row
  }

  /** The navigation badge — the open ones of the list's "Mine": assigned to the person or opened by their automations — and whether the page has anything for them. */
  r.get('/counts', async (req, res) => {
    const user = requireUser(req)
    const v = await viewerOf(user)
    const { rows } = await db.query<{ involved: boolean; mineOpen: number; mineOverdue: number }>(
      `SELECT EXISTS (SELECT 1 FROM follow_ups WHERE assignee_id = $1 OR creator_id = $1) AS involved,
              (SELECT count(*)::int FROM follow_ups WHERE (assignee_id = $1 OR creator_id = $1) AND status <> 'done') AS "mineOpen",
              (SELECT count(*)::int FROM follow_ups WHERE (assignee_id = $1 OR creator_id = $1) AND status <> 'done' AND due_at < now()) AS "mineOverdue"`,
      [user.id],
    )
    const c = rows[0]
    const body: FollowUpCountsResponse = { visible: v.all || c.involved, all: v.all, mineOpen: c.mineOpen, mineOverdue: c.mineOverdue }
    res.json(body)
  })

  /**
   * Whom a follow-up can be given to: every active account, viewers included
   * (never the system sender) — the same accounts a reassignment accepts.
   * Only for people who may reassign some follow-up: supervisors,
   * administrators, the owner, and anyone who created an automation (theirs
   * are the follow-ups of their automations, deleted ones included).
   */
  r.get('/people', async (req, res) => {
    const user = requireUser(req)
    const v = await viewerOf(user)
    if (!v.all) {
      const { rows } = await db.query<{ reassigns: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ai_automations WHERE creator_id = $1) OR EXISTS (SELECT 1 FROM follow_ups WHERE creator_id = $1) AS reassigns`,
        [user.id],
      )
      if (!rows[0].reassigns) throw noSuchEndpoint()
    }
    const { rows } = await db.query<{ id: string; name: string; username: string; role: Role }>(
      `SELECT u.id, u.name, u.username, u.role::text AS role FROM users u
        WHERE ${LIVE_PERSON}
        ORDER BY lower(u.name), u.username`,
    )
    const body: FollowUpPeopleResponse = { people: rows }
    res.json(body)
  })

  /**
   * A page of follow-ups: "mine" are those assigned to the viewer or opened
   * by their automations; "all" is everyone's for those who see everyone's
   * (for anyone else it is the same as "mine"). Overdue first, then by
   * deadline; walked on with `before`.
   */
  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const v = await viewerOf(user)
    const q = parse(listQuery, req.query)
    const params: unknown[] = []
    const p = (value: unknown) => `$${params.push(value)}`
    const where: string[] = []
    if (q.scope === 'mine' || !v.all) {
      const me = p(user.id)
      where.push(`(f.assignee_id = ${me} OR f.creator_id = ${me})`)
    }
    if (q.status.length > 0) where.push(`f.status = ANY(${p(q.status)}::text[])`)
    if (q.overdue) where.push(`f.status <> 'done' AND f.due_at < now()`)
    if (q.automationId) where.push(`f.automation_id = ${p(q.automationId)}`)
    if (q.sessionId) where.push(`f.session_id = ${p(q.sessionId)}`)
    const key = sortKey('f')
    if (q.before) {
      // Where the page starts: just after the last one read, in the same order.
      const c = sortKey('c')
      where.push(`(${key.rank}, ${key.at}, f.id) > (SELECT ${c.rank}, ${c.at}, c.id FROM follow_ups c WHERE c.id = ${p(q.before)})`)
    }
    const { rows } = await db.query<FollowUpRow>(
      `SELECT ${FOLLOW_UP_SELECT} FROM ${FOLLOW_UP_FROM}
        WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
        ORDER BY ${key.rank}, ${key.at}, f.id
        LIMIT ${p(PAGE + 1)}`,
      params,
    )
    const body: FollowUpsResponse = { followUps: rows.slice(0, PAGE).map((row) => toFollowUp(row, v)), hasMore: rows.length > PAGE }
    res.json(body)
  })

  r.get('/:id', async (req, res) => {
    const user = requireUser(req)
    const v = await viewerOf(user)
    const row = await visible(db, parse(uuid, req.params.id), v)
    res.json(await toDetail(db, row, v))
  })

  /** Status, assignee, deadline: each change in the timeline, the audit log, and told to the people it concerns. */
  r.patch('/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(updateSchema, req.body)
    const v = await viewerOf(user)

    await withTransaction(db, async (tx) => {
      const before = await visible(tx, id, v, true)
      const nextStatus = body.status ?? before.status
      const statusChanged = nextStatus !== before.status
      const closing = statusChanged && nextStatus === 'done'
      const note = body.closingNote?.trim() ?? ''
      const assigneeId = body.assigneeId?.toLowerCase()
      const reassigning = assigneeId !== undefined && assigneeId !== before.assigneeId
      const due = body.dueAt !== undefined ? new Date(body.dueAt) : null
      const moving = due !== null && due.getTime() !== new Date(before.dueAt).getTime()

      if ((reassigning || moving) && !mayReassign(before, v)) {
        throw forbidden('Only the automation’s creator, a supervisor or an administrator can reassign a follow-up or move its deadline.')
      }
      if (body.closingNote !== undefined && !closing) throw badRequest('A closing note goes with closing the follow-up: set its status to done.')
      if (closing && !note) throw badRequest('Write a closing note to close the follow-up.')
      let assignee = before.assigneeId ? { id: before.assigneeId, name: before.assigneeName ?? 'Unknown' } : null
      if (reassigning) {
        const { rows } = await tx.query<{ id: string; name: string }>(`SELECT u.id, u.name FROM users u WHERE u.id = $1 AND ${LIVE_PERSON}`, [assigneeId])
        if (!rows[0]) throw badRequest('That person cannot be assigned: the account is not active.')
        assignee = rows[0]
      }
      if (due && moving) {
        if (due.getTime() < new Date(before.createdAt).getTime()) throw badRequest('The deadline cannot be before the follow-up was opened.')
        if (due.getTime() > Date.now() + DUE_MAX_AHEAD_MS) throw badRequest('The deadline must be within a year.')
      }
      if (!statusChanged && !reassigning && !moving) return

      const dueAt = due && moving ? due.toISOString() : before.dueAt
      await tx.query(
        `UPDATE follow_ups SET
            status = $2,
            assignee_id = $3,
            due_at = $4,
            -- A deadline moved on may be missed again: it escalates again then.
            escalated_at = CASE WHEN $5::boolean AND $4::timestamptz > now() THEN NULL ELSE escalated_at END,
            closed_at      = CASE WHEN $2 <> 'done' THEN NULL WHEN status = 'done' THEN closed_at ELSE now() END,
            closed_by_id   = CASE WHEN $2 <> 'done' THEN NULL WHEN status = 'done' THEN closed_by_id ELSE $6::uuid END,
            closed_by_name = CASE WHEN $2 <> 'done' THEN NULL WHEN status = 'done' THEN closed_by_name ELSE $7 END,
            closing_note   = CASE WHEN $2 <> 'done' THEN NULL WHEN status = 'done' THEN closing_note ELSE $8 END
          WHERE id = $1`,
        [id, nextStatus, assignee?.id ?? null, dueAt, moving, user.id, user.name, closing ? note : null],
      )

      const by = { id: user.id, name: user.name }
      const events: FollowUpEventDraft[] = []
      if (statusChanged) {
        const change = `${STATUS_LABEL[before.status]} → ${STATUS_LABEL[nextStatus]}`
        events.push({ followUpId: id, kind: 'status', author: by, body: closing ? `${change}. Closing note: ${note}` : change })
      }
      if (reassigning && assignee) {
        events.push({ followUpId: id, kind: 'assignee', author: by, body: `Assigned to ${assignee.name}${before.assigneeName ? ` (was ${before.assigneeName})` : ''}` })
      }
      if (moving) events.push({ followUpId: id, kind: 'due', author: by, body: `Deadline ${factoryStamp(before.dueAt, tz)} → ${factoryStamp(dueAt, tz)}` })
      await addFollowUpEvents(tx, events)

      const session = before.sessionId ? (await sessionContexts(tx, [before.sessionId])).get(before.sessionId) : undefined
      await auditChanges(
        tx,
        followUpAuditContext(by, before, session),
        { status: STATUS_LABEL[before.status], assignee: before.assigneeName ?? '', dueAt: before.dueAt, closingNote: before.closingNote ?? '' },
        {
          status: STATUS_LABEL[nextStatus],
          assignee: assignee?.name ?? '',
          dueAt,
          closingNote: closing ? note : nextStatus === 'done' ? (before.closingNote ?? '') : '',
        },
      )

      const link = followUpLink(id)
      const automationId = before.automationId ?? undefined
      const told = new Set([user.id])
      if (reassigning && assignee && assignee.id !== user.id) {
        await createNotifications(tx, [assignee.id], {
          kind: 'follow-up-assigned',
          severity: 'warning',
          title: before.title,
          body: `${user.name} assigned this follow-up to you.`,
          link,
          automationId,
          followUpId: id,
        })
        told.add(assignee.id)
      }
      const lines: string[] = []
      if (statusChanged) lines.push(closing ? `${user.name} closed it: ${note}` : `${user.name} set it to ${STATUS_LABEL[nextStatus]}.`)
      if (moving) lines.push(`${user.name} moved the deadline to ${factoryStamp(dueAt, tz)}.`)
      if (reassigning && assignee) lines.push(`${user.name} assigned it to ${assignee.name}.`)
      const concerned = [assignee?.id, before.creatorId].filter((x): x is string => !!x && !told.has(x))
      if (concerned.length > 0) {
        await createNotifications(tx, concerned, {
          kind: 'follow-up-updated',
          severity: 'info',
          title: before.title,
          body: lines.join('\n'),
          link,
          automationId,
          followUpId: id,
        })
      }
    })
    res.json(await toDetail(db, await visible(db, id, v), v))
  })

  /** A comment, by anyone who may work on it; the assignee and the creator are told when it is someone else's. */
  r.post('/:id/comments', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { body } = parse(commentSchema, req.body)
    const v = await viewerOf(user)
    await withTransaction(db, async (tx) => {
      const row = await visible(tx, id, v, true)
      const by = { id: user.id, name: user.name }
      await addFollowUpEvents(tx, [{ followUpId: id, kind: 'comment', author: by, body }])
      // The list shows when it last moved.
      await tx.query(`UPDATE follow_ups SET updated_at = now() WHERE id = $1`, [id])
      const session = row.sessionId ? (await sessionContexts(tx, [row.sessionId])).get(row.sessionId) : undefined
      await writeAudit(tx, [auditEvent('create', followUpAuditContext(by, row, session), new Date().toISOString(), { field: 'comment', newValue: body })])
      const concerned = [row.assigneeId, row.creatorId].filter((x): x is string => !!x && x !== user.id)
      if (concerned.length > 0) {
        await createNotifications(tx, concerned, {
          kind: 'follow-up-updated',
          severity: 'info',
          title: row.title,
          body: clipText(`${user.name} commented: ${body}`, 600),
          link: followUpLink(id),
          automationId: row.automationId ?? undefined,
          followUpId: id,
        })
      }
    })
    res.status(201).json(await toDetail(db, await visible(db, id, v), v))
  })

  return r
}
