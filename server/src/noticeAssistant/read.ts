// ============================================================================
// §23 — reading notices through the assistant, exactly as the app shows them.
//
//   • a person reads their bell (modules/notices.ts loadInbox, the very same
//     call): the notices aimed at them by name, role or everyone, and one
//     aimed at a place only after they met it there; with whether they read
//     and acknowledged each themselves — never anyone else's reading;
//   • an administrator reads every notice that is not deleted, withdrawn and
//     expired ones too, with how many saw and acknowledged each (the Notices
//     page's list), and for one notice who read it when (its
//     acknowledgements) and — when it is aimed only at people — who of them
//     has not yet. A notice aimed at a place reaches whoever works there, so
//     its readers-to-be cannot be listed: the result says so.
//
// What the model reads is bounded like a query's result: rows, and the
// characters of the whole, cut from the end with a word that it was.
// ============================================================================

import { z } from 'zod'
import { isAiDay } from '@qc/shared/ai'
import { normaliseMachineCode } from '@qc/shared/rules'
import { NOTICE_TARGET_KINDS, type NoticeAcknowledgement, type NoticeTarget, type NoticeTargetKind, type Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { factoryDay } from '../ai/prompt'
import { NOTICE_SELECT, attachNoticeParts, isPlaceBound, loadInbox, noticeApplies, type NoticeRow } from '../modules/notices'
import type { StoredNotice } from '../modules/noticesService'
import { isUuid } from '../automations/people'
import { readsEveryNotice, receivesNotices, type NoticeAsker } from './scope'
import { NOTICE_READER_ROLES, audienceText, daysText, factoryTime, noticeStatus, reachOf, reachText, type NoticeStatus } from './view'

/** What one result may hold, at most: a query's result's room. */
export const NOTICE_RESULT_CHARS = 60_000
/** Notices one list hands back, at most, and by default. */
const MAX_LIST = 100
const DEFAULT_LIST = 50
/** An administrator's list looks at this many of the latest notices matching the status and days, at most. */
const SCAN_LIMIT = 1000
/** Readers and readers-to-be one notice's details name, at most, each. */
const MAX_PEOPLE = 200

export const LIST_STATUSES = ['active', 'upcoming', 'expired', 'withdrawn', 'all'] as const

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined)
const day = z.string().refine(isAiDay, 'A day is YYYY-MM-DD, and a real date.')

