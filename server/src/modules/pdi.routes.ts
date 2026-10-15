// §4 — Pre-Delivery Inspection: photo documentation of a delivery. A PDI
// names the order lines it covers — the items of one order that ship — with
// notes and photos. The list is the factory's record: every filter runs in
// SQL over every PDI, and the list walks back page by page, so a PDI from a
// year ago is found the same way as today's.

import { Router } from 'express'
import { z } from 'zod'
import type { OrderSummary, PDIItem, PDIListResponse, PDIOptionsResponse, PDIWithOrder } from '@qc/shared/api'
import { EXPORT_MAX_RECORDS } from '@qc/shared/api'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireAnyPermission, requirePermission, requireUser } from '../auth/middleware'
import { auditCreate } from '../audit/service'
import { assertImagesUsable, linkImages } from './images.links'
import { cancelledSql } from '../lib/orderStatus'
import { columnFilterClauses, columnOrderBy, columnQuerySchema, columnValues, type SqlColumns } from '../lib/columnFilters'

/** One order can carry a few hundred lines; a PDI covers some or all of them. */
const MAX_LINES = 500

const createSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1, 'Tick at least one item.').max(MAX_LINES),
  notes: z.string().trim().max(4000).optional(),
  imageIds: z.array(z.string().uuid()).max(50).default([]),
})

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day, YYYY-MM-DD')

const filterSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    item: z.string().trim().max(120).optional(),
    createdById: z.string().uuid().optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .merge(columnQuerySchema)

const listSchema = filterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** PDIs recorded before this instant: the end of the page already read. */
  before: z.string().datetime({ offset: true }).optional(),
  /** With a column sort, pages walk by position instead. */
  offset: z.coerce.number().int().min(0).max(100000).default(0),
})

const valuesSchema = filterSchema.extend({ column: z.string().max(60), search: z.string().max(200).optional() })

interface Row {
  id: string
  orderId: string
  notes: string | null
  createdAt: string
  createdById: string
  createdByName: string
  imageIds: string[]
  order: OrderSummary | null
  orderNumber: string
  customer: string
  items: PDIItem[]
}

/**
 * A PDI with its anchor line, and its items: the lines it covers grouped by
 * item code and name together, so two items that share a code stay two, each
 * with its drawings.
 */
const PDI_SELECT = `
  d.id, d.order_id AS "orderId", d.notes, d.created_at AS "createdAt", d.created_by_id AS "createdById",
  d.created_by_name AS "createdByName",
  COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.position) FROM pdi_images pi WHERE pi.pdi_id = d.id), '{}') AS "imageIds",
  CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', o.id, 'orderNumber', o.order_number, 'item', o.item, 'itemCode', o.item_code,
    'workCenterCode', o.work_center_code, 'customer', o.customer, 'expectedGrade', o.expected_grade) END AS "order",
  COALESCE(o.order_number, '') AS "orderNumber",
  COALESCE(o.customer, '') AS customer,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('itemCode', g.item_code, 'item', g.item, 'drawings', g.drawings, 'lineIds', g.line_ids) ORDER BY lower(g.item_code), lower(g.item))
      FROM (
        SELECT min(l.item_code) AS item_code, min(l.item) AS item,
               COALESCE(array_agg(DISTINCT btrim(l.drawing)) FILTER (WHERE btrim(l.drawing) <> ''), '{}') AS drawings,
               array_agg(l.id::text ORDER BY l.work_center_code) AS line_ids
          FROM pdi_lines pl JOIN production_orders l ON l.id = pl.order_id
         WHERE pl.pdi_id = d.id
         GROUP BY lower(btrim(l.item_code)), lower(btrim(l.item))
      ) g), '[]') AS items`

const PDI_FROM = `FROM pdi_documents d LEFT JOIN production_orders o ON o.id = d.order_id`

