// ============================================================================
// Production order LINES — the catalogue an inspection is recorded against.
// One row per (order, item, machine), keyed by the ERP's Order ID (line_key);
// the order number repeats across the lines of one order.
//
// Tens of thousands of rows: every read here is a prefix search, a lookup by
// id, or a bounded page. Never the whole table.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  EXISTING_KEYS_MAX,
  type ClearOrdersResult,
  type ExistingKeysResponse,
  type ImportCompareResponse,
  type ImportResult,
  type OrderHistory,
  type OrderListOptionsResponse,
  type OrderListResponse,
  type OrderListRow,
  type OrderNumberSummary,
  type OrderItemOption,
  type SampleSummary,
  type SessionNotesResponse,
} from '@qc/shared/api'
import type { InspectionSession, ProductionOrder } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { columnFilterClauses, columnOrderBy, columnQuerySchema, columnValues, type SqlColumns } from '../lib/columnFilters'
import { requireCapability, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { dropNulls, normaliseKey } from '../lib/rows'
import { SAMPLE_SUMMARY_SELECT, SESSION_SELECT } from './sessions.sql'
import { NORMALISED_CODE } from './sessions.routes'
import { loadOrderNotes } from './notes'
import { itemFilterSql } from '../lib/itemMatch'
import { cancelledSql } from '../lib/orderStatus'
import {
  DETAIL_INSERT_COLUMNS,
  DETAIL_INSERT_VALUES,
  DETAIL_RECORD_COLUMNS,
  DETAIL_NEW_VALUES,
  DETAIL_UPDATE_SET,
  detailListColumns,
  detailPayload,
  detailSelect,
  orderDetailShape,
} from './orderDetails'

export const ORDER_SELECT = `
  id, line_key AS "lineKey", order_number AS "orderNumber", item, item_code AS "itemCode", work_center_code AS "workCenterCode",
  machine_id AS "machineId", required_qty AS "requiredQty", finished_qty AS "finishedQty",
  drawing, drawing_alt AS "drawingAlt", issue, material, expected_grade AS "expectedGrade",
  customer, type, colour, erp_status AS "erpStatus", order_date AS "date", deleted_at AS "deletedAt"`

/** The same columns qualified with the table alias `o`, for a query that joins. */
const ORDER_SELECT_O = ORDER_SELECT.replace(/(^|,)(\s*)(?=[a-z_]+)/g, '$1$2o.')

/**
 * One order line as an import sends it: the core fields, where absent means
 * "leave it", then the ERP details (§7.7.1), where null clears one.
 */
export const importRow = z.object({
  lineKey: z.string().trim().min(1).max(120),
  orderNumber: z.string().trim().min(1).max(120).optional(),
  item: z.string().trim().max(300).optional(),
  itemCode: z.string().trim().max(120).optional(),
  workCenterCode: z.string().trim().max(40).optional(),
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
  erpStatus: z.string().trim().max(40).optional(),
  date: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((d) => d === undefined || !Number.isNaN(d.getTime()), 'date is not a valid date'),
  ...orderDetailShape,
})

export type OrderImportRow = z.infer<typeof importRow>

const importSchema = z.object({ rows: z.array(importRow).min(1).max(1000) })
const existingKeysSchema = z.object({ keys: z.array(z.string().trim().min(1)).max(EXISTING_KEYS_MAX) })

/** The ERP marks a withdrawn line "Cancel" (or "Cancelled", "ملغي"…); such a line is history, not work. */
const NOT_CANCELLED = `NOT ${cancelledSql('erp_status')}`

/** A LIKE pattern matching values that start with `term`, wildcards escaped. */
function likePrefix(term: string): string {
  return `${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export async function fetchOrdersByIds(q: Queryable, ids: string[]): Promise<ProductionOrder[]> {
  if (ids.length === 0) return []
  const { rows } = await q.query<ProductionOrder>(`SELECT ${ORDER_SELECT} FROM production_orders WHERE id = ANY($1::uuid[])`, [ids])
  return rows.map(dropNulls)
}

/**
 * Each stored column of a line and its value after a row is applied: a core field the row does not carry keeps the
 * stored value (`i` is the row's record, `p` the stored line, `e.j` the row's JSON object).
 */
const CORE_NEW_VALUES: readonly (readonly [column: string, value: string])[] = [
  'order_number', 'item', 'item_code', 'work_center_code', 'required_qty', 'finished_qty', 'drawing', 'drawing_alt', 'issue',
  'material', 'expected_grade', 'customer', 'type', 'colour', 'erp_status', 'order_date',
].map((c) => [c, `COALESCE(i.${c}, p.${c})`] as const)
const NEW_VALUES = [...CORE_NEW_VALUES, ...DETAIL_NEW_VALUES]

/**
 * What a row would change of its stored line, as SQL over `p`, `i` and `e.j`: a value that differs, a line marked
 * deleted (the ERP says it is current), or — for a sync run ($2) — a line this run has not stamped yet.
 */
const LINE_CHANGES = `((${NEW_VALUES.map(([c]) => `p.${c}`).join(', ')}) IS DISTINCT FROM (${NEW_VALUES.map(([, v]) => v).join(', ')})
       OR p.deleted_at IS NOT NULL
       OR ($2::uuid IS NOT NULL AND p.last_sync_run_id IS DISTINCT FROM $2::uuid))`

/** The rows of a batch as the upsert's JSON: one per line key, the last occurrence winning (a file applied in its own order). */
function linePayload(rows: OrderImportRow[]): { unique: z.infer<typeof importRow>[]; payload: string } {
  const byKey = new Map<string, z.infer<typeof importRow>>()
  for (const row of rows) byKey.set(normaliseKey(row.lineKey), row)
  const unique = Array.from(byKey.values())
  const payload = JSON.stringify(
    unique.map((o) => ({
      line_key: o.lineKey,
      order_number: o.orderNumber ?? null,
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
      erp_status: o.erpStatus ?? null,
      order_date: o.date ? o.date.toISOString() : null,
      ...detailPayload(o),
    })),
  )
  return { unique, payload }
}

// Each row's JSON object (`j`, so the details can tell "carried as null" from "not carried") and its record (`i`).
const RECORDSET = `jsonb_array_elements($1::jsonb) AS e(j), jsonb_to_record(e.j) AS i(
    line_key text, order_number text, item text, item_code text, work_center_code text, required_qty numeric,
    finished_qty numeric, drawing text, drawing_alt text, issue text, material text,
    expected_grade text, customer text, type text, colour text, erp_status text, order_date timestamptz,
    ${DETAIL_RECORD_COLUMNS})`

/**
 * §7.7 — what importing these rows would do, line by line, without writing: the keys (lower case) of the lines it
 * would add and of those it would change; every other key would be left as it is. What the importer's preview shows,
 * and what lets it send only the rows that change something.
 */
export async function compareOrderLines(q: Queryable, rows: OrderImportRow[]): Promise<ImportCompareResponse> {
  const { payload } = linePayload(rows)
  const { rows: found } = await q.query<{ key: string; change: 'new' | 'changed' | 'same' }>(
    `SELECT lower(i.line_key) AS key,
            CASE WHEN p.id IS NULL THEN 'new' WHEN ${LINE_CHANGES} THEN 'changed' ELSE 'same' END AS change
       FROM ${RECORDSET}
       LEFT JOIN production_orders p ON lower(p.line_key) = lower(i.line_key)`,
    [payload, null],
  )
  return { new: found.filter((r) => r.change === 'new').map((r) => r.key), changed: found.filter((r) => r.change === 'changed').map((r) => r.key) }
}

/**
 * §7.7 — idempotent bulk upsert on the line key, the ERP's Order ID (matched
 * without regard to case; the stored spelling is kept). A field the rows do
 * not carry leaves the stored value alone; a line that had been marked
 * deleted comes back, because the ERP says it is current. A line seen for the
 * first time must name its order number. A sync run stamps the lines it saw.
 * The ERP details (§7.7.1) differ in one way: a detail the row carries as
 * null is cleared, as the ERP no longer has it. A line the row would not
 * change is not written at all (its last change stays when it was), and is
 * counted as unchanged.
 */
export async function upsertOrderLines(tx: Queryable, rows: OrderImportRow[], syncRunId: string | null = null): Promise<ImportResult> {
  const { unique, payload } = linePayload(rows)

  const known = new Set(
    (
      await tx.query<{ key: string }>(`SELECT lower(line_key) AS key FROM production_orders WHERE lower(line_key) = ANY($1::text[])`, [
        unique.map((o) => normaliseKey(o.lineKey)),
      ])
    ).rows.map((x) => x.key),
  )
  const orphan = unique.find((o) => !known.has(normaliseKey(o.lineKey)) && !o.orderNumber)
  if (orphan) throw badRequest(`Order ID "${orphan.lineKey}" is new, so its row must carry the order number.`)

  const updated = await tx.query<{ id: string }>(
    `UPDATE production_orders p SET
        ${CORE_NEW_VALUES.map(([c, v]) => `${c} = ${v}`).join(',\n        ')},
        ${DETAIL_UPDATE_SET},
        deleted_at = NULL, deleted_by_id = NULL,
        last_sync_run_id = COALESCE($2::uuid, p.last_sync_run_id)
      FROM ${RECORDSET}
     WHERE lower(p.line_key) = lower(i.line_key) AND ${LINE_CHANGES}
     RETURNING p.id`,
    [payload, syncRunId],
  )
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO production_orders
        (line_key, order_number, item, item_code, work_center_code, required_qty, finished_qty, drawing, drawing_alt,
         issue, material, expected_grade, customer, type, colour, erp_status, order_date, last_sync_run_id,
         ${DETAIL_INSERT_COLUMNS})
     SELECT i.line_key, i.order_number, COALESCE(i.item, ''), COALESCE(i.item_code, ''), COALESCE(i.work_center_code, ''),
            COALESCE(i.required_qty, 0), COALESCE(i.finished_qty, 0), COALESCE(i.drawing, ''), i.drawing_alt,
            i.issue, COALESCE(i.material, ''), COALESCE(i.expected_grade, ''), COALESCE(i.customer, ''),
            COALESCE(i.type, ''), COALESCE(i.colour, ''), COALESCE(i.erp_status, ''), COALESCE(i.order_date, now()), $2::uuid,
            ${DETAIL_INSERT_VALUES}
       FROM ${RECORDSET}
      WHERE NOT EXISTS (SELECT 1 FROM production_orders p WHERE lower(p.line_key) = lower(i.line_key))
     RETURNING id`,
    [payload, syncRunId],
  )
  const added = inserted.rowCount ?? 0
  const changed = updated.rowCount ?? 0
  return { inserted: added, updated: changed, unchanged: Math.max(0, unique.length - added - changed) }
}

