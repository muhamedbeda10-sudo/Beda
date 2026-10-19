// ============================================================================
// §16 — targeted notices: the Notices button at the top (the megaphone), and before an inspection.
//
//   Readers:  GET  /inbox            everything they may see, with their status
//             POST /match            what is still to be read where they are
//             POST /:id/seen         they opened it
//             POST /:id/acknowledge  they pressed Acknowledge
//             GET  /files/:id/content
//   Admins:   GET  /admin, POST /, PUT /:id, POST /:id/withdraw, DELETE /:id,
//             GET  /:id/acknowledgements, POST /files
//
// The writes are noticesService.ts's, which the assistant's notice cards
// (§23) write through too: one set of checks, one audit trail.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { AcknowledgeNoticeRequest, MatchNoticesResponse, NoticeInboxResponse, SaveNoticeRequest } from '@qc/shared/api'
import type { NoticeAcknowledgement, NoticeAdminRow, NoticeFile, Process } from '@qc/shared/types'
import { deriveShift, processForMachine, stockProductionOf } from '@qc/shared/rules'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requirePermission, requireUser } from '../auth/middleware'
import { dropNulls } from '../lib/rows'
import { NOTICE_FILE_TYPES, buildNoticeFileStorageKey } from '../images/storage'
import { isPdf } from './workInstructions.routes'
import { NOTICE_SELECT, attachNoticeParts, loadInbox, loadPending, type NoticeContext, type NoticeRow } from './notices'
import { createNotice, deleteNotice, noticeSaveSchema, updateNotice, withdrawNotice } from './noticesService'

const uuid = z.string().uuid()

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

export function noticesRoutes(ctx: AppContext): Router {
  const r = Router()
  const tz = ctx.config.FACTORY_TIMEZONE
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_DOCUMENT_BYTES, files: 1, fields: 5 } })

  // ---- Readers -------------------------------------------------------------

  r.get('/inbox', requirePermission('read-notices'), async (req, res) => {
    const user = requireUser(req)
    const notices = await loadInbox(ctx.db, tz, { userId: user.id, role: user.role })
    const body: NoticeInboxResponse = { notices, pendingCount: notices.filter((n) => n.pending).length }
    res.json(body)
  })

  /** What the reader still has to read where they are about to work. */
  r.post('/match', requirePermission('read-notices'), async (req, res) => {
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

  r.post('/:id/seen', requirePermission('read-notices'), (req, res) => mark(req, false, res))
  r.post('/:id/acknowledge', requirePermission('read-notices'), (req, res) => mark(req, true, res))

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

  r.get('/admin', requirePermission('manage-notices'), async (_req, res) => {
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

  r.get('/:id/acknowledgements', requirePermission('manage-notices'), async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await ctx.db.query<NoticeAcknowledgement>(
      `SELECT user_id AS "userId", user_name AS "userName", seen_at AS "seenAt", acknowledged_at AS "acknowledgedAt", context
         FROM notice_acknowledgements WHERE notice_id = $1 ORDER BY COALESCE(acknowledged_at, seen_at) DESC`,
      [id],
    )
    res.json(rows.map(dropNulls))
  })

  r.post('/files', requirePermission('manage-notices'), upload.single('file'), async (req, res) => {
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

  r.post('/', requirePermission('manage-notices'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(noticeSaveSchema, req.body) as SaveNoticeRequest
    const created = await withTransaction(ctx.db, (tx) => createNotice(tx, tz, user, body))
    res.status(201).json(created)
  })

  r.put('/:id', requirePermission('manage-notices'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(noticeSaveSchema, req.body) as SaveNoticeRequest
    const after = await withTransaction(ctx.db, (tx) => updateNotice(tx, tz, user, id, body))
    res.json(after)
  })

  /** Stop showing it before its end date. The record and its acknowledgements stay. */
  r.post('/:id/withdraw', requirePermission('manage-notices'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const after = await withTransaction(ctx.db, (tx) => withdrawNotice(tx, tz, user, id))
    res.json(after)
  })

  r.delete('/:id', requirePermission('manage-notices'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, (tx) => deleteNotice(tx, user, id))
    res.status(204).end()
  })

  return r
}