/** The columns as the PDI table shows them: the text a cell reads, and what a figure or a date sorts by. */
function pdiColumns(tz: string): SqlColumns {
  const photos = `(SELECT count(*) FROM pdi_images pi WHERE pi.pdi_id = d.id)`
  return {
    date: { text: `to_char(d.created_at AT TIME ZONE '${tz.replace(/'/g, "''")}', 'YYYY-MM-DD')`, sort: 'd.created_at' },
    order: { text: `COALESCE(btrim(o.order_number), '')` },
    customer: { text: `COALESCE(btrim(o.customer), '')` },
    // Every item the PDI covers, A to Z, as one cell: "contains" finds a PDI by any of them.
    items: {
      text: `COALESCE((SELECT string_agg(x.item, ', ' ORDER BY lower(x.item))
                         FROM (SELECT DISTINCT btrim(l.item) AS item FROM pdi_lines pl JOIN production_orders l ON l.id = pl.order_id WHERE pl.pdi_id = d.id) x), '')`,
    },
    by: { text: 'btrim(d.created_by_name)' },
    photos: { text: `${photos}::text`, sort: photos },
    notes: { text: `COALESCE(btrim(d.notes), '')` },
  }
}

function toDto(r: Row): PDIWithOrder {
  return {
    id: r.id,
    orderId: r.orderId,
    notes: r.notes ?? undefined,
    imageIds: r.imageIds,
    createdAt: new Date(r.createdAt).toISOString(),
    createdById: r.createdById,
    createdByName: r.createdByName,
    order: r.order,
    orderNumber: r.orderNumber,
    customer: r.customer,
    items: r.items,
  }
}

/** A literal ILIKE pattern: the wildcards a person types are text. */
const contains = (term: string): string => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The PDI list's filters as SQL over pdi_documents `d` joined to its anchor
 * line `o`; with `columns`, the column filters too (a column's own values
 * leave them to columnValues).
 */
function pdiWhere(q: z.infer<typeof filterSchema>, tz: string, columns = true): { where: string; params: unknown[] } {
  if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
  const clauses = ['d.deleted_at IS NULL']
  const params: unknown[] = []
  const p = (v: unknown) => `$${params.push(v)}`
  // A line of the PDI whose item, code or drawing matches.
  const lineMatches = (t: string) => `EXISTS (SELECT 1 FROM pdi_lines pl JOIN production_orders l ON l.id = pl.order_id
                                       WHERE pl.pdi_id = d.id AND (l.item ILIKE ${t} OR l.item_code ILIKE ${t} OR l.drawing ILIKE ${t}))`
  if (q.q) {
    const t = p(contains(q.q))
    clauses.push(`(o.order_number ILIKE ${t} OR o.customer ILIKE ${t} OR d.notes ILIKE ${t} OR d.created_by_name ILIKE ${t} OR ${lineMatches(t)})`)
  }
  if (q.item) clauses.push(lineMatches(p(contains(q.item))))
  if (q.createdById) clauses.push(`d.created_by_id = ${p(q.createdById)}::uuid`)
  if (q.from || q.to) {
    // Factory days in the factory's zone, both ends inclusive, as History reads a day.
    const zone = p(tz)
    if (q.from) clauses.push(`d.created_at >= (${p(q.from)}::date)::timestamp AT TIME ZONE ${zone}`)
    if (q.to) clauses.push(`d.created_at < ((${p(q.to)}::date + 1)::timestamp) AT TIME ZONE ${zone}`)
  }
  if (columns) clauses.push(...columnFilterClauses(pdiColumns(tz), q.cf, p))
  return { where: clauses.join(' AND '), params }
}