export function ordersRoutes(ctx: AppContext): Router {
  const r = Router()

  /**
   * Order lines. Three ways in, all bounded:
   *   • `orderNumber` (+ `machine`) — the lines of one order, exact match:
   *     the item list on the new-inspection screen.
   *   • `search` (+ `machine`) — prefix search on the order number, the item
   *     code and the line key.
   *   • neither — the first page, for screens that browse.
   */
  r.get('/', async (req, res) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(120).default(''),
        machine: z.string().trim().max(40).default(''),
        orderNumber: z.string().trim().max(120).default(''),
        includeCancelled: z.coerce.boolean().default(false),
        // One order can have well over a hundred items on one machine; the
        // exact-order query returns them all, prefix search stays a page.
        limit: z.coerce.number().int().min(1).max(500).default(40),
      }),
      req.query,
    )
    const where: string[] = ['deleted_at IS NULL']
    const params: unknown[] = []
    if (!q.includeCancelled) where.push(NOT_CANCELLED)
    if (q.machine) {
      params.push(q.machine.toLowerCase())
      where.push(`lower(work_center_code) = $${params.length}`)
    }
    if (q.orderNumber) {
      params.push(q.orderNumber.toLowerCase())
      where.push(`lower(order_number) = $${params.length}`)
    } else if (q.search) {
      params.push(likePrefix(q.search))
      where.push(`(lower(order_number) LIKE $${params.length} OR lower(item_code) LIKE $${params.length} OR lower(line_key) LIKE $${params.length})`)
    }
    params.push(q.limit)
    const { rows } = await ctx.db.query<ProductionOrder>(
      `SELECT ${ORDER_SELECT} FROM production_orders
        WHERE ${where.join(' AND ')}
        ORDER BY order_number, item_code, work_center_code
        LIMIT $${params.length}`,
      params,
    )
    res.json(rows.map(dropNulls))
  })

  // The Access list's filters, its joins and its columns, shared by the page and by a column's values.
  const orderListQuery = z.object({
    q: z.string().trim().max(120).optional(),
    workCenterCode: z.string().trim().max(60).optional(),
    factory: z.string().trim().max(120).optional(),
    erpStatus: z.string().trim().max(40).optional(),
    item: z.string().trim().max(440).optional(),
    remaining: z.enum(['open', 'done']).optional(),
    inspected: z.enum(['yes', 'no']).optional(),
  })
  /** Each line with its machine, and what the inspection record adds: sessions, samples, defect pieces, the last sample. Aggregated once per table, not per row. */
  const ORDER_LIST_FROM = `
      FROM production_orders o
      LEFT JOIN LATERAL (
        SELECT m.factory, m.display_name FROM machines m WHERE ${NORMALISED_CODE('m.code')} = ${NORMALISED_CODE('o.work_center_code')} AND m.deleted_at IS NULL
        ORDER BY m.created_at LIMIT 1) m ON true
      LEFT JOIN (SELECT order_id, count(*)::int AS n FROM inspection_sessions WHERE deleted_at IS NULL GROUP BY order_id) ss ON ss.order_id = o.id
      LEFT JOIN (SELECT order_id, count(*)::int AS n, max(created_at) AS last FROM inspection_samples WHERE deleted_at IS NULL GROUP BY order_id) sm ON sm.order_id = o.id
      LEFT JOIN (SELECT x.order_id, sum(d.qty) AS pieces FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                  WHERE x.deleted_at IS NULL AND d.deleted_at IS NULL GROUP BY x.order_id) dd ON dd.order_id = o.id`
  /** The columns as Access shows them: the text a cell reads, and what a figure or a date sorts by. */
  const orderListColumns = (tz: string): SqlColumns => {
    const figure = (sql: string) => ({ text: `trim_scale((${sql})::numeric)::text`, sort: `(${sql})` })
    const day = (sql: string) => ({ text: `to_char((${sql}) AT TIME ZONE '${tz.replace(/'/g, "''")}', 'YYYY-MM-DD')`, sort: `(${sql})` })
    return {
      ...detailListColumns(),
      orderNumber: { text: 'btrim(o.order_number)' },
      lineKey: { text: 'btrim(o.line_key)' },
      item: { text: 'btrim(o.item)' },
      itemCode: { text: 'btrim(o.item_code)' },
      machine: { text: `CASE WHEN btrim(o.work_center_code) = '' THEN '' ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || btrim(o.work_center_code)) END` },
      factory: { text: `COALESCE(btrim(m.factory), '')` },
      erpStatus: { text: 'btrim(o.erp_status)' },
      requiredQty: figure('o.required_qty'),
      finishedQty: figure('o.finished_qty'),
      remainingQty: figure('GREATEST(0, o.required_qty - o.finished_qty)'),
      customer: { text: 'btrim(o.customer)' },
      expectedGrade: { text: 'btrim(o.expected_grade)' },
      drawing: { text: 'btrim(o.drawing)' },
      drawingAlt: { text: `COALESCE(btrim(o.drawing_alt), '')` },
      issue: { text: `COALESCE(btrim(o.issue), '')` },
      material: { text: 'btrim(o.material)' },
      type: { text: 'btrim(o.type)' },
      colour: { text: 'btrim(o.colour)' },
      date: day('o.order_date'),
      sessions: figure('COALESCE(ss.n, 0)'),
      samples: figure('COALESCE(sm.n, 0)'),
      defectPieces: figure('COALESCE(dd.pieces, 0)'),
      lastInspected: day('sm.last'),
    }
  }
  /** The WHERE clauses of the list's own filters. */
  function orderListWhere(q: z.infer<typeof orderListQuery>, p: (v: unknown) => string): string[] {
    const clauses = ['o.deleted_at IS NULL']
    if (q.q) {
      const t = p(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      clauses.push(`(o.order_number ILIKE ${t} OR o.line_key ILIKE ${t} OR o.item ILIKE ${t} OR o.item_code ILIKE ${t}
                     OR o.customer ILIKE ${t} OR o.drawing ILIKE ${t} OR o.work_center_code ILIKE ${t})`)
    }
    if (q.workCenterCode) clauses.push(`${NORMALISED_CODE('o.work_center_code')} = ${NORMALISED_CODE(p(q.workCenterCode) + '::text')}`)
    if (q.factory) clauses.push(`lower(btrim(COALESCE(m.factory, ''))) = lower(btrim(${p(q.factory)}))`)
    if (q.erpStatus) clauses.push(`lower(btrim(o.erp_status)) = lower(btrim(${p(q.erpStatus)}))`)
    // Any part of the code or the name, as typed; a pick from the list is that one item.
    if (q.item) clauses.push(itemFilterSql(q.item, p, 'o.item_code', 'o.item'))
    if (q.remaining === 'open') clauses.push('o.required_qty > o.finished_qty')
    if (q.remaining === 'done') clauses.push('o.required_qty <= o.finished_qty')
    if (q.inspected === 'yes') clauses.push('ss.n > 0')
    if (q.inspected === 'no') clauses.push('ss.n IS NULL')
    return clauses
  }

  /**
   * §19 — Access: every imported line, filtered in SQL over the whole sheet,
   * a page at a time, with what the inspection record adds to each line.
   * Cancelled lines are listed too: this is the sheet as it was uploaded.
   * Any column filters and sorts as in Excel (cf, sort).
   */
  r.get('/list', requireCapability('view-order-sheet'), async (req, res) => {
    requireUser(req)
    const q = parse(
      orderListQuery.merge(columnQuerySchema).extend({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    )
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const columns = orderListColumns(ctx.config.FACTORY_TIMEZONE)
    const clauses = [...orderListWhere(q, p), ...columnFilterClauses(columns, q.cf, p)]
    const orderBy = columnOrderBy(columns, q.sort, 'o.order_number, o.item_code, o.work_center_code, o.id')
    const limit = p(q.limit + 1)
    const offset = p(q.offset)
    const { rows } = await ctx.db.query<OrderListRow & { total: number }>(
      `SELECT ${ORDER_SELECT_O}, ${detailSelect('o')}, COALESCE(m.factory, '') AS factory,
              GREATEST(0, o.required_qty - o.finished_qty) AS "remainingQty",
              COALESCE(ss.n, 0) AS sessions,
              COALESCE(sm.n, 0) AS samples,
              COALESCE(dd.pieces, 0)::float8 AS "defectPieces",
              sm.last AS "lastInspectedAt",
              count(*) OVER ()::int AS total
         ${ORDER_LIST_FROM}
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    const hasMore = rows.length > q.limit
    const page = rows.slice(0, q.limit)
    const body: OrderListResponse = {
      orders: page.map(({ total: _t, ...row }) => dropNulls(row) as OrderListRow),
      total: rows[0]?.total ?? 0,
      hasMore,
    }
    res.json(body)
  })

  /** One Access column's values under every other filter, for its Excel menu. */
  r.get('/list/values', requireCapability('view-order-sheet'), async (req, res) => {
    requireUser(req)
    const q = parse(
      orderListQuery.merge(columnQuerySchema).extend({
        column: z.string().max(60),
        search: z.string().max(200).optional(),
      }),
      req.query,
    )
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const where = orderListWhere(q, p)
    res.json(await columnValues(ctx.db, { columns: orderListColumns(ctx.config.FACTORY_TIMEZONE), column: q.column, from: ORDER_LIST_FROM, where, params, filters: q.cf, search: q.search }))
  })

  /** What the Access filters may offer, drawn from every line on record. */
  r.get('/list/options', requireCapability('view-order-sheet'), async (req, res) => {
    requireUser(req)
    const [statuses, factories, machines, items] = await Promise.all([
      ctx.db.query<{ v: string }>(`SELECT DISTINCT btrim(erp_status) AS v FROM production_orders WHERE deleted_at IS NULL AND btrim(erp_status) <> '' ORDER BY 1`),
      ctx.db.query<{ v: string }>(`SELECT DISTINCT btrim(factory) AS v FROM machines WHERE deleted_at IS NULL AND btrim(COALESCE(factory, '')) <> '' ORDER BY 1`),
      ctx.db.query<{ v: string }>(`SELECT DISTINCT work_center_code AS v FROM production_orders WHERE deleted_at IS NULL AND btrim(work_center_code) <> '' ORDER BY 1`),
      // One row per item: its code and its name, since two items may share a code.
      ctx.db.query<{ itemCode: string; item: string }>(
        `SELECT DISTINCT ON (lower(btrim(item_code)), lower(btrim(item))) btrim(item_code) AS "itemCode", btrim(item) AS item
           FROM production_orders WHERE deleted_at IS NULL AND btrim(item_code) <> ''
          ORDER BY lower(btrim(item_code)), lower(btrim(item)), order_date DESC NULLS LAST, id`,
      ),
    ])
    const body: OrderListOptionsResponse = {
      erpStatuses: statuses.rows.map((r) => r.v),
      factories: factories.rows.map((r) => r.v),
      workCenterCodes: machines.rows.map((r) => r.v),
      items: items.rows,
    }
    res.json(body)
  })

  /**
   * The distinct order numbers that have lines on a machine (or anywhere),
   * with how many lines each has there. This is what the new-inspection
   * screen offers once a machine is chosen: a prefix search, `lineCount` the
   * lines on that machine.
   *
   * `match=contains` is the PDI's search: every word typed must appear
   * somewhere in the number ("20542 ph4" finds 20542-Ph4.1-EHF-KS), those that
   * start with the first word come first, and the list may be narrowed to the
   * orders with a line in a factory, on a machine, or of an item (any part of
   * its name, code or drawing). `lineCount` is then every line of the order.
   */
  r.get('/numbers', async (req, res) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(120).default(''),
        machine: z.string().trim().max(40).default(''),
        factory: z.string().trim().max(120).default(''),
        item: z.string().trim().max(120).default(''),
        /** One item picked from the list: its code and name, both exact. */
        itemCode: z.string().trim().max(120).optional(),
        itemName: z.string().trim().max(300).optional(),
        includeCancelled: z.coerce.boolean().default(false),
        match: z.enum(['prefix', 'contains']).default('prefix'),
        limit: z.coerce.number().int().min(1).max(200).default(40),
      }),
      req.query,
    )
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const contains = (t: string) => `%${t.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`

    if (q.match === 'prefix') {
      const where: string[] = ['deleted_at IS NULL']
      if (!q.includeCancelled) where.push(NOT_CANCELLED)
      if (q.machine) where.push(`lower(work_center_code) = ${p(q.machine.toLowerCase())}`)
      if (q.search) where.push(`lower(order_number) LIKE ${p(likePrefix(q.search))}`)
      const { rows } = await ctx.db.query<OrderNumberSummary>(
        `SELECT min(order_number) AS "orderNumber", min(customer) AS customer, count(*)::int AS "lineCount"
           FROM production_orders
          WHERE ${where.join(' AND ')}
          GROUP BY lower(order_number)
          ORDER BY lower(min(order_number))
          LIMIT ${p(q.limit)}`,
        params,
      )
      res.json(rows)
      return
    }

    // The lines that make an order a match; the order is then listed with all its lines.
    const match: string[] = ['x.deleted_at IS NULL']
    if (!q.includeCancelled) match.push(`NOT ${cancelledSql('x.erp_status')}`)
    const words = q.search.split(/\s+/).filter(Boolean).slice(0, 8)
    for (const w of words) match.push(`lower(x.order_number) LIKE ${p(contains(w))}`)
    if (q.machine) match.push(`lower(x.work_center_code) = ${p(q.machine.toLowerCase())}`)
    if (q.factory) {
      match.push(`EXISTS (SELECT 1 FROM machines m WHERE lower(m.code) = lower(x.work_center_code) AND m.deleted_at IS NULL
                           AND lower(btrim(COALESCE(m.factory, ''))) = lower(btrim(${p(q.factory)})))`)
    }
    if (q.item) {
      const t = p(contains(q.item))
      match.push(`(lower(x.item) LIKE ${t} OR lower(x.item_code) LIKE ${t} OR lower(x.drawing) LIKE ${t})`)
    }
    if (q.itemCode !== undefined) match.push(`lower(btrim(x.item_code)) = lower(btrim(${p(q.itemCode)}))`)
    if (q.itemName !== undefined) match.push(`lower(btrim(x.item)) = lower(btrim(${p(q.itemName)}))`)
    const first = words[0] ? p(likePrefix(words[0])) : null
    const lines = [`o.deleted_at IS NULL`, ...(q.includeCancelled ? [] : [`NOT ${cancelledSql('o.erp_status')}`])]
    const { rows } = await ctx.db.query<OrderNumberSummary>(
      `SELECT min(o.order_number) AS "orderNumber", min(o.customer) AS customer, count(*)::int AS "lineCount"
         FROM production_orders o
        WHERE ${lines.join(' AND ')}
          AND lower(o.order_number) IN (SELECT lower(x.order_number) FROM production_orders x WHERE ${match.join(' AND ')})
        GROUP BY lower(o.order_number)
        ORDER BY ${first ? `(lower(min(o.order_number)) LIKE ${first}) DESC, ` : ''}lower(min(o.order_number))
        LIMIT ${p(q.limit)}`,
      params,
    )
    res.json(rows)
  })

  /**
   * The items of the open order lines, one per code and name, for the PDI's
   * item list: narrowed to a factory or a machine, and searched by any part of
   * the name or code. A page, largest first by lines.
   */
  r.get('/items', async (req, res) => {
    const q = parse(
      z.object({
        factory: z.string().trim().max(120).default(''),
        machine: z.string().trim().max(40).default(''),
        search: z.string().trim().max(120).default(''),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    )
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const where = ['x.deleted_at IS NULL', `NOT ${cancelledSql('x.erp_status')}`]
    if (q.machine) where.push(`lower(x.work_center_code) = ${p(q.machine.toLowerCase())}`)
    if (q.factory) {
      where.push(`EXISTS (SELECT 1 FROM machines m WHERE lower(m.code) = lower(x.work_center_code) AND m.deleted_at IS NULL
                           AND lower(btrim(COALESCE(m.factory, ''))) = lower(btrim(${p(q.factory)})))`)
    }
    for (const w of q.search.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const t = p(`%${w.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      where.push(`(lower(x.item) LIKE ${t} OR lower(x.item_code) LIKE ${t})`)
    }
    const { rows } = await ctx.db.query<OrderItemOption>(
      `SELECT min(btrim(x.item_code)) AS "itemCode", min(btrim(x.item)) AS item, count(*)::int AS "lineCount"
         FROM production_orders x
        WHERE ${where.join(' AND ')}
        GROUP BY lower(btrim(x.item_code)), lower(btrim(x.item))
        ORDER BY lower(min(btrim(x.item))), lower(min(btrim(x.item_code)))
        LIMIT ${p(q.limit)}`,
      params,
    )
    res.json(rows)
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

  /** §5.8 — every note written on this order line, across its sessions, newest first. */
  r.get('/:id/notes', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const [order] = await fetchOrdersByIds(ctx.db, [id])
    if (!order) throw notFound('That order')
    const body: SessionNotesResponse = { notes: await loadOrderNotes(ctx.db, id) }
    res.json(body)
  })

  /**
   * Retire the whole catalogue before a fresh ERP export is loaded. Lines are
   * marked deleted, never erased (§10): sessions recorded against them keep
   * their order, and a line the new export still carries comes back through
   * the import's upsert. Only an administrator, and the count is audited.
   */
  r.post('/clear', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const result = await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE production_orders SET deleted_at = now(), deleted_by_id = $1 WHERE deleted_at IS NULL`,
        [user.id],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'delete',
          entity: 'ProductionOrder',
          entityId: 'all',
          field: 'clear',
          newValue: `${rowCount ?? 0} order lines marked deleted before a fresh import`,
        },
      ])
      const body: ClearOrdersResult = { removed: rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  /** Which line keys already exist — the importer's new-vs-update preview. */
  r.post('/existing-keys', requireCapability('manage-admin-data'), async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(
      `SELECT lower(line_key) AS key FROM production_orders WHERE lower(line_key) = ANY($1::text[])`,
      [wanted],
    )
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /** What importing a batch would do, written nowhere: the importer's preview, and what it sends (only what changes). */
  r.post('/import/compare', requireCapability('manage-admin-data'), async (req, res) => {
    const { rows } = parse(importSchema, req.body)
    const body: ImportCompareResponse = await compareOrderLines(ctx.db, rows)
    res.json(body)
  })

  /**
   * §7.7 — idempotent bulk upsert on the line key, the ERP's Order ID (matched
   * without regard to case; the stored spelling is kept). A field the file
   * does not carry leaves the stored value alone; a line that had been marked
   * deleted comes back, because the ERP says it is current. A line seen for
   * the first time must name its order number. A line the row would not
   * change is not written, and is counted as unchanged.
   */
  r.post('/import', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(importSchema, req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      const { inserted, updated, unchanged } = await upsertOrderLines(tx, rows)
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
          newValue: `${inserted} inserted, ${updated} updated, ${unchanged ?? 0} unchanged`,
        },
      ])
      const body: ImportResult = { inserted, updated, unchanged }
      return body
    })
    res.json(result)
  })

  return r
}
