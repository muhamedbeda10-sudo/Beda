// ============================================================================
// §21 — follow-ups: a case an automation asks a person to look at, with a
// deadline. Opened by a watch (one per case, ever), worked and closed with a
// note by people (modules/followUps.routes.ts), and escalated once when the
// deadline passes: the assignee and the automation's creator are told.
//
// A follow-up linked to a session marks it "Needs review" while it is not
// done. That is all it does to the record: it changes no quality data.
// Every change is audited (entity 'FollowUp'), visible like any other entry.
// ============================================================================

import { auditEvent, type AuditContext, type AuditDraft } from '@qc/shared/audit'
import type { AiCell } from '@qc/shared/ai'
import type { FollowUpEventKind } from '@qc/shared/automation'
import { isStockOrder } from '@qc/shared/rules'
import type { Queryable } from '../db/pool'
import { writeAudit } from '../audit/service'
import { LIVE_PERSON, distinctIds, isUuid } from './people'
import { clipText, createNotifications, type NewNotification } from './notify'
import { systemUser } from './systemChat'
import { isolate } from './text'

export interface NewFollowUp {
  automationId: string
  caseKey: string
  title: string
  body: string
  assigneeId: string | null
  dueAt: Date
  sessionId?: string | null
  sampleId?: string | null
  orderNumber?: string | null
  caseColumns: string[]
  caseRow: AiCell[]
}

export const FOLLOW_UP_TITLE_MAX = 300
export const FOLLOW_UP_BODY_MAX = 4000
/** A case key longer than this is cut: keys are ids in practice, and the unique index has a size limit. */
const CASE_KEY_MAX = 1000
const ORDER_NUMBER_MAX = 120
/** Follow-ups escalated in one pass; the rest wait for the next tick. */
const ESCALATE_BATCH = 500

export const followUpLink = (id: string) => `/follow-ups/${id}`

/** The follow-ups list narrowed to one automation's: what an assignee's digest of several opens. */
export const followUpsOfLink = (automationId: string) => `/follow-ups?automationId=${automationId}`

/** The alert telling an assignee a follow-up an automation opened is theirs. */
export function assignedNotification(f: { id: string; title: string; body: string; automationId: string; automationName: string }): NewNotification {
  return {
    kind: 'follow-up-assigned',
    severity: 'warning',
    title: f.title,
    body: `Assigned to you by the automation "${isolate(f.automationName)}".${f.body ? `\n${f.body}` : ''}`,
    link: followUpLink(f.id),
    automationId: f.automationId,
    followUpId: f.id,
  }
}

/** A follow-up's title as stored: one line, within the limit, never blank. */
export const followUpTitle = (title: string) => clipText(title.replace(/\s+/g, ' ').trim(), FOLLOW_UP_TITLE_MAX) || 'Follow-up'

// ---- What a follow-up points at ------------------------------------------------------

export interface SessionContext {
  orderNumber: string | null
  item: string | null
  workCenterCode: string
}

/** The live sessions among these ids, with what an audit entry says about each: its order, item and machine. */
export async function sessionContexts(q: Queryable, ids: readonly (string | null | undefined)[]): Promise<Map<string, SessionContext>> {
  const wanted = distinctIds(ids)
  if (wanted.length === 0) return new Map()
  const { rows } = await q.query<SessionContext & { id: string }>(
    `SELECT s.id, o.order_number AS "orderNumber", o.item, s.work_center_code AS "workCenterCode"
       FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
      WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL`,
    [wanted],
  )
  return new Map(rows.map(({ id, ...c }) => [id, c]))
}

/** The audit context of a change to a follow-up: under its session, sample and order, so it shows in their trails too. */
export function followUpAuditContext(
  by: { id: string; name: string },
  f: { id: string; sessionId: string | null; sampleId: string | null; orderNumber: string | null },
  session: SessionContext | undefined,
): AuditContext {
  return {
    userId: by.id,
    userName: by.name,
    entity: 'FollowUp',
    entityId: f.id,
    orderNumber: f.orderNumber ?? session?.orderNumber ?? undefined,
    item: session?.item ?? undefined,
    workCenterCode: session?.workCenterCode,
    sessionId: session ? (f.sessionId ?? undefined) : undefined,
    sampleId: f.sampleId ?? undefined,
  }
}

