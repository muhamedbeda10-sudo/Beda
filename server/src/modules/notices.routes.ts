// ============================================================================
// §16 — targeted notices and the bell.
//
//   Readers:  GET  /inbox            everything they may see, with their status
//             POST /match            what is still to be read where they are
//             POST /:id/seen         they opened it
//             POST /:id/acknowledge  they pressed Acknowledge
//             GET  /files/:id/content
//   Admins:   GET  /admin, POST /, PUT /:id, POST /:id/withdraw, DELETE /:id,
//             GET  /:id/acknowledgements, POST /files
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { AcknowledgeNoticeRequest, MatchNoticesResponse, NoticeInboxResponse, SaveNoticeRequest } from '@qc/shared/api'
import { NOTICE_SEVERITIES, NOTICE_TARGET_KINDS, PROCESSES, ROLES, type Notice, type NoticeAcknowledgement, type NoticeAdminRow, type NoticeFile, type Process } from '@qc/shared/types'
import { deriveShift, processForMachine, stockProductionOf } from '@qc/shared/rules'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { auditEvent } from '@qc/shared/audit'
import { dropNulls } from '../lib/rows'
import { NOTICE_FILE_TYPES, buildNoticeFileStorageKey } from '../images/storage'
import { isPdf } from './workInstructions.routes'
import { NOTICE_SELECT, attachNoticeParts, loadInbox, loadPending, type NoticeContext, type NoticeRow } from './notices'

const uuid = z.string().uuid()
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD.')

const targetSchema = z.object({
  kind: z.enum(NOTICE_TARGET_KINDS as unknown as [string, ...string[]]),
  value: z.string().trim().min(1).max(200),
  label: z.string().trim().max(300).default(''),
})

const saveSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(4000).default(''),
    severity: z.enum(NOTICE_SEVERITIES as unknown as [string, ...string[]]),
    requiresAck: z.boolean().default(true),
    matchMode: z.enum(['all', 'any']).default('all'),
    validFrom: day,
    validTo: day.nullable().default(null),
    targets: z.array(targetSchema).max(100).default([]),
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

const matchSchema = z.union([z.object({ sessionId: uuid }), z.object({ workCenterCode: z.string().trim().min(1).max(40), orderId: uuid.optional() })])

const contextSchema = z
  .object({
    sessionId: uuid.optional(),
    workCenterCode: z.string().trim().max(40).optional(),
    orderNumber: z.string().trim().max(120).optional(),
    itemCode: z.string().trim().max(120).optional(),
  })
  .optional()

