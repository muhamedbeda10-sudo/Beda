// ============================================================================
// Production orders — the catalogue an inspection is recorded against.
// Tens of thousands of rows: every read here is a prefix search, a lookup by
// id, or a bounded page. Never the whole table.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import { EXISTING_KEYS_MAX, type ExistingKeysResponse, type ImportResult, type OrderHistory, type SampleSummary } from '@qc/shared/api'
import type { InspectionSession, ProductionOrder } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { dropNulls, normaliseKey } from '../lib/rows'
import { SAMPLE_SUMMARY_SELECT, SESSION_SELECT } from './sessions.sql'

export const ORDER_SELECT = `
  id, order_number AS "orderNumber", item, item_code AS "itemCode", work_center_code AS "workCenterCode",
  machine_id AS "machineId", required_qty AS "requiredQty", finished_qty AS "finishedQty",
  drawing, drawing_alt AS "drawingAlt", issue, material, expected_grade AS "expectedGrade",
  customer, type, colour, order_date AS "date", deleted_at AS "deletedAt"`

const importRow = z.object({
  orderNumber: z.string().trim().min(1).max(120),
  item: z.string().trim().max(300).optional(),
  itemCode: z.string().trim().max(120).optional(),
  workCenterCode: z.string().trim().max(20).optional(),
  requiredQty: z.coerce.number().min(0).optional(),
  finishedQty: z.coerce.number().min(0).optional(),
  drawing: z.string().trim().max(200).optional(),
  drawingAlt: z.string().trim().max(200).optional(),
  issue: z.string().trim().max(100).optional(),
  material: z.string().trim().max(120).optional(),
  expectedGrade: z.string().trim().max(60).optional(),
  customer: z.string().trim().max(200).optional(),
  type: z.string().trim().max(60).optional(),
  colour: z.string().trim().max(60).optional(),
  date: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((d) => d === undefined || !Number.isNaN(d.getTime()), 'date is not a valid date'),
})

const importSchema = z.object({ rows: z.array(importRow).min(1).max(1000) })
const existingKeysSchema = z.object({ keys: z.array(z.string().trim().min(1)).max(EXISTING_KEYS_MAX) })

export async function fetchOrdersByIds(q: Queryable, ids: string[]): Promise<ProductionOrder[]> {
  if (ids.length === 0) return []
  const { rows } = await q.query<ProductionOrder>(`SELECT ${ORDER_SELECT} FROM production_orders WHERE id = ANY($1::uuid[])`, [ids])
  return rows.map(dropNulls)
}

