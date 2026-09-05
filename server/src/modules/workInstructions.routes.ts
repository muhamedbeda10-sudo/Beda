// ============================================================================
// Work instructions — the controlled documents (PDF) an inspector opens from
// a wizard step: acceptance limits, test methods, repair instructions.
//
// Bytes go to the same store as images, under documents/. A new issue of a
// document code supersedes the issue in force; the old row and its bytes stay
// so an inspection recorded under it can still be read against it (§11).
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { UpdateWorkInstructionRequest } from '@qc/shared/api'
import { PROCESSES, WORK_INSTRUCTION_STEPS, type WorkInstruction } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { dropNulls } from '../lib/rows'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { buildDocumentStorageKey } from '../images/storage'

export const WORK_INSTRUCTION_SELECT = `
  id, code, title, issue_no AS "issueNo", issue_date AS "issueDate", process, step,
  original_filename AS "originalFilename", byte_size AS "byteSize", sha256,
  uploaded_by_name AS "uploadedByName", uploaded_at AS "uploadedAt", sort_order AS "sortOrder",
  superseded_at AS "supersededAt", superseded_by_id AS "supersededById", deleted_at AS "deletedAt"`

const scopeSchema = z.enum(['all', ...PROCESSES] as unknown as [string, ...string[]])
const stepSchema = z.enum(WORK_INSTRUCTION_STEPS as unknown as [string, ...string[]])
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD.')

const uploadFields = z.object({
  code: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  issueNo: z.string().trim().max(40).default(''),
  issueDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  process: scopeSchema,
  step: stepSchema,
})

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    issueNo: z.string().trim().max(40).optional(),
    issueDate: isoDate.nullable().optional(),
    process: scopeSchema.optional(),
    step: stepSchema.optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update.')

const uuid = z.string().uuid()

/** Every document in force for a process — its own plus the ones for every machine. */
export async function instructionsInForce(q: Queryable, process: string): Promise<WorkInstruction[]> {
  const { rows } = await q.query<WorkInstruction>(
    `SELECT ${WORK_INSTRUCTION_SELECT} FROM work_instructions
      WHERE superseded_at IS NULL AND deleted_at IS NULL AND (process = 'all' OR process = $1)
      ORDER BY step, sort_order, code`,
    [process],
  )
  return rows.map(dropNulls)
}

/** A PDF starts with "%PDF-"; anything else is refused before it is stored. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
}

export interface StoreInstructionInput {
  code: string
  title: string
  issueNo: string
  issueDate?: string | null
  process: string
  step: string
  sortOrder?: number
  originalFilename: string
  bytes: Buffer
  uploadedBy: { id: string | null; name: string }
}

/**
 * Store one document: bytes first, then the row; the issue in force under the
 * same code is marked superseded by the new row, in the same transaction.
 */
export async function storeWorkInstruction(ctx: AppContext, input: StoreInstructionInput): Promise<WorkInstruction> {
  if (!isPdf(input.bytes)) throw badRequest('Only PDF documents are accepted.')
  const id = randomUUID()
  const key = buildDocumentStorageKey(id)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  await ctx.images.put(key, input.bytes, 'application/pdf')
  try {
    return await withTransaction(ctx.db, async (tx) => {
      const previous = await tx.query<{ id: string; sortOrder: number }>(
        `SELECT id, sort_order AS "sortOrder" FROM work_instructions
          WHERE lower(code) = lower($1) AND superseded_at IS NULL AND deleted_at IS NULL FOR UPDATE`,
        [input.code],
      )
      const sortOrder = input.sortOrder ?? previous.rows[0]?.sortOrder ?? 0
      // Only one issue of a code may be in force: retire the previous one
      // before the new row takes the code, then point it at its successor.
      if (previous.rows[0]) {
        await tx.query(`UPDATE work_instructions SET superseded_at = now() WHERE id = $1`, [previous.rows[0].id])
      }
      const { rows } = await tx.query<WorkInstruction>(
        `INSERT INTO work_instructions
           (id, code, title, issue_no, issue_date, process, step, storage_key, driver, original_filename, byte_size, sha256,
            uploaded_by_id, uploaded_by_name, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${WORK_INSTRUCTION_SELECT}`,
        [
          id,
          input.code,
          input.title,
          input.issueNo,
          input.issueDate ?? null,
          input.process,
          input.step,
          key,
          ctx.images.driver,
          input.originalFilename,
          input.bytes.length,
          sha256,
          input.uploadedBy.id,
          input.uploadedBy.name,
          sortOrder,
        ],
      )
      if (previous.rows[0]) {
        await tx.query(`UPDATE work_instructions SET superseded_by_id = $2 WHERE id = $1`, [previous.rows[0].id, id])
      }
      if (input.uploadedBy.id) {
        await auditCreate(tx, { userId: input.uploadedBy.id, userName: input.uploadedBy.name, entity: 'WorkInstruction', entityId: id })
      }
      return dropNulls(rows[0])
    })
  } catch (e) {
    await ctx.images.remove(key).catch(() => undefined)
    throw e
  }
}

