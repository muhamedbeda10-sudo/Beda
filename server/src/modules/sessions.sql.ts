// ============================================================================
// SELECT fragments and row mappers shared by the session, sample and order
// modules. Rows come back flat; the mappers fold the flat columns into the
// nested domain shapes (startQtyConfirmed, gradeAcknowledgement, order).
// ============================================================================

import type { OrderSummary, SampleSummary, SessionWithOrder } from '@qc/shared/api'
import type { InspectionSample, InspectionSession } from '@qc/shared/types'

/**
 * Requires the alias `s` for inspection_sessions. Besides the row, three
 * signals the lists colour a session by: how many defects it holds, how many
 * of them are on Hold, and whether the same item of the same order already
 * showed defects elsewhere — on another machine, or in an earlier session.
 */
export const SESSION_SELECT = `
  s.id, s.seq, s.order_id AS "orderId", s.work_center_code AS "workCenterCode",
  s.inspector_id AS "inspectorId", s.inspector_name AS "inspectorName", s.started_at AS "startedAt", s.status,
  s.start_qty AS "startQty", s.start_qty_by_id AS "startQtyById", s.start_qty_by_name AS "startQtyByName",
  s.start_qty_at AS "startQtyAt", s.final_qty AS "finalQty", s.produced_qty AS "producedQty", s.stage, s.closed_at AS "closedAt",
  s.closed_by_id AS "closedById", (SELECT u.name FROM users u WHERE u.id = s.closed_by_id) AS "closedByName",
  s.version, s.deleted_at AS "deletedAt",
  (SELECT count(*)::int FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS "sampleCount",
  (SELECT count(*)::int FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL) AS "defectCount",
  (SELECT COALESCE(sum(d.qty), 0)::float8 FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL) AS "defectPieces",
  (SELECT count(*)::int FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold') AS "holdCount",
  (SELECT count(*)::int FROM session_notes n WHERE n.session_id = s.id AND n.deleted_at IS NULL) AS "noteCount",
  (SELECT COALESCE(sum(x.sample_qty), 0)::float8 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS "piecesInspected",
  (SELECT count(*)::int FROM dimension_results r JOIN inspection_samples x ON x.id = r.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status = 'Fail') AS "dimensionFailCount",
  (SELECT count(*)::int FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id JOIN inspection_samples x ON x.id = pr.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND pr.deleted_at IS NULL AND l.deleted_at IS NULL) AS "ptTestedCount",
  EXISTS (
    SELECT 1
      FROM production_orders o1
      JOIN production_orders o2
        -- The same item is its code and its name: two items of one order may share a code.
        ON lower(o2.order_number) = lower(o1.order_number) AND lower(o2.item_code) = lower(o1.item_code)
       AND lower(btrim(o2.item)) = lower(btrim(o1.item))
      JOIN inspection_sessions s2 ON s2.order_id = o2.id AND s2.id <> s.id AND s2.deleted_at IS NULL
      JOIN inspection_samples x2 ON x2.session_id = s2.id AND x2.deleted_at IS NULL
      JOIN defect_results d2 ON d2.sample_id = x2.id AND d2.deleted_at IS NULL
     WHERE o1.id = s.order_id AND btrim(o1.item_code) <> ''
       AND (lower(s2.work_center_code) <> lower(s.work_center_code) OR s2.started_at < s.started_at)
  ) AS "priorDefectsElsewhere"`

/** Requires the alias `o` for production_orders (LEFT JOINed). */
export const ORDER_SUMMARY_SELECT = `
  o.id AS "o_id", o.line_key AS "o_lineKey", o.order_number AS "o_orderNumber", o.item AS "o_item", o.item_code AS "o_itemCode",
  o.work_center_code AS "o_workCenterCode", o.customer AS "o_customer", o.expected_grade AS "o_expectedGrade",
  o.erp_status AS "o_erpStatus"`

/** Requires the alias `sm` for inspection_samples. */
export const SAMPLE_SUMMARY_SELECT = `
  sm.id, sm.session_id AS "sessionId", sm.index, sm.shift, sm.created_at AS "createdAt",
  sm.inspector_name AS "inspectorName", sm.sample_qty AS "sampleQty",
  (SELECT count(*)::int FROM dimension_results d WHERE d.sample_id = sm.id AND d.deleted_at IS NULL) AS "dimensionCount",
  (SELECT count(*)::int FROM dimension_results d WHERE d.sample_id = sm.id AND d.deleted_at IS NULL AND d.actual IS NOT NULL) AS "measuredDimensionCount",
  (SELECT count(*)::int FROM defect_results d WHERE d.sample_id = sm.id AND d.deleted_at IS NULL) AS "defectCount",
  (SELECT count(*)::int FROM defect_results d WHERE d.sample_id = sm.id AND d.deleted_at IS NULL AND d.disposition = 'Hold') AS "holdCount",
  (SELECT count(*)::int FROM sample_coils c WHERE c.sample_id = sm.id AND c.deleted_at IS NULL) AS "coilCount"`

export const SAMPLE_SELECT = `
  ${SAMPLE_SUMMARY_SELECT},
  sm.order_id AS "orderId", sm.inspector_id AS "inspectorId", sm.drawing, sm.drawing_alt AS "drawingAlt", sm.issue,
  sm.grade_ack_by_id AS "gradeAckById", sm.grade_ack_by_name AS "gradeAckByName", sm.grade_ack_at AS "gradeAckAt",
  sm.grade_ack_coil_numbers AS "gradeAckCoilNumbers", sm.grade_ack_expected_grade AS "gradeAckExpectedGrade",
  sm.grade_ack_found_grades AS "gradeAckFoundGrades", sm.submission_id AS "submissionId", sm.version,
  sm.deleted_at AS "deletedAt"`

