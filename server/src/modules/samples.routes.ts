// ============================================================================
// One sample in full, and the two corrections History allows (§6, §14):
// a measurement, or a defect's disposition and quantity. Each correction is
// version-checked and writes one audit entry per changed field.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import { DISPOSITIONS, type CoilRegisterDetails, type DefectResult, type DimensionResult, type PTRecord, type PTTestedLength, type PaintSampleRecord, type SampleCoil } from '@qc/shared/types'
import { OTHER_DEFECT_NAME, dimensionStatus, isOtherDefect } from '@qc/shared/rules'
import type { SessionDefectsResponse, SampleDetail, SessionWithOrder } from '@qc/shared/api'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { ConflictError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireAnyPermission, requirePermission, requireUser, userCan, type AuthUser } from '../auth/middleware'
import { SESSION_READERS } from './sessions.routes'
import { auditChanges, auditDelete } from '../audit/service'
import { dropNulls } from '../lib/rows'
import { SAMPLE_SELECT, toSample, type SampleRow } from './sessions.sql'
import { auditCtxFor, loadSessionWithOrder } from './sessions.routes'

const uuid = z.string().uuid()

const DIMENSION_SELECT = `
  id, sample_id AS "sampleId", name, sequence, nominal, tol_plus AS "tolPlus", tol_minus AS "tolMinus", actual, unit,
  status, source, version, deleted_at AS "deletedAt"`

const DEFECT_SELECT = `
  d.id, d.sample_id AS "sampleId", d.defect_name AS "defectName", d.qty, d.disposition, d.notes, d.version, d.deleted_at AS "deletedAt",
  COALESCE((SELECT array_agg(di.image_id ORDER BY di.position) FROM defect_images di WHERE di.defect_id = d.id), '{}') AS "imageIds"`

/** True when the sample recorded nothing about the coil beyond its number. */
function hasNoDetails(c: SampleCoil): boolean {
  return [c.grade, c.smType, c.supplier, c.thickness, c.width, c.yield].every((v) => v === null || v === undefined || v === '')
}

/**
 * For coils the sample recorded by number alone — typed by hand, or picked
 * before the coil sheet carried details — attach what the register says about
 * that number today. The sample's own snapshot is never changed.
 */
async function attachRegisterDetails(q: Queryable, coils: SampleCoil[]): Promise<SampleCoil[]> {
  const bare = coils.filter(hasNoDetails)
  if (bare.length === 0) return coils.map(dropNulls)
  const numbers = Array.from(new Set(bare.map((c) => c.coilNumber.trim().toLowerCase())))
  const { rows } = await q.query<CoilRegisterDetails & { coilNumber: string }>(
    `SELECT DISTINCT ON (lower(coil_number)) lower(coil_number) AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield
       FROM coils WHERE lower(coil_number) = ANY($1::text[]) AND deleted_at IS NULL
      ORDER BY lower(coil_number), created_at DESC`,
    [numbers],
  )
  const byNumber = new Map(rows.map((r) => [r.coilNumber, r]))
  return coils.map((c) => {
    const found = hasNoDetails(c) ? byNumber.get(c.coilNumber.trim().toLowerCase()) : undefined
    if (!found) return dropNulls(c)
    const { coilNumber: _n, ...details } = found
    const register = dropNulls(details) as CoilRegisterDetails
    return Object.keys(register).length > 0 ? { ...dropNulls(c), register } : dropNulls(c)
  })
}