export const ListNoticesInput = z
  .object({
    status: optional(z.enum(LIST_STATUSES)),
    text: optional(z.string().trim().max(200)),
    targetKind: optional(z.enum(NOTICE_TARGET_KINDS as unknown as [NoticeTargetKind, ...NoticeTargetKind[]])),
    targetValue: optional(z.string().trim().max(200)),
    createdFrom: optional(day),
    createdTo: optional(day),
    limit: optional(z.number().int().min(1).max(MAX_LIST)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.targetValue && !v.targetKind) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetValue'], message: 'Give targetKind with it.' })
    if (v.createdFrom && v.createdTo && v.createdTo < v.createdFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdTo'], message: 'It is before createdFrom.' })
  })

export type ListNoticesQuery = z.infer<typeof ListNoticesInput>

export const NoticeDetailsInput = z.object({ id: z.string() }).strict()

/** A notice as read, with what the reader's own status or the administrator's counts add. */
type ReadNotice = StoredNotice & { seenCount?: number; acknowledgedCount?: number; seenAt?: string | null; acknowledgedAt?: string | null; pending?: boolean }

const lower = (s: string) => s.toLocaleLowerCase()

/** Whether a notice names this target: its kind, and a value that is the one asked for or a label that holds it. */
function namesTarget(targets: readonly NoticeTarget[], kind: NoticeTargetKind, value: string | undefined): boolean {
  return targets.some((t) => {
    if (t.kind !== kind) return false
    if (!value) return true
    if (lower(t.value) === lower(value) || lower(t.label).includes(lower(value))) return true
    return kind === 'machine' && normaliseMachineCode(t.value) === normaliseMachineCode(value)
  })
}

/** The filters every list applies, the same for the bell and for every notice. */
function matches(n: ReadNotice, q: ListNoticesQuery, today: string, timeZone: string): boolean {
  const status = q.status ?? 'active'
  if (status !== 'all' && noticeStatus(n, today) !== status) return false
  if (q.text && !lower(`${n.title}\n${n.body}`).includes(lower(q.text))) return false
  if (q.targetKind && !namesTarget(n.targets, q.targetKind, q.targetValue)) return false
  const created = factoryDay(new Date(n.createdAt), timeZone)
  if (q.createdFrom && created < q.createdFrom) return false
  if (q.createdTo && created > q.createdTo) return false
  return true
}

/** The SQL a status narrows an administrator's list to; `today()` places the factory day as a parameter, when the status needs it. */
function statusSql(status: NoticeStatus, today: () => string): string {
  switch (status) {
    case 'active': {
      const d = today()
      return `n.withdrawn_at IS NULL AND n.valid_from <= ${d}::date AND (n.valid_to IS NULL OR n.valid_to >= ${d}::date)`
    }
    case 'upcoming':
      return `n.withdrawn_at IS NULL AND n.valid_from > ${today()}::date`
    case 'expired':
      return `n.withdrawn_at IS NULL AND n.valid_to < ${today()}::date`
    case 'withdrawn':
      return `n.withdrawn_at IS NOT NULL`
  }
}

/** Every notice that is not deleted, newest first, narrowed in the database by status and creation days. */
async function everyNotice(q: Queryable, timeZone: string, query: ListNoticesQuery, today: string): Promise<{ notices: ReadNotice[]; scanned: boolean }> {
  const params: unknown[] = [timeZone]
  const p = (v: unknown) => `$${params.push(v)}`
  const where = ['n.deleted_at IS NULL']
  const status = query.status ?? 'active'
  if (status !== 'all') where.push(statusSql(status, () => p(today)))
  if (query.createdFrom) where.push(`(n.created_at AT TIME ZONE $1)::date >= ${p(query.createdFrom)}::date`)
  if (query.createdTo) where.push(`(n.created_at AT TIME ZONE $1)::date <= ${p(query.createdTo)}::date`)
  const { rows } = await q.query<NoticeRow & { seenCount: number; acknowledgedCount: number }>(
    `SELECT ${NOTICE_SELECT},
            (SELECT count(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id)::int AS "seenCount",
            (SELECT count(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id AND a.acknowledged_at IS NOT NULL)::int AS "acknowledgedCount"
       FROM notices n
      WHERE ${where.join(' AND ')}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${p(SCAN_LIMIT)}`,
    params,
  )
  return { notices: await attachNoticeParts(q, rows), scanned: rows.length >= SCAN_LIMIT }
}

/** One notice as a list shows it: compact, its text left to notice_details. */
function listRow(n: ReadNotice, admin: boolean, today: string, timeZone: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: n.id,
    title: n.title,
    severity: n.severity,
    requiresAck: n.requiresAck,
    days: daysText(n.validFrom, n.validTo),
    status: noticeStatus(n, today),
    audience: audienceText(n.targets),
  }
  if (new Set(n.targets.map((t) => t.kind)).size > 1) row.matchMode = n.matchMode
  row.createdBy = n.createdByName
  row.createdAt = factoryTime(n.createdAt, timeZone)
  if (admin) {
    row.seen = n.seenCount ?? 0
    // Only a notice that asks for it can be acknowledged: a 0 on any other would read as "nobody did".
    if (n.requiresAck) row.acknowledged = n.acknowledgedCount ?? 0
  } else {
    row.youRead = n.seenAt != null
    if (n.requiresAck) row.youAcknowledged = n.acknowledgedAt != null
  }
  return row
}

