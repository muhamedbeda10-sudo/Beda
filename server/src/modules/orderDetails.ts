// ============================================================================
// §7.7.1 — the ERP details of an order line, as production_orders stores them
// (migration 0049). The fields are declared once, in the shared order sheet
// (ORDER_DETAIL_FIELDS); here each is given its column, and from that one
// table come the import's validation, its upsert, the API's select and the
// Access list's columns. A field without a column fails to compile.
//
// Every identifier written into SQL below comes from these constants, never
// from a request: values always travel as bound parameters.
// ============================================================================

import { z } from 'zod'
import {
  ORDER_DETAIL_FIELDS,
  parseDay,
  type OrderDetailField,
  type OrderDetailKey,
  type OrderLineErpDetails,
} from '@qc/shared/orderImport'
import type { SqlColumns } from '../lib/columnFilters'

/** Each ERP detail's column in production_orders. */
const ORDER_DETAIL_COLUMNS: { readonly [K in OrderDetailKey]: string } = {
  dueDate: 'due_date',
  refinedDate: 'refined_date',
  planningWeek: 'planning_week',
  erpRemainingQty: 'erp_remaining_qty',
  cancelledQty: 'cancelled_qty',
  acceptedQty: 'accepted_qty',
  stockQty: 'stock_qty',
  lengthMm: 'length_mm',
  widthMm: 'width_mm',
  thicknessMm: 'thickness_mm',
  weightKg: 'weight_kg',
  stage: 'stage',
  qcCategory: 'qc_category',
  versionParentId: 'version_parent_id',
  parentId: 'parent_id',
  partDurationHours: 'part_duration_hours',
  modelGroupId: 'model_group_id',
  totalAreaM2: 'total_area_m2',
  totalPowderKg: 'total_powder_kg',
  erpOrderType: 'erp_order_type',
  rawMaterialQty: 'raw_material_qty',
  coilSerialNumber: 'coil_serial_number',
  rawMaterialPowder: 'raw_material_powder',
  itemFamily: 'item_family',
  itemTranslation: 'item_translation',
  totalActualSampleQty: 'total_actual_sample_qty',
  totalHoldQty: 'total_hold_qty',
  totalStdSampleQty: 'total_std_sample_qty',
  totalRemQcRecordQty: 'total_rem_qc_record_qty',
  plannedStart: 'planned_start',
  plannedFinish: 'planned_finish',
  shippingStatus: 'shipping_status',
  shippingStartDate: 'shipping_start_date',
  shippingEndDate: 'shipping_end_date',
  bomId: 'bom_id',
  rmReceivedQty: 'rm_received_qty',
  rmReceivingDate: 'rm_receiving_date',
  delayReasonCode: 'delay_reason_code',
  delayPeriod: 'delay_period',
  delayComment: 'delay_comment',
  statusReason: 'status_reason',
  rmPromiseDate: 'rm_promise_date',
}

/** The longest text an ERP detail may hold; the ERP's longest is well under it. */
const DETAIL_TEXT_MAX = 1000

interface DetailColumn {
  key: OrderDetailKey
  column: string
  kind: OrderDetailField['kind']
  /** The column's type, as jsonb_to_record reads it. */
  sqlType: 'text' | 'numeric' | 'integer' | 'date'
}

const DETAIL_COLUMNS: readonly DetailColumn[] = ORDER_DETAIL_FIELDS.map((f) => ({
  key: f.key,
  column: ORDER_DETAIL_COLUMNS[f.key],
  kind: f.kind,
  sqlType: f.kind === 'day' ? 'date' : f.kind === 'number' ? ('integer' in f && f.integer ? 'integer' : 'numeric') : 'text',
}))

/** One detail's validation. Absent = not carried (left alone); null or an empty text = cleared. */
function detailSchema(f: OrderDetailField): z.ZodType<string | number | null | undefined, z.ZodTypeDef, unknown> {
  if (f.kind === 'number') {
    const n = 'integer' in f && f.integer ? z.number().int(`${f.label} must be a whole number`) : z.number()
    return n.finite().nullable().optional()
  }
  if (f.kind === 'day') {
    return z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === null || v === '') return v === '' ? null : v
        const day = parseDay(v)
        if (day) return day
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.label} is not a day ("${v}")` })
        return z.NEVER
      })
  }
  return z
    .string()
    .trim()
    .max(DETAIL_TEXT_MAX)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v))
}

/** The ERP details as an import row's fields, each optional and nullable. */
export const orderDetailShape = Object.fromEntries(ORDER_DETAIL_FIELDS.map((f) => [f.key, detailSchema(f)])) as {
  [K in OrderDetailKey]: z.ZodType<OrderLineErpDetails[K] | undefined, z.ZodTypeDef, unknown>
}

/**
 * A row's details as the upsert's JSON: a key for every detail the row
 * carries (null included, which clears it), none for a detail it does not.
 */
export function detailPayload(row: Partial<Record<OrderDetailKey, string | number | null | undefined>>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {}
  for (const c of DETAIL_COLUMNS) {
    const v = row[c.key]
    if (v !== undefined) out[c.column] = v
  }
  return out
}

/** The details' part of jsonb_to_record's column list. */
export const DETAIL_RECORD_COLUMNS = DETAIL_COLUMNS.map((c) => `${c.column} ${c.sqlType}`).join(', ')

/**
 * The details' SET list of the upsert's UPDATE: a detail the row carries is
 * written (null clears it), one it does not carry keeps its stored value.
 * `e.j` is the row's JSON object, `i` its record, `p` the stored line.
 */
export const DETAIL_UPDATE_SET = DETAIL_COLUMNS.map((c) => `${c.column} = CASE WHEN e.j ? '${c.column}' THEN i.${c.column} ELSE p.${c.column} END`).join(',\n        ')

/** The details' columns, and their values from the record `i`, for the upsert's INSERT. */
export const DETAIL_INSERT_COLUMNS = DETAIL_COLUMNS.map((c) => c.column).join(', ')
export const DETAIL_INSERT_VALUES = DETAIL_COLUMNS.map((c) => `i.${c.column}`).join(', ')

/** The details as the API returns them, from the table aliased `alias`: a day as YYYY-MM-DD text, never shifted into a time zone. */
export function detailSelect(alias: string): string {
  return DETAIL_COLUMNS.map((c) =>
    c.kind === 'day' ? `to_char(${alias}.${c.column}, 'YYYY-MM-DD') AS "${c.key}"` : `${alias}.${c.column} AS "${c.key}"`,
  ).join(', ')
}

/**
 * The details as Access columns, filtered and sorted in SQL over the table
 * aliased `o`. The planning week ("01/2026") sorts by year, then week.
 */
export function detailListColumns(): SqlColumns {
  const out: SqlColumns = {}
  for (const c of DETAIL_COLUMNS) {
    const col = `o.${c.column}`
    if (c.kind === 'number') out[c.key] = { text: `COALESCE(trim_scale(${col})::text, '')`, sort: col }
    else if (c.kind === 'day') out[c.key] = { text: `COALESCE(to_char(${col}, 'YYYY-MM-DD'), '')`, sort: col }
    else if (c.key === 'planningWeek')
      out[c.key] = {
        text: `COALESCE(btrim(${col}), '')`,
        sort: `(substring(${col} FROM '([0-9]{4})\\s*$')::int * 100 + substring(${col} FROM '^\\s*([0-9]{1,2})\\s*/')::int)`,
      }
    else out[c.key] = { text: `COALESCE(btrim(${col}), '')` }
  }
  return out
}