async function loadSampleDetail(q: Queryable, id: string): Promise<SampleDetail | null> {
  const sample = (await q.query<SampleRow>(`SELECT ${SAMPLE_SELECT} FROM inspection_samples sm WHERE sm.id = $1 AND sm.deleted_at IS NULL`, [id])).rows[0]
  if (!sample) return null
  const [dims, defects, coils, paint, pt, lengths] = await Promise.all([
    q.query<DimensionResult>(`SELECT ${DIMENSION_SELECT} FROM dimension_results WHERE sample_id = $1 AND deleted_at IS NULL ORDER BY sequence, name`, [id]),
    q.query<DefectResult>(`SELECT ${DEFECT_SELECT} FROM defect_results d WHERE d.sample_id = $1 AND d.deleted_at IS NULL ORDER BY d.updated_at, d.id`, [id]),
    q.query<SampleCoil>(
      `SELECT id, sample_id AS "sampleId", coil_id AS "coilId", coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes
         FROM sample_coils WHERE sample_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [id],
    ),
    q.query<PaintSampleRecord>(
      `SELECT p.id, p.sample_id AS "sampleId", p.notes,
              COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.position) FROM paint_sample_images pi WHERE pi.paint_sample_id = p.id), '{}') AS "imageIds"
         FROM paint_samples p WHERE p.sample_id = $1 AND p.deleted_at IS NULL`,
      [id],
    ),
    q.query<Record<string, unknown>>(
      `SELECT p.id, p.sample_id AS "sampleId", p.test_frequency_pct AS "testFrequencyPct", p.cleaner_lot AS "cleanerLot",
              p.penetrant_lot AS "penetrantLot", p.developer_lot AS "developerLot", p.sample_size AS "sampleSize",
              p.tested_weld_length AS "testedWeldLength", p.indication_type AS "indicationType", p.indication_size AS "indicationSize",
              p.welding_wire_batch AS "weldingWireBatch", p.connector_coil_number AS "connectorCoilNumber", p.accept_or_repair AS "acceptOrRepair", p.final_result AS "finalResult", p.notes,
              COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.position) FROM pt_record_images pi WHERE pi.pt_record_id = p.id), '{}') AS "imageIds"
         FROM pt_records p WHERE p.sample_id = $1 AND p.deleted_at IS NULL`,
      [id],
    ),
    q.query<PTTestedLength>(
      `SELECT l.id, l.seq, l.length_mm AS "lengthMm", l.verdict
         FROM pt_tested_lengths l JOIN pt_records p ON p.id = l.pt_record_id
        WHERE p.sample_id = $1 AND p.deleted_at IS NULL AND l.deleted_at IS NULL
        ORDER BY l.seq`,
      [id],
    ),
  ])
  const withRegister = await attachRegisterDetails(q, coils.rows)
  const ptRow = pt.rows[0]
  const ptRecord: PTRecord | null = ptRow
    ? (dropNulls({
        id: ptRow.id,
        sampleId: ptRow.sampleId,
        testFrequencyPct: ptRow.testFrequencyPct,
        consumableLots: { Cleaner: ptRow.cleanerLot, Penetrant: ptRow.penetrantLot, Developer: ptRow.developerLot },
        sampleSize: ptRow.sampleSize,
        testedWeldLength: ptRow.testedWeldLength,
        indicationType: ptRow.indicationType,
        indicationSize: ptRow.indicationSize,
        weldingWireBatch: ptRow.weldingWireBatch,
        connectorCoilNumber: ptRow.connectorCoilNumber,
        testedLengths: lengths.rows,
        acceptOrRepair: ptRow.acceptOrRepair,
        finalResult: ptRow.finalResult,
        notes: ptRow.notes,
        imageIds: ptRow.imageIds,
      }) as PTRecord)
    : null
  return {
    sample: toSample(sample),
    dimensions: dims.rows.map(dropNulls),
    defects: defects.rows.map(dropNulls),
    coils: withRegister,
    paint: paint.rows[0] ? dropNulls(paint.rows[0]) : null,
    pt: ptRecord,
  }
}

/** A row under a sample (`d`) whose sample is live: a deleted sample's rows are not corrected. */
const LIVE_SAMPLE = `EXISTS (SELECT 1 FROM inspection_samples sm WHERE sm.id = d.sample_id AND sm.deleted_at IS NULL)`

/**
 * The live session a live sample sits in, locked: every write under a session
 * locks the session before anything in it (a sample, a measurement, a
 * defect), as a re-record does, so two such writes never wait on each other
 * crosswise. Null when the sample or its session is gone or deleted.
 */
async function lockSessionOfSample(tx: Queryable, sampleId: string): Promise<SessionWithOrder | null> {
  const row = (await tx.query<{ sessionId: string }>(`SELECT session_id AS "sessionId" FROM inspection_samples WHERE id = $1 AND deleted_at IS NULL`, [sampleId])).rows[0]
  return row ? loadSessionWithOrder(tx, row.sessionId, true) : null
}

/** The same for a live measurement or defect: its sample's session, locked. The row itself is read again, under that lock. */
async function lockSessionOfChild(tx: Queryable, table: 'dimension_results' | 'defect_results', id: string): Promise<SessionWithOrder | null> {
  const row = (await tx.query<{ sampleId: string }>(`SELECT sample_id AS "sampleId" FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0]
  return row ? lockSessionOfSample(tx, row.sampleId) : null
}

