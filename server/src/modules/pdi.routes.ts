// §4 — Pre-Delivery Inspection: photo documentation of a delivery. A PDI
// names the order lines it covers — the items of one order that ship — with
// notes and photos. The list is the factory's record: every filter runs in
// SQL over every PDI, and the list walks back page by page, so a PDI from a
// year ago is found the same way as today's.

import { Router } from 'express'
import { z } from 'zod'
import type { OrderSummary, PDIItem, PDIListResponse, PDIOptionsResponse, PDIWithOrder } from '@qc/shared/api'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditCreate } from '../audit/service'
import { assertImagesUsable, linkImages } from './images.links'

/** One order can carry a few hundred lines; a PDI covers some or all of them. */
const MAX_LINES = 500

const createSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1, 'Tick at least one item.').max(MAX_LINES),
  notes: z.string().trim().max(4000).optional(),
  imageIds: z.array(z.string().uuid()).max(50).default([]),
})

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day, YYYY-MM-DD')

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** PDIs recorded before this instant: the end of the page already read. */
  before: z.string().datetime({ offset: true }).optional(),
  q: z.string().trim().max(120).optional(),
  item: z.string().trim().max(120).optional(),
  createdById: z.string().uuid().optional(),
  from: day.optional(),
  to: day.optional(),
})

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
 * item code (by name when a line has no code), each with its drawings.
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
         GROUP BY lower(COALESCE(NULLIF(btrim(l.item_code), ''), l.item))
      ) g), '[]') AS items`

const PDI_FROM = `FROM pdi_documents d LEFT JOIN production_orders o ON o.id = d.order_id`

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

export function pdiRoutes(ctx: AppContext): Router {
  const r = Router()

  r.get('/', async (req, res) => {
    const q = parse(listSchema, req.query)
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
      const tz = p(ctx.config.FACTORY_TIMEZONE)
      if (q.from) clauses.push(`d.created_at >= (${p(q.from)}::date)::timestamp AT TIME ZONE ${tz}`)
      if (q.to) clauses.push(`d.created_at < ((${p(q.to)}::date + 1)::timestamp) AT TIME ZONE ${tz}`)
    }
    const where = clauses.join(' AND ')
    const filterParams = [...params]
    const paged = q.before ? `${where} AND d.created_at < ${p(q.before)}::timestamptz` : where
    const limit = p(q.limit + 1)
    const [page, counted] = await Promise.all([
      ctx.db.query<Row>(`SELECT ${PDI_SELECT} ${PDI_FROM} WHERE ${paged} ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit}`, params),
      q.before ? null : ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n ${PDI_FROM} WHERE ${where}`, filterParams),
    ])
    const body: PDIListResponse = { documents: page.rows.slice(0, q.limit).map(toDto), hasMore: page.rows.length > q.limit }
    if (counted) body.total = counted.rows[0].n
    res.json(body)
  })

  /** Who the PDI list may be narrowed to: everyone who ever recorded one. */
  r.get('/options', async (_req, res) => {
    const { rows } = await ctx.db.query<{ id: string; name: string }>(
      `SELECT DISTINCT ON (created_by_id) created_by_id AS id, created_by_name AS name
         FROM pdi_documents WHERE deleted_at IS NULL
        ORDER BY created_by_id, created_at DESC`,
    )
    const body: PDIOptionsResponse = { createdBy: rows.sort((a, b) => a.name.localeCompare(b.name)) }
    res.json(body)
  })

  r.post('/', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body)
    const ids = Array.from(new Set(body.orderIds))
    const created = await withTransaction(ctx.db, async (tx) => {
      const { rows: lines } = await tx.query<{ id: string; orderNumber: string; item: string; itemCode: string }>(
        `SELECT id, order_number AS "orderNumber", item, item_code AS "itemCode"
           FROM production_orders WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
          ORDER BY lower(item_code), lower(item), work_center_code`,
        [ids],
      )
      if (lines.length !== ids.length) throw badRequest('Some of those order lines do not exist.')
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
      const itemCount = new Set(lines.map((l) => (l.itemCode.trim() || l.item).toLowerCase())).size
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
