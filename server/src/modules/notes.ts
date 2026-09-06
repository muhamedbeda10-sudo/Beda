// ============================================================================
// Notes about the order (§5.8). A note is a general remark — text, photos or
// both — written on the Review step. It is kept on the session that wrote it,
// so it is traceable, and read back per order, so every later session on the
// same order number sees what is already known.
// ============================================================================

import type { SessionNote } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { badRequest } from '../lib/errors'
import { linkImages } from './images.links'

const NOTE_SELECT = `
  n.id, n.session_id AS "sessionId", n.order_id AS "orderId", n.sample_id AS "sampleId", n.text,
  n.author_id AS "authorId", n.author_name AS "authorName", n.created_at AS "createdAt", n.version,
  s.seq AS "sessionSeq", s.work_center_code AS "workCenterCode", sm.index AS "sampleIndex",
  o.item, o.item_code AS "itemCode",
  COALESCE((SELECT array_agg(i.image_id::text ORDER BY i.position) FROM session_note_images i WHERE i.note_id = n.id), '{}') AS "imageIds"`

const NOTE_FROM = `
  FROM session_notes n
  JOIN inspection_sessions s ON s.id = n.session_id
  JOIN production_orders o ON o.id = n.order_id
  LEFT JOIN inspection_samples sm ON sm.id = n.sample_id
 WHERE n.deleted_at IS NULL AND s.deleted_at IS NULL`

/** Notes written during one session, newest first. */
export async function loadSessionNotes(q: Queryable, sessionId: string): Promise<SessionNote[]> {
  const { rows } = await q.query<SessionNote>(`SELECT ${NOTE_SELECT} ${NOTE_FROM} AND n.session_id = $1 ORDER BY n.created_at DESC`, [sessionId])
  return rows
}

/**
 * Every live note on the order — any line of the same order number, any
 * machine, any session — newest first. The order is the unit the inspector
 * talks about ("the customer wants…"), so a note written on the welding line
 * is read on the paint line.
 */
export async function loadOrderNotes(q: Queryable, orderId: string): Promise<SessionNote[]> {
  const { rows } = await q.query<SessionNote>(
    `SELECT ${NOTE_SELECT} ${NOTE_FROM}
        AND lower(o.order_number) = (SELECT lower(order_number) FROM production_orders WHERE id = $1)
      ORDER BY n.created_at DESC`,
    [orderId],
  )
  return rows
}

export interface NoteInput {
  text?: string
  imageIds: string[]
}

/** A note with neither text nor a photo says nothing; it is not written. */
export function noteIsEmpty(note: NoteInput | undefined): note is undefined {
  return !note || ((note.text ?? '').trim() === '' && note.imageIds.length === 0)
}

/**
 * Write one note. The caller has already checked the photos exist (§9.5) and
 * holds the session lock. Returns the note id for the audit entry.
 */
export async function writeSessionNote(
  tx: Queryable,
  args: { sessionId: string; orderId: string; sampleId: string | null; author: { id: string; name: string }; note: NoteInput },
): Promise<string> {
  const text = (args.note.text ?? '').trim()
  if (text.length > 4000) throw badRequest('A note can be at most 4000 characters.')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO session_notes (session_id, order_id, sample_id, text, author_id, author_name)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [args.sessionId, args.orderId, args.sampleId, text, args.author.id, args.author.name],
  )
  const id = rows[0].id
  await linkImages(tx, 'session_note_images', 'note_id', id, args.note.imageIds)
  return id
}
