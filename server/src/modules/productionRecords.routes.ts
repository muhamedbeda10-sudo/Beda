// ============================================================================
// §24 — the ERP's production task record: the production written against the
// order sheet. The order sheet (production_orders) is the master, one row per
// order line with its Order ID (line_key); this record is its child, one row
// per order line per WORKING DAY, named by that same Order ID and the ERP's
// record id together (the record id alone repeats across lines). An
// administrator imports the ERP's export in batches, idempotently: a row seen
// before is written over, one retired comes back, none is ever deleted by an
// import. Nothing else in the app writes a row; the assistant reads it
// through ai.production_task_records (the 'production' domain).
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  EXISTING_KEYS_MAX,
  type ClearProductionRecordsResult,
  type ExistingKeysResponse,
  type ImportResult,
  type ProductionRecordsSummary,
} from '@qc/shared/api'
import { actualHoursOrNull, parseDayNo, parseWeek, parseWorkDay } from '@qc/shared/productionImport'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { normaliseKey } from '../lib/rows'

const text = (max: number) => z.string().trim().max(max).optional()
/** A quantity, a size, a weight or hours as the ERP writes them: finite, not negative, within what the column holds; or absent. */
const amount = (max: number) => z.coerce.number().finite().min(0).max(max).optional()
const QTY_MAX = 99_999_999_999 // numeric(14, 3)
const HOURS_MAX = 9_999_999 // numeric(10, 3)
const SIZE_MAX = 999_999_999 // numeric(12, 3)
const THICKNESS_MAX = 99_999 // numeric(8, 3)

/** One row as the importer sends it (shared PRODUCTION_RECORD_FIELDS); the day and the day number are read below. */
export const importRow = z.object({
  lineKey: z.string().trim().min(1).max(120),
  erpRecordId: z.string().trim().min(1).max(120),
  week: text(20),
  orderNumber: text(120),
  item: text(300),
  colour: text(60),
  producedQty: amount(QTY_MAX),
  worker1: text(200),
  worker2: text(200),
  worker3: text(200),
  worker4: text(200),
  dayNo: z.union([z.string().trim().max(20), z.number()]).optional(),
  workDay: text(40),
  workCenterCode: text(40),
  durationHours: amount(HOURS_MAX),
  stageNo: z.coerce.number().int().min(0).max(32767).optional(),
  stageQty: amount(QTY_MAX),
  remarks: text(2000),
  lengthMm: amount(SIZE_MAX),
  widthMm: amount(SIZE_MAX),
  thicknessMm: amount(THICKNESS_MAX),
  requiredQty: amount(QTY_MAX),
  actualHours: amount(HOURS_MAX),
  plannedHours: amount(HOURS_MAX),
  shift: text(120),
  resource: text(200),
  weightKg: amount(QTY_MAX),
  producedWeightKg: amount(QTY_MAX),
  producedLengthM: amount(QTY_MAX),
})

export type ProductionRecordRow = z.infer<typeof importRow>

const importSchema = z.object({ rows: z.array(importRow).min(1).max(1000) })
const existingKeysSchema = z.object({ keys: z.array(z.string().trim().min(1)).max(EXISTING_KEYS_MAX) })

/** The table's columns, as the upsert writes them from one row. */
interface RecordValues {
  line_key: string
  erp_record_id: string
  week: string
  week_no: number | null
  week_year: number | null
  order_number: string
  item: string
  colour: string
  produced_qty: number | null
  required_qty: number | null
  worker_1: string
  worker_2: string
  worker_3: string
  worker_4: string
  day_no: number | null
  work_day: string | null
  work_center_code: string
  duration_hours: number | null
  planned_hours: number | null
  actual_hours: number | null
  stage_no: number | null
  stage_qty: number | null
  remarks: string
  length_mm: number | null
  width_mm: number | null
  thickness_mm: number | null
  shift: string
  resource: string
  weight_kg: number | null
  produced_weight_kg: number | null
  produced_length_m: number | null
}

/** The composite business key as the importer and `existing-keys` spell it: normalised parts joined by '||'. */
const recordKey = (lineKey: string, erpRecordId: string): string => `${normaliseKey(lineKey)}||${normaliseKey(erpRecordId)}`