export interface FollowUpEventDraft {
  followUpId: string
  kind: FollowUpEventKind
  author: { id: string | null; name: string }
  body: string
}

/** Append to follow-ups' timelines, in the order given. */
export async function addFollowUpEvents(q: Queryable, events: FollowUpEventDraft[]): Promise<void> {
  // One at a time: each takes the clock as it is written, so the timeline keeps their order.
  for (const e of events) {
    await q.query(`INSERT INTO follow_up_events (follow_up_id, kind, author_id, author_name, body) VALUES ($1, $2, $3, $4, $5)`, [
      e.followUpId,
      e.kind,
      e.author.id,
      e.author.name,
      clipText(e.body, FOLLOW_UP_BODY_MAX),
    ])
  }
}

// ---- Opening -----------------------------------------------------------------------

/**
 * Open a follow-up for each new case: one per automation and case key, ever
 * (a case already followed up is passed over). What a case points at is
 * checked: a session or sample that is not on record is left out (a sample
 * brings its session along), an order number defaults to the session's,
 * and an assignee who cannot be told (deactivated, removed, the system
 * sender, not an account) leaves it unassigned — still visible to the
 * automation's creator, supervisors and administrators. Each one gets its
 * 'created' event and audit entry, and its assignee an alert — unless
 * `tellAssignees` is false: a watch's run tells them itself, held to the
 * bell's limits with the rest of what the run tells. Returns the new
 * follow-ups' ids, in the order of `items`. Call it inside the caller's
 * transaction for all or nothing.
 */