export interface SessionRow {
  id: string
  seq: number
  orderId: string
  workCenterCode: string
  inspectorId: string
  inspectorName: string
  startedAt: string
  status: 'Open' | 'Closed'
  startQty: number | null
  startQtyById: string | null
  startQtyByName: string | null
  startQtyAt: string | null
  finalQty: number | null
  producedQty: number | null
  stage: number | null
  closedAt: string | null
  closedById: string | null
  closedByName: string | null
  version: number
  deletedAt: string | null
  sampleCount: number
  defectCount: number
  defectPieces: number
  holdCount: number
  noteCount: number
  piecesInspected: number
  dimensionFailCount: number
  ptTestedCount: number
  priorDefectsElsewhere: boolean
}

export interface OrderSummaryRow {
  o_id: string | null
  o_lineKey: string | null
  o_orderNumber: string | null
  o_item: string | null
  o_itemCode: string | null
  o_workCenterCode: string | null
  o_customer: string | null
  o_expectedGrade: string | null
  o_erpStatus: string | null
}

export function toSession(r: SessionRow): InspectionSession {
  const out: InspectionSession = {
    id: r.id,
    seq: r.seq,
    orderId: r.orderId,
    workCenterCode: r.workCenterCode,
    inspectorId: r.inspectorId,
    inspectorName: r.inspectorName,
    startedAt: r.startedAt,
    status: r.status,
    version: r.version,
    sampleCount: r.sampleCount,
    defectCount: r.defectCount,
    defectPieces: r.defectPieces,
    holdCount: r.holdCount,
    noteCount: r.noteCount,
    piecesInspected: r.piecesInspected,
    dimensionFailCount: r.dimensionFailCount,
    ptTestedCount: r.ptTestedCount,
    priorDefectsElsewhere: r.priorDefectsElsewhere,
  }
  if (r.startQty !== null && r.startQtyById && r.startQtyByName && r.startQtyAt) {
    out.startQtyConfirmed = { qty: r.startQty, byId: r.startQtyById, byName: r.startQtyByName, at: r.startQtyAt }
  }
  if (r.finalQty !== null) out.finalQty = r.finalQty
  if (r.producedQty !== null) out.producedQty = r.producedQty
  if (r.stage !== null && r.stage !== undefined) out.stage = r.stage
  if (r.closedAt) out.closedAt = r.closedAt
  if (r.closedById) out.closedById = r.closedById
  if (r.closedByName) out.closedByName = r.closedByName
  if (r.deletedAt) out.deletedAt = r.deletedAt
  return out
}

export function toOrderSummary(r: OrderSummaryRow): OrderSummary | null {
  if (!r.o_id) return null
  return {
    id: r.o_id,
    lineKey: r.o_lineKey ?? '',
    orderNumber: r.o_orderNumber ?? '',
    item: r.o_item ?? '',
    itemCode: r.o_itemCode ?? '',
    workCenterCode: r.o_workCenterCode ?? '',
    customer: r.o_customer ?? '',
    expectedGrade: r.o_expectedGrade ?? '',
    erpStatus: r.o_erpStatus ?? '',
  }
}

export function toSessionWithOrder(r: SessionRow & OrderSummaryRow): SessionWithOrder {
  return { ...toSession(r), order: toOrderSummary(r) }
}

export interface SampleRow extends SampleSummary {
  orderId: string
  inspectorId: string
  drawing: string
  drawingAlt: string | null
  issue: string | null
  gradeAckById: string | null
  gradeAckByName: string | null
  gradeAckAt: string | null
  gradeAckCoilNumbers: string[] | null
  gradeAckExpectedGrade: string | null
  gradeAckFoundGrades: string[] | null
  submissionId: string
  version: number
  deletedAt: string | null
}

export function toSample(r: SampleRow): InspectionSample {
  const out: InspectionSample = {
    id: r.id,
    sessionId: r.sessionId,
    orderId: r.orderId,
    index: r.index,
    shift: r.shift,
    createdAt: r.createdAt,
    inspectorId: r.inspectorId,
    inspectorName: r.inspectorName,
    drawing: r.drawing,
    sampleQty: r.sampleQty,
    submissionId: r.submissionId,
    version: r.version,
    dimensionCount: r.dimensionCount,
    measuredDimensionCount: r.measuredDimensionCount,
    defectCount: r.defectCount,
    coilCount: r.coilCount,
  }
  if (r.drawingAlt) out.drawingAlt = r.drawingAlt
  if (r.issue) out.issue = r.issue
  if (r.gradeAckById && r.gradeAckByName && r.gradeAckAt) {
    out.gradeAcknowledgement = {
      byId: r.gradeAckById,
      byName: r.gradeAckByName,
      at: r.gradeAckAt,
      coilNumbers: r.gradeAckCoilNumbers ?? [],
      expectedGrade: r.gradeAckExpectedGrade ?? '',
      foundGrades: r.gradeAckFoundGrades ?? [],
    }
  }
  if (r.deletedAt) out.deletedAt = r.deletedAt
  return out
}
