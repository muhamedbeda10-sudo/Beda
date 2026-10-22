// ============================================================================
// §10 — images. Bytes are stored BEFORE the metadata row, and the metadata
// row BEFORE any record may reference the image (§9.5). The client compresses
// on the device and sends a JPEG plus what it measured; the API re-validates
// the bytes, recomputes the hash, and refuses anything that disagrees.
// ============================================================================

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { AiDomain } from '@qc/shared/ai'
import type { ImageAsset, NoticeMatchMode, NoticeTarget } from '@qc/shared/types'
import type { AppContext } from '../context'
import type { Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireAnyPermission, requireUser, userCan, type AuthUser } from '../auth/middleware'
import { dropNulls } from '../lib/rows'
import { buildStorageKey, sniffImageMime } from '../images/storage'
import { isGranted, loadAccess } from '../ai/access'
import { SHARED_RUN_PHOTO } from '../ai/reportShares'
import { noticeApplies } from './notices'
import { SESSION_READERS } from './sessions.routes'

export const IMAGE_SELECT = `
  id, storage_key AS "storageKey", driver, original_filename AS "originalFilename", mime_type AS "mimeType",
  byte_size AS "byteSize", width, height, sha256, uploaded_by_id AS "uploadedById", uploaded_by_name AS "uploadedByName",
  uploaded_at AS "uploadedAt", thumbnail_data_url AS "thumbnailDataUrl", session_id AS "sessionId",
  sample_id AS "sampleId", order_id AS "orderId", deleted_at AS "deletedAt"`

const MAX_THUMBNAIL_CHARS = 96 * 1024

const fieldsSchema = z.object({
  originalFilename: z.string().trim().min(1).max(255),
  width: z.coerce.number().int().min(1).max(20000),
  height: z.coerce.number().int().min(1).max(20000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 hex characters'),
  thumbnailDataUrl: z
    .string()
    .max(MAX_THUMBNAIL_CHARS)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'thumbnail must be a base64 JPEG data URL'),
  sessionId: z.string().uuid().optional(),
  sampleId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
})

/**
 * §10, §14 — the images among `ids` this person may see. A photo is read by
 * whoever may read what it belongs to:
 *
 *   • one they uploaded themselves — a photo taken for a record not saved yet;
 *   • an item's reference photo — master data, read by everyone signed in;
 *   • an inspection's (a defect, paint, PT, a session note) — whoever opens
 *     sessions, or is given the assistant's Inspections;
 *   • a PDI's — History's readers, or whoever is given Orders and PDI;
 *   • a concession's email screenshot — whoever may open Concessions;
 *   • an inspection's or a PDI's that a delivered report shows — whoever
 *     may open that delivery (it went to them, or they made the automation),
 *     whatever their screens: a delivered report shows its content to whoever
 *     it went to. Recorded per delivery as it is stored (migration 0071);
 *     only the photos the assistant can show (ai.inspection_photos,
 *     ai.pdi_photos), whatever else a result's photo_id column might hold;
 *   • an inspection's or a PDI's that a run of a saved report shared with
 *     them showed them, for a day after that run, while the report is still
 *     shared with them (ai/reportShares.ts) — whatever their screens, as for
 *     a delivered report;
 *   • a chat message's — the members of its conversation, as its files;
 *   • a task message's — the people on the task;
 *   • a notice's — whoever the notice is for, or who manages notices.
 *
 * Anything else is "not found", as if it did not exist.
 */