export function workInstructionsRoutes(ctx: AppContext): Router {
  const r = Router()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_DOCUMENT_BYTES, files: 1, fields: 10 } })

  /** In force, for one process or all; `history=1` (admin) adds superseded issues. */
  r.get('/', async (req, res) => {
    const q = parse(z.object({ process: scopeSchema.optional(), history: z.enum(['0', '1']).default('0') }), req.query)
    const user = requireUser(req)
    const history = q.history === '1' && user.role === 'admin'
    const { rows } = await ctx.db.query<WorkInstruction>(
      `SELECT ${WORK_INSTRUCTION_SELECT} FROM work_instructions
        WHERE deleted_at IS NULL
          AND ($1::boolean OR superseded_at IS NULL)
          AND ($2::text IS NULL OR process = 'all' OR process = $2)
        ORDER BY step, sort_order, code, uploaded_at DESC`,
      [history, q.process && q.process !== 'all' ? q.process : null],
    )
    res.json(rows.map(dropNulls))
  })

  r.post('/', requireCapability('manage-admin-data'), upload.single('file'), async (req, res) => {
    const user = requireUser(req)
    if (!req.file) throw badRequest('Attach the PDF as the "file" field.')
    const fields = parse(uploadFields, req.body)
    const created = await storeWorkInstruction(ctx, {
      ...fields,
      issueDate: fields.issueDate ?? null,
      originalFilename: req.file.originalname.slice(0, 255) || `${fields.code}.pdf`,
      bytes: req.file.buffer,
      uploadedBy: { id: user.id, name: user.name },
    })
    res.status(201).json(created)
  })

  r.patch('/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(updateSchema, req.body) as UpdateWorkInstructionRequest
    const after = await withTransaction(ctx.db, async (tx) => {
      const before = (
        await tx.query<WorkInstruction>(`SELECT ${WORK_INSTRUCTION_SELECT} FROM work_instructions WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
      ).rows[0]
      if (!before) throw notFound('That work instruction')
      const { rows } = await tx.query<WorkInstruction>(
        `UPDATE work_instructions
            SET title = COALESCE($2, title), issue_no = COALESCE($3, issue_no),
                issue_date = CASE WHEN $4::boolean THEN $5::date ELSE issue_date END,
                process = COALESCE($6, process), step = COALESCE($7, step), sort_order = COALESCE($8, sort_order)
          WHERE id = $1 RETURNING ${WORK_INSTRUCTION_SELECT}`,
        [id, body.title ?? null, body.issueNo ?? null, body.issueDate !== undefined, body.issueDate ?? null, body.process ?? null, body.step ?? null, body.sortOrder ?? null],
      )
      const pick = (w: WorkInstruction) => ({
        title: w.title,
        issueNo: w.issueNo,
        issueDate: w.issueDate ?? null,
        process: w.process,
        step: w.step,
        sortOrder: w.sortOrder,
      })
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'WorkInstruction', entityId: id }, pick(before), pick(rows[0]))
      return dropNulls(rows[0])
    })
    res.json(after)
  })

  /** Take a document out of use. The bytes stay for the record. */
  r.delete('/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(`UPDATE work_instructions SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, user.id])
      if (!rowCount) throw notFound('That work instruction')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'WorkInstruction', entityId: id })
    })
    res.status(204).end()
  })

  /** The PDF itself. Signed-in only; immutable per row, so cacheable per user. */
  r.get('/:id/content', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await ctx.db.query<{ storageKey: string; byteSize: number; sha256: string; originalFilename: string }>(
      `SELECT storage_key AS "storageKey", byte_size AS "byteSize", sha256, original_filename AS "originalFilename"
         FROM work_instructions WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const meta = rows[0]
    if (!meta) throw notFound('That work instruction')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()
    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The document bytes are missing from storage. The metadata and hash are still on record.')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${meta.originalFilename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[work-instructions] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  return r
}
