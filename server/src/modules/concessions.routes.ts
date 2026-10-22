import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Concession, ConcessionCategory, ConcessionItem, ConcessionOrder, ConcessionListResponse, ConcessionMachine, ConcessionOptions } from '@qc/shared/concessions'
import type { AppContext } from '../context'
import { requirePermission, requireUser } from '../auth/middleware'
import { auditCreate } from '../audit/service'
import { withTransaction } from '../db/pool'
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { assertImagesUsable, linkImages } from './images.links'
import { readableImageIds } from './images.routes'

const text = (max: number) => z.string().trim().min(1).max(max)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '0001-01-01'
}, 'Choose a valid calendar date.')
const unique = (values: string[]) => Array.from(new Set(values)).sort()
const createSchema = z.object({
  submissionId: z.string().uuid(),
  date: day,
  factories: z.array(text(120)).min(1).max(100).transform(unique),
  machineIds: z.array(z.string().uuid()).min(1).max(500).transform(unique),
  orderNumber: text(500),
  itemCode: z.string().trim().max(500),
  item: text(1000),
  description: text(4000),
  // Deliberately text: "all stock" and "250 pcs" are valid quantities.
  quantity: text(200),
  categoryId: z.string().uuid(),
  concessionById: z.string().uuid(),
  imageIds: z.array(z.string().uuid()).max(50).default([]).transform((ids) => Array.from(new Set(ids))),
})
const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  factory: z.string().trim().max(120).optional(),
  machineId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  from: day.optional(),
  to: day.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const contains = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

const SELECT = `c.id, to_char(c.date, 'YYYY-MM-DD') AS date, c.factories, c.customer, c.order_number AS "orderNumber",
  c.item_code AS "itemCode", c.item, c.description, c.quantity, c.category_id AS "categoryId",
  c.category_name AS "categoryName", c.concession_by AS "concessionBy", c.concession_by_id AS "concessionById", c.created_at AS "createdAt",
  c.created_by_id AS "createdById", c.created_by_name AS "createdByName",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.machine_id, 'code', m.code,
    'displayName', m.display_name, 'factory', m.factory) ORDER BY m.position)
    FROM concession_machines m WHERE m.concession_id = c.id), '[]') AS machines,
  COALESCE((SELECT array_agg(i.image_id ORDER BY i.position) FROM concession_images i
    WHERE i.concession_id = c.id), '{}') AS "imageIds"`