export async function readableImageIds(q: Queryable, user: AuthUser, ids: readonly string[]): Promise<Set<string>> {
  const wanted = Array.from(new Set(ids))
  if (wanted.length === 0) return new Set()
  const access = await loadAccess(q, user.id)
  const aiDomain = (d: AiDomain) => isGranted(access) && access.domains.includes(d)
  const inspections = SESSION_READERS.some((p) => userCan(user, p)) || aiDomain('inspection')
  const pdis = userCan(user, 'view-history') || aiDomain('orders')
  const { rows } = await q.query<{ id: string }>(
    `SELECT i.id FROM images i
      WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL
        AND (i.uploaded_by_id = $2
             OR EXISTS (SELECT 1 FROM item_reference_images r WHERE r.image_id = i.id)
             OR ($3 AND (EXISTS (SELECT 1 FROM defect_images x WHERE x.image_id = i.id)
                         OR EXISTS (SELECT 1 FROM paint_sample_images x WHERE x.image_id = i.id)
                         OR EXISTS (SELECT 1 FROM pt_record_images x WHERE x.image_id = i.id)
                         OR EXISTS (SELECT 1 FROM session_note_images x WHERE x.image_id = i.id)))
             OR ($4 AND EXISTS (SELECT 1 FROM pdi_images x WHERE x.image_id = i.id))
             OR ($6 AND EXISTS (SELECT 1 FROM concession_images x JOIN concessions c ON c.id = x.concession_id
                                 WHERE x.image_id = i.id AND c.deleted_at IS NULL))
             OR EXISTS (SELECT 1 FROM quality_record_images x JOIN quality_records q ON q.id = x.record_id
                         WHERE x.image_id = i.id AND x.removed_at IS NULL AND q.deleted_at IS NULL
                           AND ((q.kind = 'ncr' AND $7) OR (q.kind = 'customer-complaint' AND $8)))
             OR ($5 AND EXISTS (
                   SELECT 1 FROM chat_message_images x
                     JOIN chat_messages m ON m.id = x.message_id
                     JOIN chat_conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
                    WHERE x.image_id = i.id
                      AND (c.kind = 'general' OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.conversation_id = c.id AND cm.user_id = $2 AND cm.removed_at IS NULL))))
             OR (EXISTS (
                   SELECT 1 FROM ai_report_delivery_images x
                     JOIN ai_report_deliveries d ON d.id = x.delivery_id
                     JOIN ai_automations a ON a.id = d.automation_id
                    WHERE x.image_id = i.id
                      AND (a.creator_id = $2 OR EXISTS (SELECT 1 FROM ai_report_delivery_recipients r WHERE r.delivery_id = d.id AND r.user_id = $2)))
                 AND (EXISTS (SELECT 1 FROM defect_images x WHERE x.image_id = i.id)
                      OR EXISTS (SELECT 1 FROM paint_sample_images x WHERE x.image_id = i.id)
                      OR EXISTS (SELECT 1 FROM pt_record_images x WHERE x.image_id = i.id)
                      OR EXISTS (SELECT 1 FROM session_note_images x WHERE x.image_id = i.id)
                      OR EXISTS (SELECT 1 FROM pdi_images x WHERE x.image_id = i.id)))
             OR ${SHARED_RUN_PHOTO('i', '$2')}
             OR EXISTS (
                   SELECT 1 FROM task_message_images x
                     JOIN task_messages m ON m.id = x.message_id
                     JOIN tasks t ON t.id = m.task_id
                    WHERE x.image_id = i.id
                      AND (t.created_by_id = $2 OR EXISTS (SELECT 1 FROM task_assignees p WHERE p.task_id = t.id AND p.user_id = $2))))`,
    [wanted, user.id, inspections, pdis, userCan(user, 'use-chat'), userCan(user, 'view-concessions'), userCan(user, 'view-ncr'), userCan(user, 'view-customer-complaints')],
  )
  const readable = new Set(rows.map((r) => r.id))
  const rest = wanted.filter((id) => !readable.has(id))
  if (rest.length > 0 && (userCan(user, 'manage-notices') || userCan(user, 'read-notices'))) {
    // A notice's photos: by the rule the reader's Notices are drawn by (notices.ts).
    const { rows: links } = await q.query<{ imageId: string; noticeId: string; matchMode: NoticeMatchMode }>(
      `SELECT ni.image_id AS "imageId", n.id AS "noticeId", n.match_mode AS "matchMode"
         FROM notice_images ni JOIN notices n ON n.id = ni.notice_id AND n.deleted_at IS NULL
        WHERE ni.image_id = ANY($1::uuid[])`,
      [rest],
    )
    const { rows: targets } = await q.query<NoticeTarget & { noticeId: string }>(
      `SELECT notice_id AS "noticeId", kind, value, label FROM notice_targets WHERE notice_id = ANY($1::uuid[])`,
      [Array.from(new Set(links.map((l) => l.noticeId)))],
    )
    const reader = { userId: user.id, role: user.role }
    for (const l of links) {
      const mine = targets.filter((t) => t.noticeId === l.noticeId)
      if (userCan(user, 'manage-notices') || noticeApplies(mine, reader, null, l.matchMode)) readable.add(l.imageId)
    }
  }
  return readable
}

