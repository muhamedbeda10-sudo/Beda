// ============================================================================
// One sample in full, and the two corrections History allows (§6, §14):
// a measurement, or a defect's disposition and quantity. Each correction is
// version-checked and writes one audit entry per changed field.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import { DISPOSITIONS, type DefectResult, type DimensionResult, type PTRecord, type PaintSampleRecord, type SampleCoil } from '@qc/shared/types'
import { can, dimensionStatus } from '@qc/shared/rules'
import type { SampleDetail } from '@qc/shared/api'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { ConflictError, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, type AuthUser } from '../auth/middleware'
import { auditChanges } from '../audit/service'
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

async function loadSampleDetail(q: Queryable, id: string): Promise<SampleDetail | null> {
  const sample = (await q.query<SampleRow>(`SELECT ${SAMPLE_SELECT} FROM inspection_samples sm WHERE sm.id = $1 AND sm.deleted_at IS NULL`, [id])).rows[0]
  if (!sample) return null
  const [dims, defects, coils, paint, pt] = await Promise.all([
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
              p.welding_wire_batch AS "weldingWireBatch", p.accept_or_repair AS "acceptOrRepair", p.final_result AS "finalResult", p.notes,
              COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.position) FROM pt_record_images pi WHERE pi.pt_record_id = p.id), '{}') AS "imageIds"
         FROM pt_records p WHERE p.sample_id = $1 AND p.deleted_at IS NULL`,
      [id],
    ),
  ])
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
    coils: coils.rows.map(dropNulls),
    paint: paint.rows[0] ? dropNulls(paint.rows[0]) : null,
    pt: ptRecord,
  }
}

/** §14 — an open session may be corrected by anyone who records; a closed one
 *  needs a supervisor. Resolved here so no client can bypass it. */
function assertMayCorrect(user: AuthUser, status: 'Open' | 'Closed'): void {
  const capability = status === 'Open' ? 'edit-open-session' : 'edit-closed-session'
  if (!can(user.role, capability)) {
    throw forbidden(
      status === 'Closed' ? 'This session is closed. Only a supervisor or admin can correct it.' : 'Your role cannot correct records.',
    )
  }
}

export function samplesRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db } = ctx

  r.get('/:id', async (req, res) => {
    const detail = await loadSampleDetail(db, parse(uuid, req.params.id))
    if (!detail) throw notFound('That sample')
    res.json(detail)
  })

  r.patch('/dimensions/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ actual: z.union([z.number().finite(), z.null()]), version: z.number().int().min(0) }), req.body)
    const updated = await withTransaction(db, async (tx) => {
      const before = (await tx.query<DimensionResult & { sessionId: string }>(
        `SELECT ${DIMENSION_SELECT}, (SELECT session_id FROM inspection_samples sm WHERE sm.id = d.sample_id) AS "sessionId"
           FROM dimension_results d WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE OF d`,
        [id],
      )).rows[0]
      if (!before) throw notFound('That measurement')
      const session = await loadSessionWithOrder(tx, before.sessionId)
      if (!session) throw notFound('That session')
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

  r.patch('/defects/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(
      z.object({
        disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]),
        qty: z.number().positive('Quantity must be greater than zero.'),
        version: z.number().int().min(0),
      }),
      req.body,
    )
    const updated = await withTransaction(db, async (tx) => {
      const before = (await tx.query<DefectResult & { sessionId: string }>(
        `SELECT ${DEFECT_SELECT}, (SELECT session_id FROM inspection_samples sm WHERE sm.id = d.sample_id) AS "sessionId"
           FROM defect_results d WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE OF d`,
        [id],
      )).rows[0]
      if (!before) throw notFound('That defect')
      const session = await loadSessionWithOrder(tx, before.sessionId)
      if (!session) throw notFound('That session')
      assertMayCorrect(user, session.status)
      if (before.version !== body.version) throw new ConflictError(dropNulls(before))

      const after = (await tx.query<DefectResult>(
        `UPDATE defect_results d SET disposition = $2, qty = $3, version = version + 1 WHERE id = $1 RETURNING ${DEFECT_SELECT}`,
        [id, body.disposition, body.qty],
      )).rows[0]
      await auditChanges(
        tx,
        auditCtxFor(user, session, 'DefectResult', id, before.sampleId),
        { disposition: before.disposition, qty: before.qty },
        { disposition: after.disposition, qty: after.qty },
      )
      return dropNulls(after)
    })
    res.json(updated)
  })

  return r
}