/** A result within NOTICE_RESULT_CHARS: the list's last rows dropped, and said so, until it fits. */
function bounded(head: Record<string, unknown>, key: string, rows: unknown[], tail: Record<string, unknown> = {}): string {
  let kept = rows
  let text = JSON.stringify({ ...head, [key]: kept, ...tail })
  while (text.length > NOTICE_RESULT_CHARS && kept.length > 0) {
    kept = kept.slice(0, -1)
    text = JSON.stringify({ ...head, [key]: kept, ...tail, cutShort: `Only the first ${kept.length} fit in the result.` })
  }
  return text
}

const NO_BELL = (role: Role) =>
  `This person's role (${role}) does not receive notices in the app, so there are none for them to see. Tell them so; an administrator manages notices on the Notices page.`

/**
 * list_notices: the notices the person may see, filtered, newest first. A
 * person without a bell (a viewer) is told why there are none.
 */
export async function listNotices(q: Queryable, timeZone: string, asker: NoticeAsker, query: ListNoticesQuery, now: Date): Promise<string> {
  const today = factoryDay(now, timeZone)
  const admin = readsEveryNotice(asker.role)
  if (!admin && !receivesNotices(asker.role)) return JSON.stringify({ notices: [], note: NO_BELL(asker.role) })
  const limit = query.limit ?? DEFAULT_LIST
  let candidates: ReadNotice[]
  let scanned = false
  if (admin) ({ notices: candidates, scanned } = await everyNotice(q, timeZone, query, today))
  else candidates = await loadInbox(q, timeZone, { userId: asker.id, role: asker.role })
  const found = candidates.filter((n) => matches(n, query, today, timeZone))
  const head = {
    scope: admin ? 'every notice that is not deleted (this person is an administrator)' : "the notices in this person's bell",
    today,
    status: query.status ?? 'active',
    matching: found.length,
  }
  const tail: Record<string, unknown> = {}
  if (found.length > limit) tail.more = `${found.length - limit} more match; narrow the filters or raise limit (at most ${MAX_LIST}).`
  if (scanned) tail.scanned = `Only the latest ${SCAN_LIMIT} notices with this status were looked at; narrow by createdFrom and createdTo to reach older ones.`
  return bounded(head, 'notices', found.slice(0, limit).map((n) => listRow(n, admin, today, timeZone)), tail)
}

/** notice_details for a notice the person may not see, or that does not exist: the same words for both. */
export const NOT_VISIBLE = 'No such notice among the ones this person can see (or it was deleted). Find it with list_notices.'

