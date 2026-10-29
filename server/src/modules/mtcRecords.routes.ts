// ============================================================================
// MTC — what the registers keep beside their items (mounted in mtc.routes):
//
//   GET    /documents/:id                a kept certificate or delivery note,
//   GET    /documents/:id/content        and its bytes (?page=N for a photo).
//   GET    /coils/standards              the lab's sheet grades and grade
//                                        equivalences: the review's red/green.
//   GET    /coils/:id/details            one coil: its delivery note, its
//                                        certificate, its slitting.
//   POST   /coils/:id/slittings          a coil slit: the day and the strips.
//   DELETE /slittings/:id                one taken back (soft).
//   GET    /delivery-notes               the delivery notes, newest first;
//   GET    /delivery-notes/:id           one, with its coils;
//   POST   /delivery-notes               saved after review (or typed);
//   PUT    /delivery-notes/:id           corrected (its version, as read);
//   DELETE /delivery-notes/:id           removed (soft).
//
// Reading: whoever may open the MTC tab (the lab too for a certificate's
// file; an uploader for what they compare a reading with). Saving delivery
// notes: the MTC permission, as saving certificates. Slitting: its own
// permission. Every change is audited; a note's coils reach the coil
// register's PO and delivery date through the database's triggers.
// ============================================================================

import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  DELIVERY_NOTE_MAX_COILS,
  MTC_NUMBER_MAX,
  SLITTING_MAX_STRIPS,
  slittingProblem,
  slittingText,
  type CoilDetails,
  type CoilSlitting,
  type DeliveryNote,
  type DeliveryNoteListResponse,
  type DeliveryNoteSummary,
  type MtcDocument,
  type MtcRegisterRow,
  type MtcStandard,
  type MtcStandardsResponse,
} from '@qc/shared/mtc'
import { auditEvent, type AuditDraft } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { PG, pgCode, withTransaction, type Queryable } from '../db/pool'
import { ConflictError, HttpError, badRequest, duplicate, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, userCan } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { REGISTER_TABLES, valuesSql } from '../mtc/registers'
import { loadDocument } from '../mtc/documents'
import { loadEquivalence, loadGrades } from '../mtc/standards'
import { cleanDay } from '../mtc/deliveryReader'

const uuid = z.string().uuid()
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
const day = z.string().transform((v, c) => {
  const d = cleanDay(v)
  if (!d) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a real day (YYYY-MM-DD).' })
    return z.NEVER
  }
  return d
})
const optText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .transform((v) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max))
const measure = z.number().finite().positive().max(MTC_NUMBER_MAX)

const noteSchema = z.object({
  noteNumber: optText(120),
  deliveryDate: day,
  poNumber: optText(120),
  supplier: optText(200),
  notes: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ?? '').trim().slice(0, 1000)),
  documentId: uuid.nullish(),
  coils: z
    .array(
      z.object({
        coilNumber: z
          .string()
          .max(240)
          .transform((v) => v.replace(/\s+/g, ' ').trim().slice(0, 120)),
        weightKg: z.number().finite().min(0).max(MTC_NUMBER_MAX).nullable().optional(),
      }),
    )
    .max(DELIVERY_NOTE_MAX_COILS),
})
type NoteInput = z.infer<typeof noteSchema>

const slittingSchema = z.object({
  slitDate: day,
  widths: z.array(measure).min(1).max(SLITTING_MAX_STRIPS),
  notes: optText(1000),
})

const NOTE_SUMMARY = `n.id, COALESCE(n.note_number, '') AS "noteNumber", to_char(n.delivery_date, 'YYYY-MM-DD') AS "deliveryDate",
  COALESCE(n.po_number, '') AS "poNumber", COALESCE(n.supplier, '') AS supplier, n.document_id AS "documentId"`

const SLITTING_SELECT = `s.id, to_char(s.slit_date, 'YYYY-MM-DD') AS "slitDate", s.widths::float8[] AS widths, s.total_width::float8 AS "totalWidth",
  COALESCE(s.notes, '') AS notes, s.created_by_name AS "createdByName", s.created_at AS "createdAt"`

