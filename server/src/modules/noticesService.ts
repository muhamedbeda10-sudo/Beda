// ============================================================================
// §16 — writing notices, in one place. The Notices page's routes and the
// assistant's cards (§23) both write through these: the same checks (the
// request schema below), the same transaction (the caller's), the same audit
// entries under the entity 'Notice', as the person who saved — or who pressed
// the card's button. The audit trail has no room for a remark, so an entry
// made from a card reads exactly like one made on the page.
//
//   createNotice    the notice, its targets, photos and files; one 'create'
//   updateNotice    everything replaced by the request; one entry per field
//   withdrawNotice  shown no more before its end; the record stays
//   deleteNotice    out of every list; the record stays (never hard-deleted)
// ============================================================================

import { z } from 'zod'
import type { SaveNoticeRequest } from '@qc/shared/api'
import { auditEvent } from '@qc/shared/audit'
import { NOTICE_SEVERITIES, NOTICE_TARGET_KINDS, PROCESSES, ROLES, type Notice } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { badRequest, notFound } from '../lib/errors'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { NOTICE_SELECT, attachNoticeParts, type NoticeRow } from './notices'

const uuid = z.string().uuid()
export const noticeDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD.')

export const noticeTargetSchema = z.object({
  kind: z.enum(NOTICE_TARGET_KINDS as unknown as [string, ...string[]]),
  value: z.string().trim().min(1).max(200),
  label: z.string().trim().max(300).default(''),
})

/** A notice as it is saved: what the page sends, and what a card applies. */
export const noticeSaveSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(4000).default(''),
    severity: z.enum(NOTICE_SEVERITIES as unknown as [string, ...string[]]),
    requiresAck: z.boolean().default(true),
    matchMode: z.enum(['all', 'any']).default('all'),
    validFrom: noticeDay,
    validTo: noticeDay.nullable().default(null),
    targets: z.array(noticeTargetSchema).max(100).default([]),
    imageIds: z.array(uuid).max(20).default([]),
    fileIds: z.array(uuid).max(10).default([]),
  })
  .superRefine((b, ctx) => {
    if (b.validTo && b.validTo < b.validFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validTo'], message: 'The end is before the start.' })
    for (const [i, t] of b.targets.entries()) {
      const bad =
        (t.kind === 'process' && !(PROCESSES as readonly string[]).includes(t.value)) ||
        (t.kind === 'role' && !(ROLES as readonly string[]).includes(t.value)) ||
        (t.kind === 'shift' && !['A', 'B', 'C'].includes(t.value)) ||
        ((t.kind === 'user' || t.kind === 'order-line') && !uuid.safeParse(t.value).success)
      if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets', i, 'value'], message: `Not a valid ${t.kind}.` })
    }
  })

/** A notice as the API hands it back: its row, whether it is shown today, and its parts. */
export type StoredNotice = NoticeRow & Pick<Notice, 'targets' | 'imageIds' | 'files'>

/**
 * One notice that is not deleted, with its targets, photos and files.
 * `lock`: held FOR NO KEY UPDATE until the transaction ends — enough to keep
 * every other writer out, and never in the way of a row that merely refers to
 * it (an assistant's card being stored, a target being inserted), which takes
 * a key share only.
 */
export async function loadNotice(q: Queryable, tz: string, id: string, lock = false): Promise<StoredNotice | null> {
  const { rows } = await q.query<NoticeRow>(`SELECT ${NOTICE_SELECT} FROM notices n WHERE n.id = $2 AND n.deleted_at IS NULL${lock ? ' FOR NO KEY UPDATE' : ''}`, [tz, id])
  if (!rows[0]) return null
  return (await attachNoticeParts(q, rows))[0]
}

/** Replace the targets, images and files of a notice with the request's. */
async function writeParts(tx: Queryable, noticeId: string, body: SaveNoticeRequest): Promise<void> {
  await tx.query(`DELETE FROM notice_targets WHERE notice_id = $1`, [noticeId])
  for (const t of body.targets) {
    await tx.query(`INSERT INTO notice_targets (notice_id, kind, value, label) VALUES ($1, $2, $3, $4)`, [noticeId, t.kind, t.value, t.label])
  }
  await tx.query(`DELETE FROM notice_images WHERE notice_id = $1`, [noticeId])
  for (const [i, imageId] of body.imageIds.entries()) {
    const { rowCount } = await tx.query(`SELECT 1 FROM images WHERE id = $1 AND deleted_at IS NULL`, [imageId])
    if (!rowCount) throw badRequest('An attached image was not found.')
    await tx.query(`INSERT INTO notice_images (notice_id, image_id, position) VALUES ($1, $2, $3)`, [noticeId, imageId, i])
  }
  // A file belongs to at most one notice; the ones dropped from this notice are marked deleted, not moved.
  await tx.query(`UPDATE notice_files SET deleted_at = now() WHERE notice_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`, [noticeId, body.fileIds])
  for (const fileId of body.fileIds) {
    const { rowCount } = await tx.query(
      `UPDATE notice_files SET notice_id = $1 WHERE id = $2 AND deleted_at IS NULL AND (notice_id IS NULL OR notice_id = $1)`,
      [noticeId, fileId],
    )
    if (!rowCount) throw badRequest('An attached file was not found.')
  }
}

/** A notice as the audit log compares it: one value per field. */
function pick(n: SaveNoticeRequest | Notice) {
  return {
    title: n.title,
    body: n.body,
    severity: n.severity,
    requiresAck: n.requiresAck,
    matchMode: n.matchMode ?? 'all',
    validFrom: n.validFrom,
    validTo: n.validTo ?? null,
    targets: n.targets.map((t) => `${t.kind}:${t.value}`).sort().join(', '),
    images: n.imageIds.length,
    files: 'fileIds' in n ? n.fileIds.length : n.files.length,
  }
}

/** Who writes: their name goes on the notice and in the audit log. */
export interface NoticeWriter {
  id: string
  name: string
}

const auditContext = (by: NoticeWriter, id: string) => ({ userId: by.id, userName: by.name, entity: 'Notice', entityId: id })

/** A new notice, in the caller's transaction. */
export async function createNotice(tx: Queryable, tz: string, by: NoticeWriter, body: SaveNoticeRequest): Promise<StoredNotice> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO notices (title, body, severity, requires_ack, valid_from, valid_to, created_by_id, created_by_name, match_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [body.title, body.body, body.severity, body.requiresAck, body.validFrom, body.validTo, by.id, by.name, body.matchMode ?? 'all'],
  )
  const id = rows[0].id
  await writeParts(tx, id, body)
  await auditCreate(tx, auditContext(by, id))
  return (await loadNotice(tx, tz, id))!
}