const whereRead = (c: NoticeAcknowledgement['context']): string | undefined => {
  if (!c) return undefined
  const parts = [c.workCenterCode ? `machine ${c.workCenterCode}` : '', c.orderNumber ? `order ${c.orderNumber}` : '', c.itemCode ? `item ${c.itemCode}` : ''].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Names, within MAX_PEOPLE, with how many there were in all. */
const someNames = (names: string[]) => ({ count: names.length, names: names.slice(0, MAX_PEOPLE), ...(names.length > MAX_PEOPLE ? { more: names.length - MAX_PEOPLE } : {}) })

/**
 * notice_details: one notice in full, its text and audience, photos and files
 * counted; the reader's own status, or — for an administrator — whom it
 * reaches, who read it and who of its people has not yet. Null when the
 * person may not see it.
 */
export async function noticeDetails(q: Queryable, timeZone: string, asker: NoticeAsker, id: string, now: Date): Promise<string | null> {
  const today = factoryDay(now, timeZone)
  const admin = readsEveryNotice(asker.role)
  if (!isUuid(id)) return null
  let notice: ReadNotice | undefined
  if (admin) {
    const { rows } = await q.query<NoticeRow>(`SELECT ${NOTICE_SELECT} FROM notices n WHERE n.id = $2 AND n.deleted_at IS NULL`, [timeZone, id])
    notice = rows[0] ? (await attachNoticeParts(q, rows))[0] : undefined
  } else if (receivesNotices(asker.role)) {
    notice = (await loadInbox(q, timeZone, { userId: asker.id, role: asker.role })).find((n) => n.id === id.toLowerCase())
  }
  if (!notice) return null
  const out: Record<string, unknown> = {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    severity: notice.severity,
    requiresAck: notice.requiresAck,
    status: noticeStatus(notice, today),
    days: daysText(notice.validFrom, notice.validTo),
    validFrom: notice.validFrom,
    validTo: notice.validTo,
    audience: notice.targets.map((t) => ({ kind: t.kind, value: t.value, label: t.label })),
    matchMode: notice.matchMode,
    photos: notice.imageIds.length,
    files: notice.files.map((f) => f.originalFilename),
    createdBy: notice.createdByName,
    createdAt: factoryTime(notice.createdAt, timeZone),
    lastChanged: factoryTime(notice.updatedAt, timeZone),
  }
  if (notice.withdrawnAt) {
    out.withdrawnAt = factoryTime(notice.withdrawnAt, timeZone)
    if (notice.withdrawnByName) out.withdrawnBy = notice.withdrawnByName
  }
  if (!admin) {
    out.you = {
      read: notice.seenAt ? factoryTime(notice.seenAt, timeZone) : null,
      ...(notice.requiresAck ? { acknowledged: notice.acknowledgedAt ? factoryTime(notice.acknowledgedAt, timeZone) : null } : {}),
      stillToDo: notice.pending ?? false,
    }
    return JSON.stringify(out)
  }
  // How many it reaches, as the Notices page's administrator would count them: not shown to readers.
  out.reach = reachText(await reachOf(q, notice.targets, notice.matchMode))
  const { rows: acks } = await q.query<NoticeAcknowledgement>(
    `SELECT user_id AS "userId", user_name AS "userName", seen_at AS "seenAt", acknowledged_at AS "acknowledgedAt", context
       FROM notice_acknowledgements WHERE notice_id = $1 ORDER BY COALESCE(acknowledged_at, seen_at) DESC`,
    [notice.id],
  )
  const readers = acks.map((a) => {
    const r: Record<string, unknown> = { name: a.userName, read: factoryTime(a.seenAt, timeZone) }
    if (notice.requiresAck) r.acknowledged = a.acknowledgedAt ? factoryTime(a.acknowledgedAt, timeZone) : null
    const where = whereRead(a.context)
    if (where) r.where = where
    return r
  })
  out.readCount = acks.length
  if (notice.requiresAck) out.acknowledgedCount = acks.filter((a) => a.acknowledgedAt).length
  if (isPlaceBound(notice.targets, undefined, notice.matchMode)) {
    out.notYet =
      'It is aimed at a place (a machine, an order, a shift…), so it reaches whoever works there when they meet it: the people who should still read it cannot be listed, only those who did.'
  } else {
    // Aimed only at people: the live accounts it names, as the bell decides it, less those who read it.
    const { rows: people } = await q.query<{ id: string; name: string; role: Role }>(
      `SELECT u.id, u.name, u.role FROM users u
        WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND u.role::text = ANY($1::text[])
        ORDER BY lower(u.name), u.username`,
      [[...NOTICE_READER_ROLES]],
    )
    const expected = people.filter((u) => noticeApplies(notice.targets, { userId: u.id, role: u.role }, null, notice.matchMode))
    const seen = new Map(acks.map((a) => [a.userId, a]))
    out.notYet = {
      expectedReaders: expected.length,
      notRead: someNames(expected.filter((u) => !seen.has(u.id)).map((u) => u.name)),
      ...(notice.requiresAck ? { readNotAcknowledged: someNames(expected.filter((u) => seen.has(u.id) && !seen.get(u.id)!.acknowledgedAt).map((u) => u.name)) } : {}),
    }
  }
  return bounded(out, 'readers', readers.slice(0, MAX_PEOPLE), acks.length > MAX_PEOPLE ? { moreReaders: acks.length - MAX_PEOPLE } : {})
}
