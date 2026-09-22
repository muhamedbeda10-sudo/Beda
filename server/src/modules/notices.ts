// ============================================================================
// §16 — notices: loading them with their targets and attachments, and
// deciding which ones apply to a reader in a place. The rule is simple and
// stated once: values of one target kind are alternatives, kinds combine,
// and a kind with no target does not care. A notice with no targets at all
// is for everyone, everywhere.
// ============================================================================

import type { Notice, NoticeFile, NoticeForUser, NoticeMatchMode, NoticeTarget, NoticeTargetKind, Process, Role, ShiftLetter } from '@qc/shared/types'
import { normaliseMachineCode } from '@qc/shared/rules'
import type { Queryable } from '../db/pool'

export const NOTICE_SELECT = `
  n.id, n.title, n.body, n.severity, n.requires_ack AS "requiresAck", n.match_mode AS "matchMode",
  to_char(n.valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(n.valid_to, 'YYYY-MM-DD') AS "validTo",
  n.created_by_id AS "createdById", n.created_by_name AS "createdByName", n.created_at AS "createdAt", n.updated_at AS "updatedAt",
  n.withdrawn_at AS "withdrawnAt", n.withdrawn_by_name AS "withdrawnByName",
  (n.withdrawn_at IS NULL AND n.valid_from <= (now() AT TIME ZONE $1)::date
     AND (n.valid_to IS NULL OR n.valid_to >= (now() AT TIME ZONE $1)::date)) AS active`

export interface NoticeRow extends Omit<Notice, 'targets' | 'imageIds' | 'files'> {
  active: boolean
}

/** Targets, images and files for a set of notices, in one query each. */
export async function attachNoticeParts<T extends { id: string }>(q: Queryable, rows: T[]): Promise<(T & { targets: NoticeTarget[]; imageIds: string[]; files: NoticeFile[] })[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [targets, images, files] = await Promise.all([
    q.query<{ noticeId: string; kind: NoticeTargetKind; value: string; label: string }>(
      `SELECT notice_id AS "noticeId", kind, value, label FROM notice_targets WHERE notice_id = ANY($1::uuid[]) ORDER BY kind, label, value`,
      [ids],
    ),
    q.query<{ noticeId: string; imageId: string }>(
      `SELECT ni.notice_id AS "noticeId", ni.image_id AS "imageId" FROM notice_images ni
         JOIN images i ON i.id = ni.image_id AND i.deleted_at IS NULL
        WHERE ni.notice_id = ANY($1::uuid[]) ORDER BY ni.position`,
      [ids],
    ),
    q.query<NoticeFile & { noticeId: string }>(
      `SELECT notice_id AS "noticeId", id, original_filename AS "originalFilename", mime_type AS "mimeType", byte_size AS "byteSize", sha256,
              uploaded_by_name AS "uploadedByName", uploaded_at AS "uploadedAt"
         FROM notice_files WHERE notice_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY uploaded_at`,
      [ids],
    ),
  ])
  const byId = new Map(rows.map((r) => [r.id, { ...r, targets: [] as NoticeTarget[], imageIds: [] as string[], files: [] as NoticeFile[] }]))
  for (const t of targets.rows) byId.get(t.noticeId)?.targets.push({ kind: t.kind, value: t.value, label: t.label })
  for (const i of images.rows) byId.get(i.noticeId)?.imageIds.push(i.imageId)
  for (const f of files.rows) {
    const { noticeId, ...file } = f
    byId.get(noticeId)?.files.push(file)
  }
  return rows.map((r) => byId.get(r.id)!)
}

/** Where a reader is: what the session or the chosen line says about the work. */
export interface NoticeContext {
  factory?: string | null
  workCenterCode?: string | null
  process?: Process | null
  orderNumber?: string | null
  orderLineId?: string | null
  itemCode?: string | null
  customer?: string | null
  shift?: ShiftLetter | null
}

export interface NoticeReader {
  userId: string
  role: Role
}

const eq = (a: string | null | undefined, b: string): boolean => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/** Whether one kind's values hit: `true`, `false`, or `null` when the kind is about a place and there is no place to check. */
function kindHits(kind: NoticeTargetKind, values: string[], reader: NoticeReader, context: NoticeContext | null): boolean | null {
  switch (kind) {
    case 'user':
      return values.includes(reader.userId)
    case 'role':
      return values.some((v) => eq(v, reader.role))
    default: {
      if (!context) return null
      const actual =
        kind === 'factory' ? context.factory
        : kind === 'machine' ? context.workCenterCode
        : kind === 'process' ? context.process
        : kind === 'order-number' ? context.orderNumber
        : kind === 'order-line' ? context.orderLineId
        : kind === 'item-code' ? context.itemCode
        : kind === 'customer' ? context.customer
        : context.shift
      if (actual === null || actual === undefined) return false
      return kind === 'machine' ? values.some((v) => normaliseMachineCode(v) === normaliseMachineCode(actual)) : values.some((v) => eq(actual, v))
    }
  }
}