/**
 * A row read: the day as a day (ISO or day-first, never shifted by a time
 * zone), "Day3" as 3, the week's two numbers when "01/2026" parses (the text
 * is kept as given either way), the ERP's placeholder for an unrecorded time
 * as null. A day or a day number that cannot be read refuses the request,
 * naming the row.
 */
function toRecord(row: ProductionRecordRow): RecordValues {
  const who = `Order ID "${row.lineKey}", record ${row.erpRecordId}`
  let workDay: string | null = null
  if (row.workDay) {
    workDay = parseWorkDay(row.workDay)
    if (workDay === null) throw badRequest(`${who}: "${row.workDay}" is not a day (write it as 2026-01-05 or 05/01/2026).`)
  }
  let dayNo: number | null = null
  if (row.dayNo !== undefined && row.dayNo !== '') {
    dayNo = parseDayNo(row.dayNo)
    if (dayNo === null) throw badRequest(`${who}: "${row.dayNo}" is not a day number (Day1, Day2…).`)
  }
  const week = parseWeek(row.week)
  return {
    line_key: row.lineKey,
    erp_record_id: row.erpRecordId,
    week: row.week ?? '',
    week_no: week?.week ?? null,
    week_year: week?.year ?? null,
    order_number: row.orderNumber ?? '',
    item: row.item ?? '',
    colour: row.colour ?? '',
    produced_qty: row.producedQty ?? null,
    required_qty: row.requiredQty ?? null,
    worker_1: row.worker1 ?? '',
    worker_2: row.worker2 ?? '',
    worker_3: row.worker3 ?? '',
    worker_4: row.worker4 ?? '',
    day_no: dayNo,
    work_day: workDay,
    work_center_code: row.workCenterCode ?? '',
    duration_hours: row.durationHours ?? null,
    planned_hours: row.plannedHours ?? null,
    actual_hours: actualHoursOrNull(row.actualHours),
    stage_no: row.stageNo ?? null,
    stage_qty: row.stageQty ?? null,
    remarks: row.remarks ?? '',
    length_mm: row.lengthMm ?? null,
    width_mm: row.widthMm ?? null,
    thickness_mm: row.thicknessMm ?? null,
    shift: row.shift ?? '',
    resource: row.resource ?? '',
    weight_kg: row.weightKg ?? null,
    produced_weight_kg: row.producedWeightKg ?? null,
    produced_length_m: row.producedLengthM ?? null,
  }
}

const COLUMNS = [
  'line_key', 'erp_record_id', 'week', 'week_no', 'week_year', 'order_number', 'item', 'colour', 'produced_qty', 'required_qty',
  'worker_1', 'worker_2', 'worker_3', 'worker_4', 'day_no', 'work_day', 'work_center_code', 'duration_hours', 'planned_hours',
  'actual_hours', 'stage_no', 'stage_qty', 'remarks', 'length_mm', 'width_mm', 'thickness_mm', 'shift', 'resource', 'weight_kg',
  'produced_weight_kg', 'produced_length_m',
] as const

const RECORDSET = `jsonb_to_recordset($1::jsonb) AS i(
  line_key text, erp_record_id text, week text, week_no smallint, week_year smallint, order_number text, item text, colour text,
  produced_qty numeric, required_qty numeric, worker_1 text, worker_2 text, worker_3 text, worker_4 text, day_no smallint,
  work_day date, work_center_code text, duration_hours numeric, planned_hours numeric, actual_hours numeric, stage_no smallint,
  stage_qty numeric, remarks text, length_mm numeric, width_mm numeric, thickness_mm numeric, shift text, resource text,
  weight_kg numeric, produced_weight_kg numeric, produced_length_m numeric)`

/**
 * §24 — idempotent bulk upsert on (line_key, erp_record_id), matched without
 * regard to case like the order sheet's key. Every column is written from the
 * row (the export carries the whole record each time), imported_at is set,
 * and a retired row comes back. Inserted and updated are counted as in
 * upsertOrderLines: the last occurrence of a key in a batch wins, so a file
 * that repeats a record is applied in its own order rather than colliding
 * inside one statement.
 */