/** What a file claims to be must match what its first bytes say. */
export function sniffNoticeFile(name: string, bytes: Buffer): keyof typeof NOTICE_FILE_TYPES {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.') + 1)
  if (ext === 'pdf' && isPdf(bytes)) return 'pdf'
  if (ext === 'xlsx' && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx'
  if (ext === 'xls' && bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls'
  throw badRequest('Only PDF and Excel files (.pdf, .xlsx, .xls) are accepted.')
}

async function loadNotice(q: Queryable, tz: string, id: string): Promise<(NoticeRow & Pick<Notice, 'targets' | 'imageIds' | 'files'>) | null> {
  const { rows } = await q.query<NoticeRow>(`SELECT ${NOTICE_SELECT} FROM notices n WHERE n.id = $2 AND n.deleted_at IS NULL`, [tz, id])
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

export function noticesRoutes(ctx: AppContext): Router {
  const r = Router()
  const tz = ctx.config.FACTORY_TIMEZONE
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_DOCUMENT_BYTES, files: 1, fields: 5 } })

  // ---- Readers -------------------------------------------------------------

  r.get('/inbox', requireCapability('read-notices'), async (req, res) => {
    const user = requireUser(req)
    const notices = await loadInbox(ctx.db, tz, { userId: user.id, role: user.role })
    const body: NoticeInboxResponse = { notices, pendingCount: notices.filter((n) => n.pending).length }
    res.json(body)
  })

  /** What the reader still has to read where they are about to work. */
  r.post('/match', requireCapability('read-notices'), async (req, res) => {
    const user = requireUser(req)
    const where = parse(matchSchema, req.body)
    const context: NoticeContext = { shift: deriveShift(new Date(), tz) }
    let code: string
    if ('sessionId' in where) {
      const { rows } = await ctx.db.query<{ workCenterCode: string; orderNumber: string; orderId: string; itemCode: string; customer: string | null }>(
        `SELECT s.work_center_code AS "workCenterCode", o.order_number AS "orderNumber", o.id AS "orderId", o.item_code AS "itemCode", o.customer
           FROM inspection_sessions s JOIN production_orders o ON o.id = s.order_id
          WHERE s.id = $1 AND s.deleted_at IS NULL`,
        [where.sessionId],
      )
      const s = rows[0]
      if (!s) throw notFound('That session')
      code = s.workCenterCode
      Object.assign(context, { orderNumber: s.orderNumber, orderLineId: s.orderId, itemCode: s.itemCode, customer: s.customer })
    } else {
      code = where.workCenterCode
      if (where.orderId) {
        const { rows } = await ctx.db.query<{ orderNumber: string; itemCode: string; customer: string | null }>(
          `SELECT order_number AS "orderNumber", item_code AS "itemCode", customer FROM production_orders WHERE id = $1 AND deleted_at IS NULL`,
          [where.orderId],
        )
        if (!rows[0]) throw notFound('That order line')
        Object.assign(context, { orderNumber: rows[0].orderNumber, orderLineId: where.orderId, itemCode: rows[0].itemCode, customer: rows[0].customer })
      } else {
        const stock = stockProductionOf(code)
        if (stock) Object.assign(context, { orderNumber: 'STOCK', itemCode: stock.itemCode })
      }
    }
    const machine = (
      await ctx.db.query<{ factory: string | null; process: Process | null }>(
        `SELECT factory, process FROM machines WHERE lower(code) = lower($1) AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
        [code],
      )
    ).rows[0]
    context.workCenterCode = code
    context.factory = machine?.factory ?? null
    context.process = processForMachine(machine ?? null, code)
    const notices = await loadPending(ctx.db, tz, { userId: user.id, role: user.role }, context)
    const body: MatchNoticesResponse = { notices }
    res.json(body)
  })

  async function mark(req: Request, acknowledge: boolean, res: Response) {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ context: contextSchema }), req.body ?? {}) as AcknowledgeNoticeRequest
    const { rowCount } = await ctx.db.query(`SELECT 1 FROM notices WHERE id = $1 AND deleted_at IS NULL`, [id])
    if (!rowCount) throw notFound('That notice')
    await ctx.db.query(
      `INSERT INTO notice_acknowledgements (notice_id, user_id, user_name, seen_at, acknowledged_at, context)
       VALUES ($1, $2, $3, now(), CASE WHEN $4::boolean THEN now() END, $5::jsonb)
       ON CONFLICT (notice_id, user_id) DO UPDATE
         SET acknowledged_at = COALESCE(notice_acknowledgements.acknowledged_at, EXCLUDED.acknowledged_at),
             context = COALESCE(notice_acknowledgements.context, EXCLUDED.context),
             user_name = EXCLUDED.user_name`,
      [id, user.id, user.name, acknowledge, body.context ? JSON.stringify(body.context) : null],
    )
    res.status(204).end()
  }

  r.post('/:id/seen', requireCapability('read-notices'), (req, res) => mark(req, false, res))
  r.post('/:id/acknowledge', requireCapability('read-notices'), (req, res) => mark(req, true, res))

  /** The bytes of an attached file. Signed-in only; immutable per row. */
  r.get('/files/:id/content', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await ctx.db.query<{ storageKey: string; byteSize: number; sha256: string; originalFilename: string; mimeType: string }>(
      `SELECT storage_key AS "storageKey", byte_size AS "byteSize", sha256, original_filename AS "originalFilename", mime_type AS "mimeType"
         FROM notice_files WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const meta = rows[0]
    if (!meta) throw notFound('That file')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()
    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The file bytes are missing from storage. The metadata and hash are still on record.')
    const safeName = meta.originalFilename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    res.setHeader('Content-Type', meta.mimeType)
    res.setHeader('Content-Disposition', `${meta.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename="${safeName}"`)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[notices] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  // ---- Administrators ------------------------------------------------------

  r.get('/admin', requireCapability('manage-admin-data'), async (_req, res) => {
    const { rows } = await ctx.db.query<NoticeRow & { seenCount: number; acknowledgedCount: number }>(
      `SELECT ${NOTICE_SELECT},
              (SELECT count(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id)::int AS "seenCount",
              (SELECT count(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id AND a.acknowledged_at IS NOT NULL)::int AS "acknowledgedCount"
         FROM notices n WHERE n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 500`,
      [tz],
    )
    const body: NoticeAdminRow[] = await attachNoticeParts(ctx.db, rows)
    res.json(body)
  })

  r.get('/:id/acknowledgements', requireCapability('manage-admin-data'), async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await ctx.db.query<NoticeAcknowledgement>(
      `SELECT user_id AS "userId", user_name AS "userName", seen_at AS "seenAt", acknowledged_at AS "acknowledgedAt", context
         FROM notice_acknowledgements WHERE notice_id = $1 ORDER BY COALESCE(acknowledged_at, seen_at) DESC`,
      [id],
    )
    res.json(rows.map(dropNulls))
  })

  r.post('/files', requireCapability('manage-admin-data'), upload.single('file'), async (req, res) => {
    const user = requireUser(req)
    if (!req.file) throw badRequest('Attach the document as the "file" field.')
    const name = req.file.originalname.slice(0, 255) || 'document'
    const ext = sniffNoticeFile(name, req.file.buffer)
    const id = randomUUID()
    const key = buildNoticeFileStorageKey(id, ext)
    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex')
    await ctx.images.put(key, req.file.buffer, NOTICE_FILE_TYPES[ext])
    try {
      const { rows } = await ctx.db.query<NoticeFile>(
        `INSERT INTO notice_files (id, storage_key, driver, original_filename, mime_type, byte_size, sha256, uploaded_by_id, uploaded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, original_filename AS "originalFilename", mime_type AS "mimeType", byte_size AS "byteSize", sha256,
                   uploaded_by_name AS "uploadedByName", uploaded_at AS "uploadedAt"`,
        [id, key, ctx.images.driver, name, NOTICE_FILE_TYPES[ext], req.file.buffer.length, sha256, user.id, user.name],
      )
      res.status(201).json(rows[0])
    } catch (e) {
      await ctx.images.remove(key).catch(() => undefined)
      throw e
    }
  })

  r.post('/', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(saveSchema, req.body) as SaveNoticeRequest
    const created = await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO notices (title, body, severity, requires_ack, valid_from, valid_to, created_by_id, created_by_name, match_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [body.title, body.body, body.severity, body.requiresAck, body.validFrom, body.validTo, user.id, user.name, body.matchMode ?? 'all'],
      )
      const id = rows[0].id
      await writeParts(tx, id, body)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'Notice', entityId: id })
      return (await loadNotice(tx, tz, id))!
    })
    res.status(201).json(created)
  })

  r.put('/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(saveSchema, req.body) as SaveNoticeRequest
    const after = await withTransaction(ctx.db, async (tx) => {
      const before = await loadNotice(tx, tz, id)
      if (!before) throw notFound('That notice')
      await tx.query(
        `UPDATE notices SET title = $2, body = $3, severity = $4, requires_ack = $5, valid_from = $6, valid_to = $7, match_mode = $8 WHERE id = $1`,
        [id, body.title, body.body, body.severity, body.requiresAck, body.validFrom, body.validTo, body.matchMode ?? 'all'],
      )
      await writeParts(tx, id, body)
      const next = (await loadNotice(tx, tz, id))!
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'Notice', entityId: id }, pick(before), pick(next))
      return next
    })
    res.json(after)
  })

  /** Stop showing it before its end date. The record and its acknowledgements stay. */
  r.post('/:id/withdraw', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const after = await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE notices SET withdrawn_at = now(), withdrawn_by_id = $2, withdrawn_by_name = $3 WHERE id = $1 AND deleted_at IS NULL AND withdrawn_at IS NULL`,
        [id, user.id, user.name],
      )
      if (!rowCount) throw notFound('That notice')
      await writeAudit(tx, [auditEvent('update', { userId: user.id, userName: user.name, entity: 'Notice', entityId: id }, new Date().toISOString(), { field: 'withdrawn', newValue: 'yes' })])
      return (await loadNotice(tx, tz, id))!
    })
    res.json(after)
  })

  r.delete('/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(`UPDATE notices SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, user.id])
      if (!rowCount) throw notFound('That notice')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'Notice', entityId: id })
    })
    res.status(204).end()
  })

  return r
}