export function pdiRoutes(ctx: AppContext): Router {
  const r = Router()

  // History's PDI tab (§14).
  r.get('/', requirePermission('view-history'), async (req, res) => {
    const q = parse(listSchema, req.query)
    const { where, params } = pdiWhere(q, ctx.config.FACTORY_TIMEZONE)
    const p = (v: unknown) => `$${params.push(v)}`
    const filterParams = [...params]
    // Newest first, walked back by `before`; sorted by a column, walked by `offset`.
    const newest = 'd.created_at DESC, d.id DESC'
    const sorted = !!q.sort
    const paged = q.before && !sorted ? `${where} AND d.created_at < ${p(q.before)}::timestamptz` : where
    const orderBy = columnOrderBy(pdiColumns(ctx.config.FACTORY_TIMEZONE), q.sort, newest)
    const limit = p(q.limit + 1)
    const offset = sorted ? ` OFFSET ${p(q.offset)}` : ''
    const firstPage = sorted ? q.offset === 0 : !q.before
    const [page, counted] = await Promise.all([
      ctx.db.query<Row>(`SELECT ${PDI_SELECT} ${PDI_FROM} WHERE ${paged} ORDER BY ${orderBy} LIMIT ${limit}${offset}`, params),
      firstPage ? ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n ${PDI_FROM} WHERE ${where}`, filterParams) : null,
    ])
    const body: PDIListResponse = { documents: page.rows.slice(0, q.limit).map(toDto), hasMore: page.rows.length > q.limit }
    if (counted) body.total = counted.rows[0].n
    res.json(body)
  })

  /** §4 — the PDIs the filters match, oldest first, for Excel. Bounded like History's export. */
  r.get('/export', requirePermission('view-history'), requirePermission('export-records'), async (req, res) => {
    const q = parse(filterSchema, req.query)
    const { where, params } = pdiWhere(q, ctx.config.FACTORY_TIMEZONE)
    const counted = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n ${PDI_FROM} WHERE ${where}`, params)
    if (counted.rows[0].n > EXPORT_MAX_RECORDS) {
      throw badRequest(`${counted.rows[0].n} PDIs match; one export holds ${EXPORT_MAX_RECORDS}. Narrow the date range or the filters.`)
    }
    const { rows } = await ctx.db.query<Row>(`SELECT ${PDI_SELECT} ${PDI_FROM} WHERE ${where} ORDER BY d.created_at, d.id`, params)
    res.json(rows.map(toDto))
  })

  /** One PDI column's values under every other filter, for its Excel menu. */
  r.get('/values', requirePermission('view-history'), async (req, res) => {
    const q = parse(valuesSchema, req.query)
    const tz = ctx.config.FACTORY_TIMEZONE
    const { where, params } = pdiWhere(q, tz, false)
    res.json(await columnValues(ctx.db, { columns: pdiColumns(tz), column: q.column, from: PDI_FROM, where: [where], params, filters: q.cf, search: q.search }))
  })

  /** Who the PDI list may be narrowed to: everyone who ever recorded one. */
  r.get('/options', requireAnyPermission('view-history', 'record-inspection'), async (_req, res) => {
    const { rows } = await ctx.db.query<{ id: string; name: string }>(
      `SELECT DISTINCT ON (created_by_id) created_by_id AS id, created_by_name AS name
         FROM pdi_documents WHERE deleted_at IS NULL
        ORDER BY created_by_id, created_at DESC`,
    )
    const body: PDIOptionsResponse = { createdBy: rows.sort((a, b) => a.name.localeCompare(b.name)) }
    res.json(body)
  })

  r.post('/', requirePermission('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body)
    const ids = Array.from(new Set(body.orderIds))
    const created = await withTransaction(ctx.db, async (tx) => {
      const { rows: lines } = await tx.query<{ id: string; orderNumber: string; item: string; itemCode: string; cancelled: boolean }>(
        `SELECT id, order_number AS "orderNumber", item, item_code AS "itemCode", ${cancelledSql('erp_status')} AS cancelled
           FROM production_orders WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
          ORDER BY lower(item_code), lower(item), work_center_code`,
        [ids],
      )
      if (lines.length !== ids.length) throw badRequest('Some of those order lines do not exist.')
      // A cancelled line does not ship, so a PDI does not cover it.
      if (lines.some((l) => l.cancelled)) throw badRequest('Some of those lines are cancelled on the order sheet: a PDI covers only what ships.')
      const numbers = new Set(lines.map((l) => l.orderNumber.trim().toLowerCase()))
      if (numbers.size > 1) throw badRequest('A PDI covers one order: those lines belong to more than one.')
      await assertImagesUsable(tx, body.imageIds)
      const anchor = lines[0]
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO pdi_documents (order_id, notes, created_by_id, created_by_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [anchor.id, body.notes ?? null, user.id, user.name],
      )
      const id = rows[0].id
      await tx.query(`INSERT INTO pdi_lines (pdi_id, order_id) SELECT $1, unnest($2::uuid[])`, [id, lines.map((l) => l.id)])
      await linkImages(tx, 'pdi_images', 'pdi_id', id, body.imageIds)
      const itemCount = new Set(lines.map((l) => `${l.itemCode.trim()}|${l.item.trim()}`.toLowerCase())).size
      await auditCreate(tx, {
        userId: user.id,
        userName: user.name,
        entity: 'PDIDocument',
        entityId: id,
        orderNumber: anchor.orderNumber,
        item: itemCount === 1 ? anchor.item : `${itemCount} items`,
      })
      const full = await tx.query<Row>(`SELECT ${PDI_SELECT} ${PDI_FROM} WHERE d.id = $1`, [id])
      return toDto(full.rows[0])
    })
    res.status(201).json(created)
  })

  return r
}