export async function upsertProductionRecords(tx: Queryable, rows: ProductionRecordRow[]): Promise<ImportResult> {
  const byKey = new Map<string, RecordValues>()
  for (const row of rows) byKey.set(recordKey(row.lineKey, row.erpRecordId), toRecord(row))
  const unique = Array.from(byKey.values())

  // Which of them are there already, through the business key's index: the update count.
  const existing = await tx.query(
    `SELECT 1 FROM production_task_records r
       JOIN unnest($1::text[], $2::text[]) AS k(line_key, erp_record_id)
         ON lower(r.line_key) = k.line_key AND lower(r.erp_record_id) = k.erp_record_id`,
    [unique.map((r) => normaliseKey(r.line_key)), unique.map((r) => normaliseKey(r.erp_record_id))],
  )
  const updated = existing.rowCount ?? 0

  const assignments = COLUMNS.filter((c) => c !== 'line_key' && c !== 'erp_record_id').map((c) => `${c} = EXCLUDED.${c}`)
  await tx.query(
    `INSERT INTO production_task_records (${COLUMNS.join(', ')})
     SELECT ${COLUMNS.map((c) => `i.${c}`).join(', ')} FROM ${RECORDSET}
     ON CONFLICT (lower(line_key), lower(erp_record_id)) DO UPDATE SET
        ${assignments.join(', ')},
        imported_at = now(), deleted_at = NULL, deleted_by_id = NULL`,
    [JSON.stringify(unique)],
  )
  return { inserted: unique.length - updated, updated }
}

export function productionRecordsRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireCapability('manage-admin-data'))

  /** What the import page shows above the importer: how much there is, how far it reaches, how fresh it is. */
  r.get('/summary', async (_req, res) => {
    const { rows } = await ctx.db.query<ProductionRecordsSummary>(
      `SELECT count(*)::int                                                      AS "rows",
              count(DISTINCT lower(r.line_key))::int                              AS lines,
              count(DISTINCT lower(r.line_key)) FILTER (WHERE o.id IS NOT NULL)::int AS "linesKnown",
              min(r.work_day)::text                                               AS "firstDay",
              max(r.work_day)::text                                               AS "lastDay",
              max(r.imported_at)                                                  AS "lastImportAt"
         FROM production_task_records r
         LEFT JOIN production_orders o ON lower(o.line_key) = lower(r.line_key) AND o.deleted_at IS NULL
        WHERE r.deleted_at IS NULL`,
    )
    res.json(rows[0])
  })

  /**
   * Which records already exist — the importer's new-vs-update preview. A
   * key is the business key's parts joined by '||' (lineKey||erpRecordId),
   * answered normalised, as CsvImporter builds and compares it.
   */
  r.post('/existing-keys', async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
      .map((k) => k.split('||'))
      .filter((parts) => parts.length === 2)
    const { rows } = await ctx.db.query<{ key: string }>(
      `SELECT lower(r.line_key) || '||' || lower(r.erp_record_id) AS key
         FROM production_task_records r
         JOIN unnest($1::text[], $2::text[]) AS k(line_key, erp_record_id)
           ON lower(r.line_key) = k.line_key AND lower(r.erp_record_id) = k.erp_record_id`,
      [wanted.map((p) => p[0]), wanted.map((p) => p[1])],
    )
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /** One batch of the export; every row is stored whole. One audit entry per request. */
  r.post('/import', async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(importSchema, req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      const { inserted, updated } = await upsertProductionRecords(tx, rows)
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'update',
          entity: 'ProductionTaskRecord',
          entityId: 'bulk-import',
          field: 'import',
          newValue: `${inserted} inserted, ${updated} updated`,
        },
      ])
      const body: ImportResult = { inserted, updated }
      return body
    })
    res.json(result)
  })

  /**
   * Remove every current record, for a wrong import: rows are marked
   * deleted, never erased (§10), and the next import of the file brings
   * back the ones it still carries. Audited with the count.
   */
  r.delete('/', async (req, res) => {
    const user = requireUser(req)
    const result = await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE production_task_records SET deleted_at = now(), deleted_by_id = $1 WHERE deleted_at IS NULL`,
        [user.id],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'delete',
          entity: 'ProductionTaskRecord',
          entityId: 'bulk-clear',
          field: 'clear',
          newValue: `${rowCount ?? 0} production records marked deleted before a fresh import`,
        },
      ])
      const body: ClearProductionRecordsResult = { removed: rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  return r
}