export function concessionsRoutes(ctx: AppContext): Router {
  const r = Router()
  // Screen access is enforced on every route, including the choice lists.
  r.use(requirePermission('view-concessions'))

  r.get('/options', async (_req, res) => {
    const [machines, categories, factories, people] = await Promise.all([
      ctx.db.query<ConcessionMachine>(`SELECT id, code, display_name AS "displayName", btrim(COALESCE(factory, '')) AS factory
        FROM machines WHERE deleted_at IS NULL ORDER BY factory, display_name, code, id`),
      ctx.db.query<ConcessionCategory>('SELECT id, name FROM concession_categories ORDER BY lower(name)'),
      // Include recorded factories in filters even after a machine moves or is retired.
      ctx.db.query<{ name: string }>(`SELECT DISTINCT name FROM (
        SELECT btrim(factory) AS name FROM machines WHERE deleted_at IS NULL
        UNION SELECT unnest(factories) FROM concessions WHERE deleted_at IS NULL
      ) f WHERE name <> '' ORDER BY name`),
      ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE is_active AND NOT is_system ORDER BY lower(name), id'),
    ])
    const body: ConcessionOptions = { machines: machines.rows, categories: categories.rows, factories: factories.rows.map((f) => f.name), people: people.rows }
    res.json(body)
  })

  r.get('/orders', async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(200).default('') }), req.query)
    const { rows } = await ctx.db.query<ConcessionOrder>(`SELECT btrim(order_number) AS "orderNumber", min(btrim(customer)) AS customer
      FROM production_orders WHERE deleted_at IS NULL AND btrim(order_number) <> '' AND order_number ILIKE $1
      GROUP BY btrim(order_number) ORDER BY "orderNumber" LIMIT 100`, [contains(q.q)])
    res.json(rows)
  })

  r.get('/items', async (req, res) => {
    const q = parse(z.object({ orderNumber: text(500), q: z.string().trim().max(200).default('') }), req.query)
    const { rows } = await ctx.db.query<ConcessionItem>(`SELECT DISTINCT btrim(item_code) AS "itemCode", btrim(item) AS item
      FROM production_orders WHERE deleted_at IS NULL AND lower(btrim(order_number)) = lower($1)
        AND btrim(item) <> '' AND (item ILIKE $2 OR item_code ILIKE $2)
      ORDER BY item, "itemCode" LIMIT 100`, [q.orderNumber, contains(q.q)])
    res.json(rows)
  })

  r.post('/categories', requirePermission('record-concession'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(z.object({ name: text(120) }), req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      const inserted = await tx.query<ConcessionCategory>(`INSERT INTO concession_categories (name) VALUES ($1)
        ON CONFLICT (lower(btrim(name))) DO NOTHING RETURNING id, name`, [body.name])
      if (inserted.rows[0]) {
        const row = inserted.rows[0]
        await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'ConcessionCategory', entityId: row.id, item: row.name })
        return { category: row, created: true }
      }
      const existing = await tx.query<ConcessionCategory>('SELECT id, name FROM concession_categories WHERE lower(btrim(name)) = lower($1)', [body.name])
      return { category: existing.rows[0], created: false }
    })
    res.status(result.created ? 201 : 200).json(result.category)
  })

  r.get('/', async (req, res) => {
    const q = parse(listSchema, req.query)
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['c.deleted_at IS NULL']
    if (q.q) {
      const term = p(contains(q.q))
      clauses.push(`(c.order_number ILIKE ${term} OR c.customer ILIKE ${term} OR c.item ILIKE ${term} OR c.item_code ILIKE ${term}
        OR c.description ILIKE ${term} OR c.quantity ILIKE ${term} OR c.concession_by ILIKE ${term}
        OR c.category_name ILIKE ${term} OR c.created_by_name ILIKE ${term}
        OR EXISTS (SELECT 1 FROM concession_machines m WHERE m.concession_id = c.id
          AND (m.code ILIKE ${term} OR m.display_name ILIKE ${term} OR m.factory ILIKE ${term})))`)
    }
    if (q.factory) clauses.push(`c.factories @> ARRAY[${p(q.factory)}]::text[]`)
    if (q.machineId) clauses.push(`EXISTS (SELECT 1 FROM concession_machines m WHERE m.concession_id = c.id AND m.machine_id = ${p(q.machineId)}::uuid)`)
    if (q.categoryId) clauses.push(`c.category_id = ${p(q.categoryId)}::uuid`)
    if (q.from) clauses.push(`c.date >= ${p(q.from)}::date`)
    if (q.to) clauses.push(`c.date <= ${p(q.to)}::date`)
    const where = clauses.join(' AND ')
    const counted = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM concessions c WHERE ${where}`, params)
    const limit = p(q.limit)
    const offset = p(q.offset)
    const { rows } = await ctx.db.query<Concession>(`SELECT ${SELECT} FROM concessions c WHERE ${where}
      ORDER BY c.date DESC, c.created_at DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const total = counted.rows[0].n
    const body: ConcessionListResponse = { concessions: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  r.post('/', requirePermission('record-concession'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      // Concurrent retries wait for the same submission, then read its saved result.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = await tx.query<{ id: string; createdBy: string; hash: string }>(
        `SELECT id, created_by_id AS "createdBy", request_hash AS hash FROM concessions WHERE submission_id = $1`, [body.submissionId])
      if (prior.rows[0]) {
        const row = prior.rows[0]
        if (row.createdBy !== user.id || row.hash !== requestHash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values. Refresh the register before recording another concession.')
        const saved = await tx.query<Concession>(`SELECT ${SELECT} FROM concessions c WHERE c.id = $1 AND c.deleted_at IS NULL`, [row.id])
        if (!saved.rows[0]) throw notFound('That concession')
        return { concession: saved.rows[0], created: false }
      }
      const machines = await tx.query<ConcessionMachine>(`SELECT id, code, display_name AS "displayName", btrim(COALESCE(factory, '')) AS factory
        FROM machines WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE`, [body.machineIds])
      if (machines.rows.length !== body.machineIds.length) throw badRequest('One of the selected machines is no longer available. Choose it again.')
      if (machines.rows.some((m) => !body.factories.includes(m.factory))) {
        throw badRequest('Choose machines from the selected factories.')
      }
      const item = await tx.query<{ customer: string; orderNumber: string }>(`SELECT btrim(customer) AS customer, btrim(order_number) AS "orderNumber" FROM production_orders WHERE deleted_at IS NULL
        AND lower(btrim(order_number)) = lower($1) AND btrim(item_code) = $2 AND btrim(item) = $3 ORDER BY id LIMIT 1`, [body.orderNumber, body.itemCode, body.item])
      if (item.rows.length === 0) throw badRequest('Choose an item from this order.')
      const person = await tx.query<{ name: string }>('SELECT name FROM users WHERE id = $1 AND is_active AND NOT is_system', [body.concessionById])
      if (!person.rows[0]) throw badRequest('Choose an active user for Concession BY.')
      const category = await tx.query<ConcessionCategory>('SELECT id, name FROM concession_categories WHERE id = $1', [body.categoryId])
      if (!category.rows[0]) throw badRequest('Choose an existing category, or add it first.')
      await assertImagesUsable(tx, body.imageIds)
      const readable = await readableImageIds(tx, user, body.imageIds)
      if (readable.size !== body.imageIds.length) throw forbidden('You cannot attach one of these photos. Upload the email screenshot again.')
      const inserted = await tx.query<{ id: string }>(`INSERT INTO concessions
        (submission_id, request_hash, date, factories, customer, item_code, item, description, quantity,
         category_id, category_name, concession_by, created_by_id, created_by_name, order_number, concession_by_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [body.submissionId, requestHash, body.date, body.factories, item.rows[0].customer, body.itemCode, body.item,
          body.description, body.quantity, body.categoryId, category.rows[0].name, person.rows[0].name, user.id, user.name, item.rows[0].orderNumber, body.concessionById])
      const id = inserted.rows[0].id
      for (const [position, machine] of machines.rows.entries()) {
        await tx.query(`INSERT INTO concession_machines (concession_id, machine_id, code, display_name, factory, position)
          VALUES ($1,$2,$3,$4,$5,$6)`, [id, machine.id, machine.code, machine.displayName, machine.factory, position])
      }
      await linkImages(tx, 'concession_images', 'concession_id', id, body.imageIds)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'Concession', entityId: id, item: body.item })
      const full = await tx.query<Concession>(`SELECT ${SELECT} FROM concessions c WHERE c.id = $1`, [id])
      return { concession: full.rows[0], created: true }
    })
    res.status(result.created ? 201 : 200).json(result.concession)
  })

  return r
}