export function ordersRoutes(ctx: AppContext): Router {
  const r = Router()

  /** Prefix search on order number and item code, capped. */
  r.get('/', async (req, res) => {
    const q = parse(
      z.object({ search: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(100).default(40) }),
      req.query,
    )
    const prefix = `${q.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const { rows } = await ctx.db.query<ProductionOrder>(
      `SELECT ${ORDER_SELECT} FROM production_orders
        WHERE deleted_at IS NULL
          AND (lower(order_number) LIKE $1 OR ($2 <> '' AND lower(item_code) LIKE $1))
        ORDER BY order_number
        LIMIT $3`,
      [prefix, q.search, q.limit],
    )
    res.json(rows.map(dropNulls))
  })

  r.get('/by-ids', async (req, res) => {
    const ids = parse(z.string().default(''), req.query.ids).split(',').filter(Boolean)
    parse(z.array(z.string().uuid()).max(200), ids)
    res.json(await fetchOrdersByIds(ctx.db, ids))
  })

  r.get('/:id', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const [order] = await fetchOrdersByIds(ctx.db, [id])
    if (!order) throw notFound('That order')
    res.json(order)
  })

  /** Sessions and samples already recorded against one order (§4). */
  r.get('/:id/history', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const [sessions, samples] = await Promise.all([
      ctx.db.query<InspectionSession>(
        `SELECT ${SESSION_SELECT} FROM inspection_sessions s WHERE s.order_id = $1 AND s.deleted_at IS NULL ORDER BY s.seq`,
        [id],
      ),
      ctx.db.query<SampleSummary>(
        `SELECT ${SAMPLE_SUMMARY_SELECT} FROM inspection_samples sm WHERE sm.order_id = $1 AND sm.deleted_at IS NULL ORDER BY sm.created_at DESC LIMIT 200`,
        [id],
      ),
    ])
    const body: OrderHistory = { sessions: sessions.rows.map(dropNulls), samples: samples.rows }
    res.json(body)
  })

  /** Which order numbers already exist — the importer's new-vs-update preview. */
  r.post('/existing-keys', requireCapability('manage-admin-data'), async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(
      `SELECT lower(order_number) AS key FROM production_orders WHERE lower(order_number) = ANY($1::text[])`,
      [wanted],
    )
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /**
   * §7.7 — idempotent bulk upsert on the order number (matched without regard
   * to case; the stored spelling is kept). A field the file does not carry
   * leaves the stored value alone; an order that had been marked deleted comes
   * back, because the ERP says it is current.
   */
  r.post('/import', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(importSchema, req.body)
    // Last occurrence of a key wins, so a file that repeats an order number is
    // applied in its own order rather than colliding inside one statement.
    const byKey = new Map<string, z.infer<typeof importRow>>()
    for (const row of rows) byKey.set(normaliseKey(row.orderNumber), row)
    const unique = Array.from(byKey.values())

    const result = await withTransaction(ctx.db, async (tx) => {
      const payload = JSON.stringify(
        unique.map((o) => ({
          order_number: o.orderNumber,
          item: o.item ?? null,
          item_code: o.itemCode ?? null,
          work_center_code: o.workCenterCode ?? null,
          required_qty: o.requiredQty ?? null,
          finished_qty: o.finishedQty ?? null,
          drawing: o.drawing ?? null,
          drawing_alt: o.drawingAlt ?? null,
          issue: o.issue ?? null,
          material: o.material ?? null,
          expected_grade: o.expectedGrade ?? null,
          customer: o.customer ?? null,
          type: o.type ?? null,
          colour: o.colour ?? null,
          order_date: o.date ? o.date.toISOString() : null,
        })),
      )
      const recordset = `jsonb_to_recordset($1::jsonb) AS i(
        order_number text, item text, item_code text, work_center_code text, required_qty numeric,
        finished_qty numeric, drawing text, drawing_alt text, issue text, material text,
        expected_grade text, customer text, type text, colour text, order_date timestamptz)`

      const updated = await tx.query<{ id: string }>(
        `UPDATE production_orders p SET
            item = COALESCE(i.item, p.item),
            item_code = COALESCE(i.item_code, p.item_code),
            work_center_code = COALESCE(i.work_center_code, p.work_center_code),
            required_qty = COALESCE(i.required_qty, p.required_qty),
            finished_qty = COALESCE(i.finished_qty, p.finished_qty),
            drawing = COALESCE(i.drawing, p.drawing),
            drawing_alt = COALESCE(i.drawing_alt, p.drawing_alt),
            issue = COALESCE(i.issue, p.issue),
            material = COALESCE(i.material, p.material),
            expected_grade = COALESCE(i.expected_grade, p.expected_grade),
            customer = COALESCE(i.customer, p.customer),
            type = COALESCE(i.type, p.type),
            colour = COALESCE(i.colour, p.colour),
            order_date = COALESCE(i.order_date, p.order_date),
            deleted_at = NULL, deleted_by_id = NULL
          FROM ${recordset}
         WHERE lower(p.order_number) = lower(i.order_number)
         RETURNING p.id`,
        [payload],
      )
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO production_orders
            (order_number, item, item_code, work_center_code, required_qty, finished_qty, drawing, drawing_alt,
             issue, material, expected_grade, customer, type, colour, order_date)
         SELECT i.order_number, COALESCE(i.item, ''), COALESCE(i.item_code, ''), COALESCE(i.work_center_code, ''),
                COALESCE(i.required_qty, 0), COALESCE(i.finished_qty, 0), COALESCE(i.drawing, ''), i.drawing_alt,
                i.issue, COALESCE(i.material, ''), COALESCE(i.expected_grade, ''), COALESCE(i.customer, ''),
                COALESCE(i.type, ''), COALESCE(i.colour, ''), COALESCE(i.order_date, now())
           FROM ${recordset}
          WHERE NOT EXISTS (SELECT 1 FROM production_orders p WHERE lower(p.order_number) = lower(i.order_number))
         RETURNING id`,
        [payload],
      )
      const at = new Date().toISOString()
      await writeAudit(tx, [
        {
          at,
          userId: user.id,
          userName: user.name,
          action: 'update',
          entity: 'ProductionOrder',
          entityId: 'bulk-import',
          field: 'import',
          newValue: `${inserted.rowCount ?? 0} inserted, ${updated.rowCount ?? 0} updated`,
        },
      ])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updated.rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  return r
}
