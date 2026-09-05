// ============================================================================
// SELECT fragments and row mappers shared by the session, sample and order
// modules. Rows come back flat; the mappers fold the flat columns into the
// nested domain shapes (startQtyConfirmed, gradeAcknowledgement, order).
// ============================================================================

import type { OrderSummary, SampleSummary, SessionWithOrder } from '@qc/shared/api'
import type { InspectionSample, InspectionSession } from '@qc/shared/types'

/** Requires the alias `s` for inspection_sessions. */
export const SESSION_SELECT = `
  s.id, s.seq, s.order_id AS "orderId", s.work_center_code AS "workCenterCode",
  s.inspector_id AS "inspectorId", s.inspector_name AS "inspectorName", s.started_at AS "startedAt", s.status,
  s.start_qty AS "startQty", s.start_qty_by_id AS "startQtyById", s.start_qty_by_name AS "startQtyByName",
  s.start_qty_at AS "startQtyAt", s.final_qty AS "finalQty", s.closed_at AS "closedAt",
  s.closed_by_id AS "closedById", s.version, s.deleted_at AS "deletedAt",
  (SELECT count(*)::int FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS "sampleCount"`

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
  closedAt: string | null
  closedById: string | null
  version: number
  deletedAt: string | null
  sampleCount: number
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
  }
  if (r.startQty !== null && r.startQtyById && r.startQtyByName && r.startQtyAt) {
    out.startQtyConfirmed = { qty: r.startQty, byId: r.startQtyById, byName: r.startQtyByName, at: r.startQtyAt }
  }
  if (r.finalQty !== null) out.finalQty = r.finalQty
  if (r.closedAt) out.closedAt = r.closedAt
  if (r.closedById) out.closedById = r.closedById
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
