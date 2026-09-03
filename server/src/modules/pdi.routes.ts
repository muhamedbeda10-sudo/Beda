// §4 — Pre-Delivery Inspection: photo documentation attached to an order.

import { Router } from 'express'
import { z } from 'zod'
import type { OrderSummary, PDIWithOrder } from '@qc/shared/api'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditCreate } from '../audit/service'
import { assertImagesUsable, linkImages } from './images.links'

const createSchema = z.object({
  orderId: z.string().uuid(),
  notes: z.string().trim().max(4000).optional(),
  imageIds: z.array(z.string().uuid()).max(50).default([]),
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
}

const PDI_SELECT = `
  d.id, d.order_id AS "orderId", d.notes, d.created_at AS "createdAt", d.created_by_id AS "createdById",
  d.created_by_name AS "createdByName",
  COALESCE((SELECT array_agg(pi.image_id ORDER BY pi.position) FROM pdi_images pi WHERE pi.pdi_id = d.id), '{}') AS "imageIds",
  CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', o.id, 'orderNumber', o.order_number, 'item', o.item, 'itemCode', o.item_code,
    'workCenterCode', o.work_center_code, 'customer', o.customer, 'expectedGrade', o.expected_grade) END AS "order"`

function toDto(r: Row): PDIWithOrder {
  return {
    id: r.id,
    orderId: r.orderId,
    notes: r.notes ?? undefined,
    imageIds: r.imageIds,
    createdAt: r.createdAt,
    createdById: r.createdById,
    createdByName: r.createdByName,
    order: r.order,
  }
}

export function pdiRoutes(ctx: AppContext): Router {
  const r = Router()

  r.get('/', async (req, res) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query)
    const { rows } = await ctx.db.query<Row>(
      `SELECT ${PDI_SELECT} FROM pdi_documents d LEFT JOIN production_orders o ON o.id = d.order_id
        WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT $1`,
      [q.limit],
    )
    res.json(rows.map(toDto))
  })

  r.post('/', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body)
    const created = await withTransaction(ctx.db, async (tx) => {
      const order = (await tx.query<{ id: string; orderNumber: string; item: string }>(
        `SELECT id, order_number AS "orderNumber", item FROM production_orders WHERE id = $1 AND deleted_at IS NULL`,
        [body.orderId],
      )).rows[0]
      if (!order) throw badRequest('That order does not exist.')
      await assertImagesUsable(tx, body.imageIds)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO pdi_documents (order_id, notes, created_by_id, created_by_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.orderId, body.notes ?? null, user.id, user.name],
      )
      const id = rows[0].id
      await linkImages(tx, 'pdi_images', 'pdi_id', id, body.imageIds)
      await auditCreate(tx, {
        userId: user.id,
        userName: user.name,
        entity: 'PDIDocument',
        entityId: id,
        orderNumber: order.orderNumber,
        item: order.item,
      })
      const full = await tx.query<Row>(
        `SELECT ${PDI_SELECT} FROM pdi_documents d LEFT JOIN production_orders o ON o.id = d.order_id WHERE d.id = $1`,
        [id],
      )
      return toDto(full.rows[0])
    })
    res.status(201).json(created)
  })

  return r
}