/**
 * Whether a notice applies to a reader. With a context every kind is
 * checked; without one (the bell) only the kinds about the reader are, so
 * the list shows everything the reader could meet.
 *
 * `all`: every kind present has to hit (values of one kind being
 * alternatives). `any`: one hit of any kind is enough; without a context a
 * place kind counts as "could be met", so the bell can list it once seen.
 */
export function noticeApplies(targets: NoticeTarget[], reader: NoticeReader, context: NoticeContext | null, mode: NoticeMatchMode = 'all'): boolean {
  if (targets.length === 0) return true
  const kinds = new Map<NoticeTargetKind, string[]>()
  for (const t of targets) kinds.set(t.kind, [...(kinds.get(t.kind) ?? []), t.value])
  const results = Array.from(kinds, ([kind, values]) => kindHits(kind, values, reader, context))
  if (mode === 'any') return results.some((r) => r === true || r === null)
  return results.every((r) => r !== false)
}

interface StatusRow {
  noticeId: string
  seenAt: string
  acknowledgedAt: string | null
}

/** The reader's status on each notice folded in, and `pending` decided. */
export async function forReader(q: Queryable, notices: (NoticeRow & { targets: NoticeTarget[]; imageIds: string[]; files: NoticeFile[] })[], reader: NoticeReader): Promise<NoticeForUser[]> {
  if (notices.length === 0) return []
  const { rows } = await q.query<StatusRow>(
    `SELECT notice_id AS "noticeId", seen_at AS "seenAt", acknowledged_at AS "acknowledgedAt"
       FROM notice_acknowledgements WHERE user_id = $1 AND notice_id = ANY($2::uuid[])`,
    [reader.userId, notices.map((n) => n.id)],
  )
  const status = new Map(rows.map((r) => [r.noticeId, r]))
  return notices.map((n) => {
    const s = status.get(n.id)
    const seenAt = s?.seenAt ?? null
    const acknowledgedAt = s?.acknowledgedAt ?? null
    const pending = n.active && (n.requiresAck ? acknowledgedAt === null : seenAt === null)
    return { ...n, seenAt, acknowledgedAt, pending }
  })
}

const READER_KINDS: readonly NoticeTargetKind[] = ['user', 'role']

/**
 * Whether a notice reaches this reader only through a place (a machine, an
 * order…), so the bell must wait until they meet it there. Under `any`, a
 * notice that also names the reader (their user or role) is theirs at once.
 */
export function isPlaceBound(targets: NoticeTarget[], reader?: NoticeReader, mode: NoticeMatchMode = 'all'): boolean {
  const place = targets.some((t) => !READER_KINDS.includes(t.kind))
  if (!place) return false
  if (mode === 'any' && reader) {
    const named = targets.some((t) => (t.kind === 'user' && t.value === reader.userId) || (t.kind === 'role' && eq(t.value, reader.role)))
    if (named) return false
  }
  return true
}

/**
 * The bell: newest first, active ones and the archive. A notice aimed only
 * at people (a user, a role, or everyone) is listed at once. One aimed at a
 * place is listed only after this reader has met it there — the gate is
 * where it is shown — so nobody sees a notice that was not for them.
 */
export async function loadInbox(q: Queryable, tz: string, reader: NoticeReader, limit = 100): Promise<NoticeForUser[]> {
  const { rows } = await q.query<NoticeRow>(
    `SELECT ${NOTICE_SELECT} FROM notices n WHERE n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT $2`,
    [tz, limit * 3],
  )
  const withParts = await attachNoticeParts(q, rows)
  const mine = await forReader(
    q,
    withParts.filter((n) => noticeApplies(n.targets, reader, null, n.matchMode)),
    reader,
  )
  return mine.filter((n) => !isPlaceBound(n.targets, reader, n.matchMode) || n.seenAt !== null).slice(0, limit)
}

/** The notices still to be read by this reader in this place. */
export async function loadPending(q: Queryable, tz: string, reader: NoticeReader, context: NoticeContext): Promise<NoticeForUser[]> {
  const { rows } = await q.query<NoticeRow>(
    `SELECT ${NOTICE_SELECT} FROM notices n
      WHERE n.deleted_at IS NULL AND n.withdrawn_at IS NULL
        AND n.valid_from <= (now() AT TIME ZONE $1)::date
        AND (n.valid_to IS NULL OR n.valid_to >= (now() AT TIME ZONE $1)::date)
      ORDER BY CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n.created_at DESC`,
    [tz],
  )
  const withParts = await attachNoticeParts(q, rows)
  const applicable = withParts.filter((n) => noticeApplies(n.targets, reader, context, n.matchMode))
  return (await forReader(q, applicable, reader)).filter((n) => n.pending)
}