export async function openFollowUps(
  q: Queryable,
  items: NewFollowUp[],
  ctx: { automationName: string; creatorId: string; tellAssignees?: boolean },
): Promise<string[]> {
  if (items.length === 0) return []
  for (const item of items) {
    if (!isUuid(item.automationId)) throw new Error(`A follow-up's automationId must be a uuid: ${item.automationId}`)
    if (!(item.dueAt instanceof Date) || Number.isNaN(item.dueAt.getTime())) throw new Error('A follow-up needs a valid deadline.')
  }
  const system = await systemUser(q)
  const creatorId = isUuid(ctx.creatorId) ? ctx.creatorId : null
  const automationName = clipText(ctx.automationName.trim(), FOLLOW_UP_TITLE_MAX) || 'Automation'

  const samples = new Map(
    (
      await q.query<{ id: string; sessionId: string }>(
        `SELECT id, session_id AS "sessionId" FROM inspection_samples WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [distinctIds(items.map((i) => i.sampleId))],
      )
    ).rows.map((r) => [r.id, r.sessionId]),
  )
  const sessions = await sessionContexts(q, [...items.map((i) => i.sessionId), ...samples.values()])
  const assignable = new Set(
    (
      await q.query<{ id: string }>(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${LIVE_PERSON}`, [
        distinctIds(items.map((i) => i.assigneeId)),
      ])
    ).rows.map((r) => r.id),
  )

  const opened: string[] = []
  const audit: AuditDraft[] = []
  const at = new Date().toISOString()
  for (const item of items) {
    const sampleId = item.sampleId && isUuid(item.sampleId) && samples.has(item.sampleId.toLowerCase()) ? item.sampleId.toLowerCase() : null
    const givenSession = item.sessionId && isUuid(item.sessionId) && sessions.has(item.sessionId.toLowerCase()) ? item.sessionId.toLowerCase() : null
    const sampleSession = sampleId ? samples.get(sampleId)! : null
    const sessionId = givenSession ?? (sampleSession && sessions.has(sampleSession) ? sampleSession : null)
    const session = sessionId ? sessions.get(sessionId) : undefined
    const sessionOrder = session?.orderNumber && !isStockOrder(session) ? session.orderNumber.trim() : null
    const orderNumber = clipText((item.orderNumber ?? '').trim(), ORDER_NUMBER_MAX) || sessionOrder || null
    const assigneeId = item.assigneeId && isUuid(item.assigneeId) && assignable.has(item.assigneeId.toLowerCase()) ? item.assigneeId.toLowerCase() : null
    const title = followUpTitle(item.title)
    const body = clipText(item.body.trim(), FOLLOW_UP_BODY_MAX)

    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO follow_ups (automation_id, automation_name, creator_id, case_key, title, body, assignee_id, due_at,
                               session_id, sample_id, order_number, case_columns, case_row)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (automation_id, case_key) DO NOTHING
       RETURNING id`,
      [
        item.automationId,
        automationName,
        creatorId,
        clipText(String(item.caseKey), CASE_KEY_MAX),
        title,
        body,
        assigneeId,
        item.dueAt.toISOString(),
        sessionId,
        sampleId,
        orderNumber,
        item.caseColumns.map(String),
        JSON.stringify(item.caseRow ?? []),
      ],
    )
    const id = rows[0]?.id
    if (!id) continue
    opened.push(id)
    await addFollowUpEvents(q, [{ followUpId: id, kind: 'created', author: system, body: `Opened by the automation "${isolate(automationName)}".` }])
    audit.push(
      auditEvent('create', followUpAuditContext(system, { id, sessionId, sampleId, orderNumber }, session), at, {
        field: 'followUp',
        newValue: `${title} (automation "${automationName}")`,
      }),
    )
    if (assigneeId && ctx.tellAssignees !== false) {
      await createNotifications(q, [assigneeId], assignedNotification({ id, title, body, automationId: item.automationId, automationName }))
    }
  }
  await writeAudit(q, audit)
  return opened
}

// ---- Escalation --------------------------------------------------------------------

interface EscalatedRow {
  id: string
  automationId: string | null
  automationName: string
  creatorId: string | null
  assigneeId: string | null
  title: string
  sessionId: string | null
  sampleId: string | null
  orderNumber: string | null
}

/**
 * Tell the assignee and the automation's creator, once, about each
 * follow-up that is not done and past its deadline as of `now`. The claim is
 * one statement (escalated_at set where it was empty), so two engines at
 * once never tell anyone twice. `creatorOf` names an automation's creator
 * now; when it knows none, the person who set the automation up when the
 * follow-up was opened is told. Returns the follow-ups escalated. Call it
 * inside a transaction, so a claim whose alerts fail is not kept.
 */
export async function escalateOverdue(q: Queryable, now: Date, creatorOf: (automationId: string) => Promise<string | null>): Promise<number> {
  const { rows } = await q.query<EscalatedRow>(
    `UPDATE follow_ups f SET escalated_at = $1
      WHERE f.id IN (SELECT id FROM follow_ups
                      WHERE status <> 'done' AND escalated_at IS NULL AND due_at < $1
                      ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        AND f.status <> 'done' AND f.escalated_at IS NULL
      RETURNING f.id, f.automation_id AS "automationId", f.automation_name AS "automationName", f.creator_id AS "creatorId",
                f.assignee_id AS "assigneeId", f.title, f.session_id AS "sessionId", f.sample_id AS "sampleId", f.order_number AS "orderNumber"`,
    [now.toISOString(), ESCALATE_BATCH],
  )
  if (rows.length === 0) return 0
  const system = await systemUser(q)
  const sessions = await sessionContexts(q, rows.map((r) => r.sessionId))
  const audit: AuditDraft[] = []
  const at = new Date().toISOString()
  for (const f of rows) {
    const creatorId = (f.automationId ? await creatorOf(f.automationId) : null) ?? f.creatorId
    const told = await createNotifications(q, [f.assigneeId, creatorId].filter((x): x is string => !!x), {
      kind: 'follow-up-overdue',
      severity: 'warning',
      title: `Overdue: ${isolate(f.title)}`,
      body: `The deadline of this follow-up from the automation "${isolate(f.automationName)}" has passed.`,
      link: followUpLink(f.id),
      automationId: f.automationId ?? undefined,
      followUpId: f.id,
    })
    await addFollowUpEvents(q, [
      {
        followUpId: f.id,
        kind: 'escalated',
        author: system,
        body: told > 0 ? 'Overdue: the assignee and the automation’s creator were told.' : 'Overdue: there was nobody to tell.',
      },
    ])
    audit.push(
      auditEvent('update', followUpAuditContext(system, f, f.sessionId ? sessions.get(f.sessionId) : undefined), at, {
        field: 'escalatedAt',
        oldValue: '',
        newValue: now.toISOString(),
      }),
    )
  }
  await writeAudit(q, audit)
  return rows.length
}