/** A notice replaced by the request — words, days, audience, photos and files — in the caller's transaction. */
export async function updateNotice(tx: Queryable, tz: string, by: NoticeWriter, id: string, body: SaveNoticeRequest): Promise<StoredNotice> {
  const before = await loadNotice(tx, tz, id, true)
  if (!before) throw notFound('That notice')
  await tx.query(`UPDATE notices SET title = $2, body = $3, severity = $4, requires_ack = $5, valid_from = $6, valid_to = $7, match_mode = $8 WHERE id = $1`, [
    id,
    body.title,
    body.body,
    body.severity,
    body.requiresAck,
    body.validFrom,
    body.validTo,
    body.matchMode ?? 'all',
  ])
  await writeParts(tx, id, body)
  const next = (await loadNotice(tx, tz, id))!
  await auditChanges(tx, auditContext(by, id), pick(before), pick(next))
  return next
}

/** Stop showing a notice before its end date, in the caller's transaction. The record and its acknowledgements stay. */
export async function withdrawNotice(tx: Queryable, tz: string, by: NoticeWriter, id: string): Promise<StoredNotice> {
  const { rowCount } = await tx.query(
    `UPDATE notices SET withdrawn_at = now(), withdrawn_by_id = $2, withdrawn_by_name = $3 WHERE id = $1 AND deleted_at IS NULL AND withdrawn_at IS NULL`,
    [id, by.id, by.name],
  )
  if (!rowCount) throw notFound('That notice')
  await writeAudit(tx, [auditEvent('update', auditContext(by, id), new Date().toISOString(), { field: 'withdrawn', newValue: 'yes' })])
  return (await loadNotice(tx, tz, id))!
}

/** Take a notice out of every bell and list, in the caller's transaction. The record stays for the audit. */
export async function deleteNotice(tx: Queryable, by: NoticeWriter, id: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE notices SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, by.id])
  if (!rowCount) throw notFound('That notice')
  await auditDelete(tx, auditContext(by, id))
}