/** §14 — an open session may be corrected by anyone who records; a closed one
 *  needs a supervisor. Resolved here so no client can bypass it. */
function assertMayCorrect(user: AuthUser, status: 'Open' | 'Closed'): void {
  const capability = status === 'Open' ? 'edit-open-session' : 'edit-closed-session'
  if (!userCan(user, capability)) {
    throw forbidden(
      status === 'Closed' ? 'This session is closed. You may not correct a closed session.' : 'You may not correct records.',
    )
  }
}

export function samplesRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db } = ctx

  /**
   * §7 — every live defect of one session, with the sample it sits on, so a
   * Hold can be decided from the board without opening each sample. Read by
   * anyone signed in, like the session itself; changing one goes through the
   * correction below, with its rights and its audit entry.
   */
  r.get('/defects', requireAnyPermission(...SESSION_READERS), async (req, res) => {
    requireUser(req)
    const { sessionId } = parse(z.object({ sessionId: uuid }), req.query)
    const { rows } = await db.query<DefectResult & { sampleIndex: number }>(
      `SELECT ${DEFECT_SELECT}, sm.index AS "sampleIndex"
         FROM defect_results d JOIN inspection_samples sm ON sm.id = d.sample_id
        WHERE sm.session_id = $1 AND sm.deleted_at IS NULL AND d.deleted_at IS NULL
        ORDER BY sm.index, d.defect_name, d.id`,
      [sessionId],
    )
    const body: SessionDefectsResponse = { defects: rows.map(dropNulls) }
    res.json(body)
  })

  r.get('/:id', requireAnyPermission(...SESSION_READERS), async (req, res) => {
    const detail = await loadSampleDetail(db, parse(uuid, req.params.id))
    if (!detail) throw notFound('That sample')
    res.json(detail)
  })

  /** Mark a sample deleted (§10): it leaves every list and count; the rows stay. */
  r.delete('/:id', requirePermission('delete-sample'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const session = await lockSessionOfSample(tx, id)
      if (!session) throw notFound('That sample')
      // Read again under the session's lock: a delete that went first is not a second one.
      const live = await tx.query(`SELECT 1 FROM inspection_samples WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, session.id])
      if (live.rowCount === 0) throw notFound('That sample')
      await tx.query(`UPDATE inspection_samples SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, user.id])
      await auditDelete(tx, auditCtxFor(user, session, 'InspectionSample', id, id))
    })
    res.status(204).end()
  })

  r.patch('/dimensions/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ actual: z.union([z.number().finite(), z.null()]), version: z.number().int().min(0) }), req.body)
    const updated = await withTransaction(db, async (tx) => {
      const session = await lockSessionOfChild(tx, 'dimension_results', id)
      if (!session) throw notFound('That measurement')
      const before = (await tx.query<DimensionResult>(
        `SELECT ${DIMENSION_SELECT} FROM dimension_results d WHERE d.id = $1 AND d.deleted_at IS NULL AND ${LIVE_SAMPLE} FOR UPDATE OF d`,
        [id],
      )).rows[0]
      if (!before) throw notFound('That measurement')
      assertMayCorrect(user, session.status)
      if (before.version !== body.version) throw new ConflictError(dropNulls(before))

      // The recorded verdict must always match the recorded measurement.
      const status = dimensionStatus({ nominal: before.nominal, tolPlus: before.tolPlus, tolMinus: before.tolMinus, actual: body.actual })
      const after = (await tx.query<DimensionResult>(
        `UPDATE dimension_results SET actual = $2, status = $3, version = version + 1 WHERE id = $1 RETURNING ${DIMENSION_SELECT}`,
        [id, body.actual, status],
      )).rows[0]
      await auditChanges(
        tx,
        auditCtxFor(user, session, 'DimensionResult', id, before.sampleId),
        { actual: before.actual, status: before.status },
        { actual: after.actual, status: after.status },
      )
      return dropNulls(after)
    })
    res.json(updated)
  })

  /**
   * §9.4 — correct one defect: its type, its disposition, its quantity, its
   * notes. A type picked by mistake is changed to another of the machine's
   * defects, or to "Other" with a description; the defect keeps its photos and
   * its place on the sample. The name it already carries stays allowed, so a
   * defect named before the machine's list changed can still be corrected.
   */
  r.patch('/defects/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(
      z.object({
        disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]),
        qty: z.number().positive('Quantity must be greater than zero.'),
        defectName: z.string().trim().min(1, 'Choose the defect.').max(200).optional(),
        notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
        version: z.number().int().min(0),
      }),
      req.body,
    )
    const updated = await withTransaction(db, async (tx) => {
      const session = await lockSessionOfChild(tx, 'defect_results', id)
      if (!session) throw notFound('That defect')
      const before = (await tx.query<DefectResult>(
        `SELECT ${DEFECT_SELECT} FROM defect_results d WHERE d.id = $1 AND d.deleted_at IS NULL AND ${LIVE_SAMPLE} FOR UPDATE OF d`,
        [id],
      )).rows[0]
      if (!before) throw notFound('That defect')
      assertMayCorrect(user, session.status)
      if (before.version !== body.version) throw new ConflictError(dropNulls(before))

      const defectName = body.defectName ?? before.defectName
      const notes = body.notes === undefined ? (before.notes ?? null) : body.notes === null || body.notes === '' ? null : body.notes
      if (defectName.toLowerCase() !== before.defectName.trim().toLowerCase() && !isOtherDefect(defectName)) {
        const listed = await tx.query(
          `SELECT 1 FROM work_center_defects WHERE lower(work_center_code) = lower($1) AND lower(btrim(defect_name)) = lower($2) AND deleted_at IS NULL LIMIT 1`,
          [session.workCenterCode, defectName],
        )
        if (listed.rowCount === 0) throw badRequest(`"${defectName}" is not one of machine ${session.workCenterCode}'s defects. Pick one from the list, or Other and describe it.`)
      }
      // The same rule as recording (§5.4): a defect outside the list is "Other", and says what it is.
      const name = isOtherDefect(defectName) ? OTHER_DEFECT_NAME : defectName
      if (isOtherDefect(name) && !notes) throw badRequest('Describe the "Other" defect.')

      const after = (await tx.query<DefectResult>(
        `UPDATE defect_results d SET defect_name = $2, disposition = $3, qty = $4, notes = $5, version = version + 1 WHERE id = $1 RETURNING ${DEFECT_SELECT}`,
        [id, name, body.disposition, body.qty, notes],
      )).rows[0]
      await auditChanges(
        tx,
        auditCtxFor(user, session, 'DefectResult', id, before.sampleId),
        { defectName: before.defectName, disposition: before.disposition, qty: before.qty, notes: before.notes ?? null },
        { defectName: after.defectName, disposition: after.disposition, qty: after.qty, notes: after.notes ?? null },
      )
      return dropNulls(after)
    })
    res.json(updated)
  })

  return r
}
