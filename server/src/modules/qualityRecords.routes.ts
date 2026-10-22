import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router } from 'express'
import { z } from 'zod'
import { QUALITY_FORMS, NCR_SOURCES, COMPLAINT_ISSUES, type QualityKind, type QualityRecord, type QualityRecordData, type QualityRecordList, type QualityRecordOptions, type QualityItem, type QualityOrder, type NcrData } from '@qc/shared/qualityRecords'
import type { ConcessionMachine } from '@qc/shared/concessions'
import type { AppContext } from '../context'
import { requirePermission, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate } from '../audit/service'
import { withTransaction, type Queryable } from '../db/pool'
import { badRequest, ConflictError, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { assertImagesUsable } from './images.links'
import { readableImageIds } from './images.routes'
import { complaintDataSchema, ncrDataSchema, qualityDay, qualitySaveSchema } from './qualityRecords.schemas'

const SELECT = `q.id, q.kind, q.reference, to_char(q.date, 'YYYY-MM-DD') AS date, q.data, q.form, q.version,
  q.created_at AS "createdAt", q.created_by_id AS "createdById", q.created_by_name AS "createdByName",
  q.updated_at AS "updatedAt", q.updated_by_name AS "updatedByName",
  COALESCE((SELECT array_agg(x.image_id ORDER BY x.position) FROM quality_record_images x
    WHERE x.record_id = q.id AND x.removed_at IS NULL), '{}') AS "imageIds"`
const contains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const searchSchema = z.object({ q: z.string().trim().max(200).default('') })
const listSchema = searchSchema.extend({
  category: z.string().max(200).optional(), factory: z.string().max(120).optional(), from: qualityDay.optional(), to: qualityDay.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Keep previous snapshots when doing follow-up work after the ERP or master data changes. */
async function normalise(tx: Queryable, kind: QualityKind, input: unknown, previous?: QualityRecord): Promise<QualityRecordData> {
  if (kind === 'customer-complaint') {
    const d = parse(complaintDataSchema, input)
    const old = previous?.data.kind === kind ? previous.data : null
    if (old && d.orderNumber === old.orderNumber && d.itemCode === old.itemCode && d.productName === old.productName) return { ...d, customer: old.customer }
    const item = await tx.query<{ orderNumber: string; customer: string; productName: string; itemCode: string }>(
      `SELECT btrim(order_number) AS "orderNumber", btrim(customer) AS customer, btrim(item) AS "productName", btrim(item_code) AS "itemCode"
       FROM production_orders WHERE deleted_at IS NULL AND lower(btrim(order_number)) = lower($1)
         AND btrim(item_code) = $2 AND btrim(item) = $3 ORDER BY id LIMIT 1`, [d.orderNumber, d.itemCode, d.productName])
    if (!item.rows[0]) throw badRequest('Choose an item from this order.')
    return { ...d, ...item.rows[0] }
  }
  const d = parse(ncrDataSchema, input)
  const old = previous?.data.kind === 'ncr' ? previous.data : null
  let customer = '', orderNumber = d.orderNumber
  if (orderNumber) {
    if (old?.orderNumber === orderNumber) customer = old.customer
    else {
      const order = await tx.query<QualityOrder>(`SELECT btrim(order_number) AS "orderNumber", btrim(customer) AS customer FROM production_orders
        WHERE deleted_at IS NULL AND lower(btrim(order_number)) = lower($1) ORDER BY id LIMIT 1`, [orderNumber])
      if (!order.rows[0]) throw badRequest('Choose an existing order number.')
      customer = order.rows[0].customer; orderNumber = order.rows[0].orderNumber
    }
  }
  const previousMachines = new Map((old?.machines ?? []).map((m) => [m.id, m]))
  const current = await tx.query<ConcessionMachine>(`SELECT id, code, display_name AS "displayName", btrim(COALESCE(factory, '')) AS factory
    FROM machines WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE`, [d.machineIds])
  const currentMachines = new Map(current.rows.map((m) => [m.id, m]))
  const machines = d.machineIds.map((id) => previousMachines.get(id) ?? currentMachines.get(id))
  if (machines.some((m) => !m)) throw badRequest('Choose an available machine.')
  const snapshots = machines as ConcessionMachine[]
  if (d.factories.length && snapshots.some((m) => !d.factories.includes(m.factory))) throw badRequest('Choose machines from the selected factories.')
  const knownFactories = await tx.query<{ factory: string }>(`SELECT DISTINCT btrim(factory) AS factory FROM machines WHERE deleted_at IS NULL AND factory IS NOT NULL`)
  const allowed = new Set([...knownFactories.rows.map((m) => m.factory), ...(old?.factories ?? [])])
  if (d.factories.some((f) => !allowed.has(f))) throw badRequest('Choose an existing factory.')
  return { ...d, customer, orderNumber, machines: snapshots }
}

async function attachImages(tx: Queryable, recordId: string, ids: string[]) {
  await tx.query('UPDATE quality_record_images SET removed_at = now() WHERE record_id = $1 AND removed_at IS NULL AND NOT (image_id = ANY($2::uuid[]))', [recordId, ids])
  for (const [position, id] of ids.entries()) {
    await tx.query(`INSERT INTO quality_record_images (record_id, image_id, position) VALUES ($1,$2,$3)
      ON CONFLICT (record_id, image_id) DO UPDATE SET position = EXCLUDED.position, removed_at = NULL`, [recordId, id, position])
  }
}

async function nextReference(tx: Queryable, kind: QualityKind, date: string): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const counter = await tx.query<{ n: number }>(`INSERT INTO quality_record_counters (kind, year, last_number) VALUES ($1,$2,1)
      ON CONFLICT (kind, year) DO UPDATE SET last_number = quality_record_counters.last_number + 1 RETURNING last_number AS n`, [kind, Number(date.slice(0, 4))])
    const reference = `${QUALITY_FORMS[kind].prefix}-${date.slice(0, 4)}-${String(counter.rows[0].n).padStart(6, '0')}`
    if (!(await tx.query('SELECT id FROM quality_records WHERE kind = $1 AND lower(reference) = lower($2)', [kind, reference])).rows.length) return reference
  }
  throw badRequest('Enter a report number.')
}

export function qualityRecordsRoutes(ctx: AppContext, kind: QualityKind): Router {
  const r = Router()
  const config = QUALITY_FORMS[kind]
  r.use(requirePermission(config.view))

  r.get('/options', async (_req, res) => {
    const [machines, people, historical] = await Promise.all([
      kind === 'ncr' ? ctx.db.query<ConcessionMachine>(`SELECT id, code, display_name AS "displayName", btrim(COALESCE(factory, '')) AS factory FROM machines WHERE deleted_at IS NULL ORDER BY factory, display_name, id`) : Promise.resolve({ rows: [] as ConcessionMachine[] }),
      ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE is_active AND NOT is_system ORDER BY lower(name), id'),
      kind === 'ncr' ? ctx.db.query<{ factory: string }>(`SELECT DISTINCT jsonb_array_elements_text(data->'factories') AS factory FROM quality_records WHERE kind = $1 AND deleted_at IS NULL`, [kind]) : Promise.resolve({ rows: [] as { factory: string }[] }),
    ])
    const body: QualityRecordOptions = { machines: machines.rows, people: people.rows,
      factories: Array.from(new Set([...machines.rows.map((m) => m.factory), ...historical.rows.map((m) => m.factory)].filter(Boolean))).sort() }
    res.json(body)
  })
  r.get('/orders', async (req, res) => {
    const q = parse(searchSchema, req.query)
    const { rows } = await ctx.db.query<QualityOrder>(`SELECT btrim(order_number) AS "orderNumber", min(btrim(customer)) AS customer FROM production_orders
      WHERE deleted_at IS NULL AND btrim(order_number) <> '' AND order_number ILIKE $1 GROUP BY btrim(order_number) ORDER BY "orderNumber" LIMIT 100`, [contains(q.q)])
    res.json(rows)
  })
  r.get('/items', async (req, res) => {
    const q = parse(searchSchema.extend({ orderNumber: z.string().trim().min(1).max(500) }), req.query)
    const { rows } = await ctx.db.query<QualityItem>(`SELECT DISTINCT btrim(item_code) AS "itemCode", btrim(item) AS item FROM production_orders
      WHERE deleted_at IS NULL AND lower(btrim(order_number)) = lower($1) AND btrim(item) <> '' AND (item ILIKE $2 OR item_code ILIKE $2)
      ORDER BY item, "itemCode" LIMIT 100`, [q.orderNumber, contains(q.q)])
    res.json(rows)
  })
  r.get('/', async (req, res) => {
    const q = parse(listSchema, req.query)
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const params: unknown[] = [kind]
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['q.kind = $1', 'q.deleted_at IS NULL']
    if (q.q) clauses.push(`concat_ws(' ', q.reference, q.data->>'orderNumber', q.data->>'customer', q.data->>'description',
      q.data->>'productName', q.data->>'invoiceNumber', q.data->>'raisedBy', q.data->>'assignedTo', q.data->>'contactPerson',
      q.data->>'rootCause', q.data->>'effectivenessDetails', q.data->>'responsiblePerson', q.data->>'correctiveActions', q.data->>'nonComplianceDetails') ILIKE ${p(contains(q.q))}`)
    if (q.category) {
      const values: readonly string[] = kind === 'ncr' ? NCR_SOURCES : COMPLAINT_ISSUES
      if (!values.includes(q.category)) throw badRequest('Choose an existing category.')
      clauses.push(`q.data @> ${p(JSON.stringify({ [kind === 'ncr' ? 'sources' : 'issues']: [q.category] }))}::jsonb`)
    }
    if (q.factory) clauses.push(`q.data @> ${p(JSON.stringify({ factories: [q.factory] }))}::jsonb`)
    if (q.from) clauses.push(`q.date >= ${p(q.from)}::date`)
    if (q.to) clauses.push(`q.date <= ${p(q.to)}::date`)
    const where = clauses.join(' AND ')
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM quality_records q WHERE ${where}`, params)).rows[0].n
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<QualityRecord>(`SELECT ${SELECT} FROM quality_records q WHERE ${where} ORDER BY q.date DESC, q.created_at DESC, q.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const body: QualityRecordList = { records: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })
  r.get('/:id', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const { rows } = await ctx.db.query<QualityRecord>(`SELECT ${SELECT} FROM quality_records q WHERE q.id = $1 AND q.kind = $2 AND q.deleted_at IS NULL`, [id, kind])
    if (!rows[0]) throw notFound(config.singular)
    res.json(rows[0])
  })
  r.post('/', requirePermission(config.record), async (req, res) => {
    const user = requireUser(req)
    const body = parse(qualitySaveSchema.extend({ submissionId: z.string().uuid() }), req.body)
    const rawData = kind === 'ncr' ? parse(ncrDataSchema, body.data) : parse(complaintDataSchema, body.data)
    const hash = createHash('sha256').update(JSON.stringify({ ...body, data: rawData })).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = (await tx.query<QualityRecord & { hash: string }>(`SELECT ${SELECT}, q.request_hash AS hash FROM quality_records q WHERE q.submission_id = $1`, [body.submissionId])).rows[0]
      if (prior) {
        if (prior.createdById !== user.id || prior.hash !== hash || prior.kind !== kind) throw new HttpError(409, 'conflict', 'This submission was already saved with different values.')
        if (!(await tx.query('SELECT id FROM quality_records WHERE id = $1 AND deleted_at IS NULL', [prior.id])).rows.length) throw notFound(config.singular)
        const { hash: _hash, ...record } = prior
        return { record, created: false }
      }
      const data = await normalise(tx, kind, rawData)
      await assertImagesUsable(tx, body.imageIds)
      if ((await readableImageIds(tx, user, body.imageIds)).size !== body.imageIds.length) throw forbidden('One of these images is not available to you.')
      const reference = body.reference || await nextReference(tx, kind, body.date)
      const inserted = await tx.query<{ id: string }>(`INSERT INTO quality_records (kind, reference, date, data, form, submission_id, request_hash,
        created_by_id, created_by_name, updated_by_id, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9) RETURNING id`,
        [kind, reference, body.date, JSON.stringify(data), JSON.stringify(config.form), body.submissionId, hash, user.id, user.name])
      const id = inserted.rows[0].id
      await attachImages(tx, id, body.imageIds)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: kind === 'ncr' ? 'NCR' : 'CustomerComplaint', entityId: id, orderNumber: data.orderNumber, item: kind === 'customer-complaint' ? (data as { productName: string }).productName : undefined })
      const record = (await tx.query<QualityRecord>(`SELECT ${SELECT} FROM quality_records q WHERE q.id = $1`, [id])).rows[0]
      return { record, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.record)
  })
  r.put('/:id', requirePermission(config.record), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(qualitySaveSchema.extend({ version: z.number().int().min(0) }), req.body)
    const record = await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<QualityRecord>(`SELECT ${SELECT} FROM quality_records q WHERE q.id = $1 AND q.kind = $2 AND q.deleted_at IS NULL FOR UPDATE`, [id, kind])).rows[0]
      if (!old) throw notFound(config.singular)
      if (old.version !== body.version) throw new ConflictError(old)
      const data = await normalise(tx, kind, body.data, old)
      await assertImagesUsable(tx, body.imageIds)
      if ((await readableImageIds(tx, user, body.imageIds)).size !== body.imageIds.length) throw forbidden('One of these images is not available to you.')
      const reference = body.reference || old.reference
      const before: Record<string, unknown> = { ...old.data, reference: old.reference, date: old.date, imageIds: old.imageIds }
      const after: Record<string, unknown> = { ...data, reference, date: body.date, imageIds: body.imageIds }
      // JSONB does not retain object-key order. Equal action objects must
      // not become an audited correction merely because their keys moved.
      for (const key of Object.keys(after)) if (isDeepStrictEqual(before[key], after[key])) { delete before[key]; delete after[key] }
      const changes = await auditChanges(tx, { userId: user.id, userName: user.name, entity: kind === 'ncr' ? 'NCR' : 'CustomerComplaint', entityId: id, orderNumber: data.orderNumber }, before, after)
      if (!changes) return old
      await tx.query(`UPDATE quality_records SET reference = $2, date = $3, data = $4, updated_at = now(), updated_by_id = $5,
        updated_by_name = $6, version = version + 1 WHERE id = $1`, [id, reference, body.date, JSON.stringify(data), user.id, user.name])
      await attachImages(tx, id, body.imageIds)
      return (await tx.query<QualityRecord>(`SELECT ${SELECT} FROM quality_records q WHERE q.id = $1`, [id])).rows[0]
    })
    res.json(record)
  })
  return r
}