/** A note as the audit trail compares it: its header, and its coils in one line. */
const noteAudit = (n: Pick<NoteInput, 'noteNumber' | 'deliveryDate' | 'poNumber' | 'supplier' | 'notes' | 'coils'>): Record<string, string> => ({
  noteNumber: n.noteNumber,
  deliveryDate: n.deliveryDate,
  poNumber: n.poNumber,
  supplier: n.supplier,
  notes: n.notes,
  coils: n.coils.map((c) => (c.weightKg != null ? `${c.coilNumber} (${c.weightKg} kg)` : c.coilNumber)).join(', '),
})

export function mtcRecordRoutes(ctx: AppContext, guards: { uploaderOnly: RequestHandler; mayUpload: (userId: string) => Promise<boolean> }): Router {
  const r = Router()

  /** Who may open the MTC tab; `alsoLab`: the lab too; `alsoUploaders`: whoever may upload certificates. */
  const readers =
    (opts: { alsoLab?: boolean; alsoUploaders?: boolean } = {}): RequestHandler =>
    async (req, _res, next) => {
      const user = requireUser(req)
      if (userCan(user, 'view-mtc')) return next()
      if (opts.alsoLab && userCan(user, 'view-lab')) return next()
      if (opts.alsoUploaders && (await guards.mayUpload(user.id))) return next()
      next(forbidden())
    }

  const slitters: RequestHandler = (req, _res, next) => {
    const user = requireUser(req)
    next(userCan(user, 'view-mtc') && userCan(user, 'record-slitting') ? undefined : forbidden('You are not allowed to record slitting.'))
  }

  // ---- Kept documents ---------------------------------------------------------------

  r.get('/documents/:id', readers({ alsoLab: true, alsoUploaders: true }), async (req, res) => {
    const doc = await loadDocument(ctx, parse(uuid, req.params.id))
    if (!doc) throw notFound('That document')
    const { storageKeys: _keys, ...body } = doc
    res.json(body satisfies MtcDocument)
  })

  r.get('/documents/:id/content', readers({ alsoLab: true, alsoUploaders: true }), async (req, res) => {
    const doc = await loadDocument(ctx, parse(uuid, req.params.id))
    if (!doc) throw notFound('That document')
    const { page } = parse(z.object({ page: z.coerce.number().int().min(1).max(20).default(1) }), req.query)
    const key = doc.storageKeys[page - 1]
    if (!key) throw notFound('That page')
    const stored = await ctx.images.get(key)
    if (!stored) throw new HttpError(404, 'not_found', 'The file is missing from storage.')
    const ext = key.slice(key.lastIndexOf('.'))
    const base = doc.fileName.replace(/\.[^.]*$/, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') || 'document'
    res.setHeader('Content-Type', stored.contentType)
    res.setHeader('Content-Disposition', `${ext === '.xlsx' ? 'attachment' : 'inline'}; filename="${base}${doc.pages > 1 ? `-${page}` : ''}${ext}"`)
    // Kept as uploaded and never changed.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    if (stored.byteSize !== undefined) res.setHeader('Content-Length', String(stored.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[mtc] a document could not be streamed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  // ---- Coils ----------------------------------------------------------------------------

  r.get('/coils/standards', readers({ alsoUploaders: true }), async (_req, res) => {
    const [grades, { mappings }] = await Promise.all([loadGrades(ctx.db), loadEquivalence(ctx.db)])
    const body: MtcStandardsResponse = {
      grades: grades
        .filter((g) => g.family === 'sheet')
        .map((g) => ({
          grade: g.grade,
          standard: g.standard,
          thicknessFrom: g.thicknessFrom,
          thicknessTo: g.thicknessTo,
          yieldMin: g.yieldMin,
          yieldMax: g.yieldMax,
          tensileMin: g.tensileMin,
          tensileMax: g.tensileMax,
          elongationMin: g.elongationMin,
        })),
      gradeMappings: mappings,
    }
    res.json(body)
  })

  const coilsTable = REGISTER_TABLES.coils

  async function slittingsOf(q: Queryable, coilId: string): Promise<CoilSlitting[]> {
    const { rows } = await q.query<CoilSlitting>(
      `SELECT ${SLITTING_SELECT} FROM coil_slittings s WHERE s.coil_id = $1 AND s.deleted_at IS NULL ORDER BY s.slit_date DESC, s.created_at DESC`,
      [coilId],
    )
    return rows
  }

  r.get('/coils/:id/details', readers(), async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await ctx.db.query<MtcRegisterRow & { documentId: string | null; standard: MtcStandard | null; deliveryNoteId: string | null }>(
      `SELECT id, ${valuesSql(coilsTable)} AS "values", created_at AS "createdAt", mtc_document_id AS "documentId",
              ${coilsTable.standardSql} AS standard, delivery_note_id AS "deliveryNoteId"
         FROM coils WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const row = rows[0]
    if (!row) throw notFound('That coil')
    const [note, slittings] = await Promise.all([
      row.deliveryNoteId ? ctx.db.query<NonNullable<CoilDetails['deliveryNote']>>(`SELECT ${NOTE_SUMMARY} FROM delivery_notes n WHERE n.id = $1`, [row.deliveryNoteId]) : null,
      slittingsOf(ctx.db, id),
    ])
    const { documentId, standard, deliveryNoteId: _n, ...coil } = row
    const body: CoilDetails = {
      coil: { ...coil, ...(documentId ? { documentId } : {}), ...(standard ? { standard } : {}) },
      deliveryNote: note?.rows[0] ?? null,
      slittings,
    }
    res.json(body)
  })

  r.post('/coils/:id/slittings', slitters, async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(slittingSchema, req.body)
    const created = await withTransaction(ctx.db, async (tx) => {
      const coil = (await tx.query<{ coilNumber: string; width: number | null }>(`SELECT coil_number AS "coilNumber", width::float8 AS width FROM coils WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [id])).rows[0]
      if (!coil) throw notFound('That coil')
      const problem = slittingProblem(body.widths, coil.width)
      if (problem) throw badRequest(problem)
      const { rows } = await tx.query<CoilSlitting>(
        `INSERT INTO coil_slittings AS s (coil_id, slit_date, widths, notes, created_by_id, created_by_name)
         VALUES ($1, $2, $3::numeric[], NULLIF($4, ''), $5, $6) RETURNING ${SLITTING_SELECT}`,
        [id, body.slitDate, body.widths, body.notes, user.id, user.name],
      )
      await writeAudit(tx, [
        auditEvent('create', { userId: user.id, userName: user.name, entity: 'CoilSlitting', entityId: rows[0].id, item: coil.coilNumber }, new Date().toISOString(), {
          field: 'slitting',
          newValue: `${body.slitDate}: ${slittingText(body.widths)} mm${body.notes ? ` — ${body.notes}` : ''}`,
        }),
      ])
      return rows[0]
    })
    res.status(201).json(created)
  })

  r.delete('/slittings/:id', slitters, async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ coilNumber: string; slitDate: string; widths: number[] }>(
        `UPDATE coil_slittings s SET deleted_at = now(), deleted_by_id = $2 FROM coils c
          WHERE s.id = $1 AND s.deleted_at IS NULL AND c.id = s.coil_id
          RETURNING c.coil_number AS "coilNumber", to_char(s.slit_date, 'YYYY-MM-DD') AS "slitDate", s.widths::float8[] AS widths`,
        [id, user.id],
      )
      if (!rows[0]) throw notFound('That slitting')
      await writeAudit(tx, [
        auditEvent('delete', { userId: user.id, userName: user.name, entity: 'CoilSlitting', entityId: id, item: rows[0].coilNumber }, new Date().toISOString(), {
          field: 'slitting',
          oldValue: `${rows[0].slitDate}: ${slittingText(rows[0].widths)} mm`,
        }),
      ])
    })
    res.status(204).end()
  })

  // ---- Delivery notes ------------------------------------------------------------------

  r.get('/delivery-notes', readers({ alsoUploaders: true }), async (req, res) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(120).default(''),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    )
    const params: unknown[] = []
    const where = ['n.deleted_at IS NULL']
    if (q.search) {
      params.push(`%${escapeLike(q.search)}%`)
      where.push(`(n.note_number ILIKE $1 OR n.po_number ILIKE $1 OR n.supplier ILIKE $1
                   OR EXISTS (SELECT 1 FROM delivery_note_coils l WHERE l.delivery_note_id = n.id AND l.coil_number ILIKE $1))`)
    }
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM delivery_notes n WHERE ${where.join(' AND ')}`, params)
    const { rows } = await ctx.db.query<DeliveryNoteSummary>(
      `SELECT ${NOTE_SUMMARY}, n.created_at AS "createdAt",
              (SELECT count(*) FROM delivery_note_coils l WHERE l.delivery_note_id = n.id)::int AS coils,
              (SELECT count(*) FROM delivery_note_coils l JOIN coils c ON lower(c.coil_number) = lower(l.coil_number) AND c.deleted_at IS NULL
                WHERE l.delivery_note_id = n.id)::int AS registered
         FROM delivery_notes n WHERE ${where.join(' AND ')}
        ORDER BY n.delivery_date DESC, n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    )
    const body: DeliveryNoteListResponse = { notes: rows, total: total.rows[0].n }
    res.json(body)
  })

  async function readNote(q: Queryable, id: string, lock = false): Promise<DeliveryNote | null> {
    const { rows } = await q.query<Omit<DeliveryNote, 'coils'>>(
      `SELECT ${NOTE_SUMMARY}, COALESCE(n.notes, '') AS notes, n.version, n.created_at AS "createdAt", n.created_by_name AS "createdByName",
              n.updated_at AS "updatedAt", n.updated_by_name AS "updatedByName"
         FROM delivery_notes n WHERE n.id = $1 AND n.deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    )
    if (!rows[0]) return null
    const coils = await q.query<DeliveryNote['coils'][number]>(
      `SELECT l.coil_number AS "coilNumber", l.weight_kg::float8 AS "weightKg", c.id AS "coilId", c.mtc_number AS "mtcNumber"
         FROM delivery_note_coils l
         LEFT JOIN coils c ON lower(c.coil_number) = lower(l.coil_number) AND c.deleted_at IS NULL
        WHERE l.delivery_note_id = $1 ORDER BY l.position`,
      [id],
    )
    return { ...rows[0], coils: coils.rows }
  }

  r.get('/delivery-notes/:id', readers({ alsoUploaders: true }), async (req, res) => {
    const note = await readNote(ctx.db, parse(uuid, req.params.id))
    if (!note) throw notFound('That delivery note')
    res.json(note)
  })

  /** A note's coils, checked: each named, each once. */
  function checkCoils(body: NoteInput) {
    const seen = new Set<string>()
    for (const c of body.coils) {
      if (!c.coilNumber) throw badRequest('Every coil needs its coil number.')
      const k = c.coilNumber.toLowerCase()
      if (seen.has(k)) throw badRequest(`${c.coilNumber} is listed twice. Keep one line for each coil.`)
      seen.add(k)
    }
  }

  async function writeLines(tx: Queryable, noteId: string, body: NoteInput) {
    await tx.query(`DELETE FROM delivery_note_coils WHERE delivery_note_id = $1`, [noteId])
    if (body.coils.length === 0) return
    await tx.query(
      `INSERT INTO delivery_note_coils (delivery_note_id, position, coil_number, weight_kg)
       SELECT $1, i.position, i.coil_number, i.weight_kg FROM jsonb_to_recordset($2::jsonb) AS i(position int, coil_number text, weight_kg numeric)`,
      [noteId, JSON.stringify(body.coils.map((c, i) => ({ position: i + 1, coil_number: c.coilNumber, weight_kg: c.weightKg ?? null })))],
    )
  }

  const duplicateNote = (body: NoteInput) =>
    duplicate(`Delivery note ${body.noteNumber}${body.supplier ? ` from ${body.supplier}` : ''} is already registered.`)

  r.post('/delivery-notes', guards.uploaderOnly, async (req, res) => {
    const user = requireUser(req)
    const body = parse(noteSchema, req.body)
    checkCoils(body)
    const created = await withTransaction(ctx.db, async (tx) => {
      let id: string
      try {
        id = (
          await tx.query<{ id: string }>(
            `INSERT INTO delivery_notes (note_number, delivery_date, po_number, supplier, notes, document_id, created_by_id, created_by_name, updated_by_name)
             VALUES (NULLIF($1, ''), $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8, $8) RETURNING id`,
            [body.noteNumber, body.deliveryDate, body.poNumber, body.supplier, body.notes, body.documentId ?? null, user.id, user.name],
          )
        ).rows[0].id
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicateNote(body)
        if (pgCode(e) === PG.FOREIGN_KEY_VIOLATION) throw badRequest('The file this note was read from is not on record. Upload it again.')
        throw e
      }
      await writeLines(tx, id, body)
      const values = Object.entries(noteAudit(body))
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k} ${v}`)
        .join('; ')
      await writeAudit(tx, [
        auditEvent('create', { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: body.noteNumber || body.deliveryDate }, new Date().toISOString(), {
          field: 'source',
          newValue: `${body.documentId ? 'Delivery note read from its file' : 'Delivery note typed'} — ${values}`,
        }),
      ])
      return (await readNote(tx, id))!
    })
    res.status(201).json(created)
  })

  r.put('/delivery-notes/:id', guards.uploaderOnly, async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(noteSchema.extend({ version: z.number().int().min(1) }), req.body)
    checkCoils(body)
    const updated = await withTransaction(ctx.db, async (tx) => {
      const old = await readNote(tx, id, true)
      if (!old) throw notFound('That delivery note')
      if (old.version !== body.version) throw new ConflictError(old)
      try {
        await tx.query(
          `UPDATE delivery_notes SET note_number = NULLIF($2, ''), delivery_date = $3, po_number = NULLIF($4, ''), supplier = NULLIF($5, ''),
                  notes = NULLIF($6, ''), document_id = COALESCE($7, document_id), version = version + 1, updated_by_name = $8
            WHERE id = $1`,
          [id, body.noteNumber, body.deliveryDate, body.poNumber, body.supplier, body.notes, body.documentId ?? null, user.name],
        )
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicateNote(body)
        throw e
      }
      await writeLines(tx, id, body)
      const before = noteAudit({ ...old, coils: old.coils })
      const after = noteAudit(body)
      const at = new Date().toISOString()
      const entries: AuditDraft[] = Object.keys(after)
        .filter((k) => before[k] !== after[k])
        .map((field) =>
          auditEvent('update', { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: body.noteNumber || body.deliveryDate }, at, {
            field,
            oldValue: before[field],
            newValue: after[field],
          }),
        )
      if (entries.length) await writeAudit(tx, entries)
      return (await readNote(tx, id))!
    })
    res.json(updated)
  })

  r.delete('/delivery-notes/:id', guards.uploaderOnly, async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ item: string }>(
        `UPDATE delivery_notes SET deleted_at = now(), deleted_by_id = $2, updated_by_name = $3 WHERE id = $1 AND deleted_at IS NULL
         RETURNING COALESCE(note_number, to_char(delivery_date, 'YYYY-MM-DD')) AS item`,
        [id, user.id, user.name],
      )
      if (!rows[0]) throw notFound('That delivery note')
      await writeAudit(tx, [auditEvent('delete', { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: rows[0].item }, new Date().toISOString())])
    })
    res.status(204).end()
  })

  return r
}