export function imagesRoutes(ctx: AppContext): Router {
  const r = Router()
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ctx.config.MAX_IMAGE_BYTES, files: 1, fields: 10 },
  })

  r.post('/', requireAnyPermission('record-inspection', 'record-concession', 'record-ncr', 'record-customer-complaint'), upload.single('file'), async (req, res) => {
    const user = requireUser(req)
    const file = req.file
    if (!file) throw badRequest('Attach the image as the "file" field.')
    const fields = parse(fieldsSchema, req.body)

    const sniffed = sniffImageMime(file.buffer.subarray(0, 16))
    if (sniffed !== 'image/jpeg') throw badRequest('Only JPEG images are accepted after on-device compression.')
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    if (sha256 !== fields.sha256) {
      throw badRequest('The image was altered in transit: its hash does not match. Please retry the upload.')
    }

    const id = randomUUID()
    const storageKey = buildStorageKey({ id, sessionId: fields.sessionId, orderId: fields.orderId })
    await ctx.images.put(storageKey, file.buffer, 'image/jpeg')

    try {
      const { rows } = await ctx.db.query<ImageAsset>(
        `INSERT INTO images (id, storage_key, driver, original_filename, mime_type, byte_size, width, height, sha256,
                             uploaded_by_id, uploaded_by_name, thumbnail_data_url, session_id, sample_id, order_id)
         VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${IMAGE_SELECT}`,
        [
          id,
          storageKey,
          ctx.images.driver,
          fields.originalFilename,
          file.buffer.length,
          fields.width,
          fields.height,
          sha256,
          user.id,
          user.name,
          fields.thumbnailDataUrl,
          fields.sessionId ?? null,
          fields.sampleId ?? null,
          fields.orderId ?? null,
        ],
      )
      res.status(201).json(dropNulls(rows[0]))
    } catch (e) {
      // The metadata row failed, so the bytes must not stay behind as an
      // orphan nothing can ever reference.
      await ctx.images.remove(storageKey).catch(() => undefined)
      throw e
    }
  })

  /** Metadata and thumbnails of the photos asked for that this person may see; the others are left out. */
  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const ids = parse(z.string().default(''), req.query.ids).split(',').filter(Boolean)
    parse(z.array(z.string().uuid()).max(200), ids)
    if (ids.length === 0) return res.json([])
    const readable = Array.from(await readableImageIds(ctx.db, user, ids))
    if (readable.length === 0) return res.json([])
    const { rows } = await ctx.db.query<ImageAsset>(`SELECT ${IMAGE_SELECT} FROM images WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [readable])
    res.json(rows.map(dropNulls))
  })

  /** Full-resolution bytes, for whoever may see the photo; immutable, so cacheable per user. */
  r.get('/:id/content', async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    if (!(await readableImageIds(ctx.db, user, [id])).has(id)) throw notFound('That image')
    const { rows } = await ctx.db.query<{ storageKey: string; mimeType: string; byteSize: number; sha256: string }>(
      `SELECT storage_key AS "storageKey", mime_type AS "mimeType", byte_size AS "byteSize", sha256 FROM images WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const meta = rows[0]
    if (!meta) throw notFound('That image')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()

    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The image bytes are missing from storage. The metadata and hash are still on record.')
    res.setHeader('Content-Type', meta.mimeType)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    if (stored.byteSize ?? meta.byteSize) res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[images] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  return r
}
