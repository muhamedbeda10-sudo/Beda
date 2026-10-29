import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { MAX_SCRAP_EXPORT, MAX_SCRAP_WEIGHT_KG, type ScrapListResponse, type ScrapMachine, type ScrapOptions, type ScrapPerson, type ScrapRecord, type ScrapType } from '@qc/shared/scrap'
import type { AppContext } from '../context'
import { requireAnyPermission, requirePermission, requireUser, userCan, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { withTransaction, type Queryable } from '../db/pool'
import { badRequest, ConflictError, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { assertImagesUsable } from './images.links'

const text = (max: number) => z.string().trim().min(1).max(max)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01'
}, 'Choose a valid calendar date.')
const fieldsSchema = z.object({
  date: day,
  factory: text(120),
  machineId: z.string().uuid(),
  scrapTypeId: z.string().uuid(),
  // Required and above zero; kept to the gram, as the database stores it.
  weightKg: z.number({ required_error: 'Enter the weight.', invalid_type_error: 'Enter the weight as a number.' })
    .finite().positive('The weight must be above 0.').max(MAX_SCRAP_WEIGHT_KG, 'That weight is too large.')
    .transform((v) => Math.round(v * 1000) / 1000)
    .refine((v) => v > 0, 'The weight must be above 0.'),
  responsiblePerson: z.string().trim().max(200).default(''),
  inspectorId: z.string().uuid(),
  cardImageId: z.string().uuid({ message: 'Attach a photo of the scrap card.' }),
  boxImageId: z.string().uuid({ message: 'Attach a photo of the scrap box.' }),
}).refine((v) => v.cardImageId !== v.boxImageId, { message: 'The scrap card and the scrap box need two different photos.', path: ['boxImageId'] })
const createSchema = z.object({ submissionId: z.string().uuid() }).and(fieldsSchema)
const updateSchema = z.object({ version: z.number().int().min(0) }).and(fieldsSchema)
const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  factory: z.string().trim().max(120).optional(),
  machineId: z.string().uuid().optional(),
  scrapTypeId: z.string().uuid().optional(),
  inspectorId: z.string().uuid().optional(),
  from: day.optional(),
  to: day.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
type Fields = z.infer<typeof fieldsSchema>
/** The list's filters as SQL over scrap_records s. */
function filterClauses(q: z.infer<typeof listSchema>) {
  if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
  const params: unknown[] = []
  const p = (v: unknown) => `$${params.push(v)}`
  const clauses = ['s.deleted_at IS NULL']
  if (q.q) {
    const term = p(contains(q.q))
    clauses.push(`(s.machine_name ILIKE ${term} OR s.machine_code ILIKE ${term} OR s.factory ILIKE ${term} OR s.scrap_type_name ILIKE ${term}
      OR s.inspector_name ILIKE ${term} OR s.responsible_person ILIKE ${term} OR s.created_by_name ILIKE ${term})`)
  }
  if (q.factory) clauses.push(`s.factory = ${p(q.factory)}`)
  if (q.machineId) clauses.push(`s.machine_id = ${p(q.machineId)}::uuid`)
  if (q.scrapTypeId) clauses.push(`s.scrap_type_id = ${p(q.scrapTypeId)}::uuid`)
  if (q.inspectorId) clauses.push(`s.inspector_id = ${p(q.inspectorId)}::uuid`)
  if (q.from) clauses.push(`s.date >= ${p(q.from)}::date`)
  if (q.to) clauses.push(`s.date <= ${p(q.to)}::date`)
  return { where: clauses.join(' AND '), params, p }
}
const contains = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

const SELECT = `s.id, to_char(s.date, 'YYYY-MM-DD') AS date, s.factory, s.machine_id AS "machineId", s.machine_code AS "machineCode",
  s.machine_name AS "machineName", s.scrap_type_id AS "scrapTypeId", s.scrap_type_name AS "scrapTypeName",
  s.weight_kg::float8 AS "weightKg", s.responsible_person AS "responsiblePerson", s.inspector_id AS "inspectorId",
  s.inspector_name AS "inspectorName", s.card_image_id AS "cardImageId", s.box_image_id AS "boxImageId", s.version,
  s.created_at AS "createdAt", s.created_by_id AS "createdById", s.created_by_name AS "createdByName",
  s.updated_at AS "updatedAt", s.updated_by_name AS "updatedByName"`

/** Who may be named as the quality inspector: an active person who records inspections or scrap. */
const INSPECTORS = `SELECT id, name FROM users WHERE is_active AND NOT is_system
  AND (user_has_permission(id, 'record-inspection') OR user_has_permission(id, 'record-scrap'))`

/** What the record shows, for the audit trail's field-by-field changes. */
const auditView = (r: ScrapRecord) => ({
  date: r.date, factory: r.factory, machine: r.machineName, scrapType: r.scrapTypeName, weightKg: r.weightKg,
  responsiblePerson: r.responsiblePerson, inspector: r.inspectorName, cardPhoto: r.cardImageId, boxPhoto: r.boxImageId,
})

/** One's own record with Record scrap, anyone's with Correct anyone's scrap. */
function mayChange(user: AuthUser, record: ScrapRecord): boolean {
  return userCan(user, 'edit-scrap') || (userCan(user, 'record-scrap') && record.createdById === user.id)
}

/** Every choice checked against the register; the names to keep with the record. */
async function resolve(tx: Queryable, user: AuthUser, timeZone: string, body: Fields, selfId: string | null, previous?: ScrapRecord) {
  const machine = await tx.query<ScrapMachine>(`SELECT id, code, display_name AS "displayName", btrim(COALESCE(factory, '')) AS factory
    FROM machines WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [body.machineId])
  const m = machine.rows[0]
  // A correction may keep the machine it was recorded on, even after the machine was retired or moved.
  const kept = previous && previous.machineId === body.machineId && previous.factory === body.factory
  if (!kept) {
    if (!m) throw badRequest('That machine is no longer available. Choose it again.')
    if (m.factory !== body.factory) throw badRequest('Choose a machine from the selected factory.')
  }
  const type = await tx.query<ScrapType>('SELECT id, name FROM scrap_types WHERE id = $1', [body.scrapTypeId])
  if (!type.rows[0]) throw badRequest('Choose an existing scrap type, or add it first.')
  const inspectorKept = previous && previous.inspectorId === body.inspectorId
  const inspector = await tx.query<ScrapPerson>(inspectorKept ? 'SELECT id, name FROM users WHERE id = $1' : `${INSPECTORS} AND id = $1`, [body.inspectorId])
  if (!inspector.rows[0]) throw badRequest('Choose the quality inspector from the list.')
  // Photos: live; a new one taken by this person for this record, and nobody else's evidence. Locked by id, so two
  // saves sending the same photo at the same moment cannot both keep it.
  const photos = [body.cardImageId, body.boxImageId]
  const changed = photos.filter((id) => !previous || (id !== previous.cardImageId && id !== previous.boxImageId))
  await assertImagesUsable(tx, photos)
  for (const id of [...photos].sort()) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [id])
  if (changed.length > 0) {
    const own = await tx.query(`SELECT 1 FROM images WHERE id = ANY($1::uuid[]) AND uploaded_by_id = $2`, [changed, user.id])
    if (own.rows.length !== changed.length) throw forbidden('Take or upload the scrap card and box photos yourself, for this record.')
    const elsewhere = await tx.query(`SELECT 1 FROM unnest($1::uuid[]) AS p (id) WHERE
         EXISTS (SELECT 1 FROM defect_images x WHERE x.image_id = p.id) OR EXISTS (SELECT 1 FROM paint_sample_images x WHERE x.image_id = p.id)
      OR EXISTS (SELECT 1 FROM pt_record_images x WHERE x.image_id = p.id) OR EXISTS (SELECT 1 FROM session_note_images x WHERE x.image_id = p.id)
      OR EXISTS (SELECT 1 FROM pdi_images x WHERE x.image_id = p.id) OR EXISTS (SELECT 1 FROM item_reference_images x WHERE x.image_id = p.id)
      OR EXISTS (SELECT 1 FROM concession_images x WHERE x.image_id = p.id) OR EXISTS (SELECT 1 FROM quality_record_images x WHERE x.image_id = p.id AND x.removed_at IS NULL)
      OR EXISTS (SELECT 1 FROM chat_message_images x WHERE x.image_id = p.id) OR EXISTS (SELECT 1 FROM task_message_images x WHERE x.image_id = p.id)
      OR EXISTS (SELECT 1 FROM notice_images x WHERE x.image_id = p.id) LIMIT 1`, [changed])
    if (elsewhere.rows[0]) throw badRequest('One of these photos belongs to another record. Take a new photo.')
  }
  const used = await tx.query(`SELECT 1 FROM scrap_records WHERE deleted_at IS NULL AND id IS DISTINCT FROM $2::uuid
    AND (card_image_id = ANY($1::uuid[]) OR box_image_id = ANY($1::uuid[])) LIMIT 1`, [photos, selfId])
  if (used.rows[0]) throw badRequest('One of these photos belongs to another scrap record. Take a new photo.')
  // A day ahead of the factory's today is allowed, for a clock or a night shift; more is a mistake.
  const today = await tx.query<{ ok: boolean }>(`SELECT $1::date <= (now() AT TIME ZONE $2)::date + 1 AS ok`, [body.date, timeZone])
  if (!today.rows[0].ok) throw badRequest('The date is in the future.')
  return {
    // A kept machine keeps the names it was recorded with.
    machine: kept ? { id: previous.machineId, code: previous.machineCode, displayName: previous.machineName, factory: previous.factory } : m!,
    type: type.rows[0],
    inspector: inspector.rows[0],
  }
}

async function load(q: Queryable, id: string, lock = false): Promise<ScrapRecord | undefined> {
  const { rows } = await q.query<ScrapRecord>(`SELECT ${SELECT} FROM scrap_records s WHERE s.id = $1 AND s.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id])
  return rows[0]
}

export function scrapRoutes(ctx: AppContext): Router {
  const r = Router()

  // The choices: for the form (Inspections) and for History's filters.
  r.get('/options', requireAnyPermission('view-history', 'record-scrap'), async (_req, res) => {
    const [machines, types, factories, inspectors, responsible, recorded] = await Promise.all([
      ctx.db.query<ScrapMachine>(`SELECT id, code, display_name AS "displayName", btrim(factory) AS factory
        FROM machines WHERE deleted_at IS NULL AND btrim(COALESCE(factory, '')) <> '' ORDER BY btrim(factory), display_name, code, id`),
      ctx.db.query<ScrapType>('SELECT id, name FROM scrap_types ORDER BY lower(name)'),
      // Recorded factories stay in the filter after a machine moves or is retired.
      ctx.db.query<{ name: string }>(`SELECT DISTINCT name FROM (
        SELECT btrim(factory) AS name FROM machines WHERE deleted_at IS NULL
        UNION SELECT factory FROM scrap_records WHERE deleted_at IS NULL
      ) f WHERE name <> '' ORDER BY name`),
      ctx.db.query<ScrapPerson>(`${INSPECTORS} ORDER BY lower(name), id`),
      ctx.db.query<{ name: string }>(`SELECT name FROM (SELECT DISTINCT ON (lower(btrim(responsible_person))) btrim(responsible_person) AS name
        FROM scrap_records WHERE deleted_at IS NULL AND btrim(responsible_person) <> '' ORDER BY lower(btrim(responsible_person)), created_at DESC) p
        ORDER BY lower(name) LIMIT 500`),
      ctx.db.query<ScrapPerson>(`SELECT id, name FROM (SELECT DISTINCT ON (inspector_id) inspector_id AS id, inspector_name AS name
        FROM scrap_records WHERE deleted_at IS NULL ORDER BY inspector_id, created_at DESC) p ORDER BY lower(name), id`),
    ])
    const body: ScrapOptions = {
      machines: machines.rows, types: types.rows, factories: factories.rows.map((f) => f.name),
      inspectors: inspectors.rows, responsiblePeople: responsible.rows.map((p) => p.name), recordedInspectors: recorded.rows,
    }
    res.json(body)
  })

  r.post('/types', requirePermission('record-scrap'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(z.object({ name: text(120) }), req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      const inserted = await tx.query<ScrapType>(`INSERT INTO scrap_types (name) VALUES ($1)
        ON CONFLICT (lower(btrim(name))) DO NOTHING RETURNING id, name`, [body.name])
      if (inserted.rows[0]) {
        const row = inserted.rows[0]
        await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'ScrapType', entityId: row.id, item: row.name })
        return { type: row, created: true }
      }
      const existing = await tx.query<ScrapType>('SELECT id, name FROM scrap_types WHERE lower(btrim(name)) = lower(btrim($1))', [body.name])
      return { type: existing.rows[0], created: false }
    })
    res.status(result.created ? 201 : 200).json(result.type)
  })

  r.get('/', requirePermission('view-history'), async (req, res) => {
    const q = parse(listSchema, req.query)
    const { where, params, p } = filterClauses(q)
    const counted = await ctx.db.query<{ n: number; kg: number }>(`SELECT count(*)::int AS n, COALESCE(sum(s.weight_kg), 0)::float8 AS kg
      FROM scrap_records s WHERE ${where}`, params)
    const limit = p(q.limit)
    const offset = p(q.offset)
    const { rows } = await ctx.db.query<ScrapRecord>(`SELECT ${SELECT} FROM scrap_records s WHERE ${where}
      ORDER BY s.date DESC, s.created_at DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const total = counted.rows[0].n
    const body: ScrapListResponse = { records: rows, total, totalWeightKg: counted.rows[0].kg, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  // Every record the filters match, in one read, for Excel.
  r.get('/export', requirePermission('view-history'), requirePermission('export-records'), async (req, res) => {
    const q = parse(listSchema, req.query)
    const { where, params, p } = filterClauses(q)
    const { rows } = await ctx.db.query<ScrapRecord>(`SELECT ${SELECT} FROM scrap_records s WHERE ${where}
      ORDER BY s.date DESC, s.created_at DESC, s.id DESC LIMIT ${p(MAX_SCRAP_EXPORT)}`, params)
    res.json(rows)
  })

  r.get('/:id', requireAnyPermission('view-history', 'record-scrap'), async (req, res) => {
    const user = requireUser(req)
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const record = await load(ctx.db, id)
    // Without History, one reads only one's own records (the one just saved).
    if (!record || (!userCan(user, 'view-history') && record.createdById !== user.id)) throw notFound('That scrap record')
    res.json(record)
  })

  r.post('/', requirePermission('record-scrap'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      // Concurrent retries wait for the same submission, then read its saved result.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = await tx.query<{ id: string; createdBy: string; hash: string }>(
        `SELECT id, created_by_id AS "createdBy", request_hash AS hash FROM scrap_records WHERE submission_id = $1`, [body.submissionId])
      if (prior.rows[0]) {
        const row = prior.rows[0]
        if (row.createdBy !== user.id || row.hash !== requestHash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values. Open History to check it before recording again.')
        const saved = await load(tx, row.id)
        if (!saved) throw notFound('That scrap record')
        return { record: saved, created: false }
      }
      const { machine, type, inspector } = await resolve(tx, user, ctx.config.FACTORY_TIMEZONE, body, null)
      const inserted = await tx.query<{ id: string }>(`INSERT INTO scrap_records
        (submission_id, request_hash, date, factory, machine_id, machine_code, machine_name, scrap_type_id, scrap_type_name, weight_kg,
         responsible_person, inspector_id, inspector_name, card_image_id, box_image_id, created_by_id, created_by_name, updated_by_id, updated_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$16,$17) RETURNING id`,
        [body.submissionId, requestHash, body.date, body.factory, machine.id, machine.code, machine.displayName, type.id, type.name, body.weightKg,
          body.responsiblePerson, inspector.id, inspector.name, body.cardImageId, body.boxImageId, user.id, user.name])
      const id = inserted.rows[0].id
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'ScrapRecord', entityId: id, item: `${type.name} · ${body.weightKg} kg`, workCenterCode: machine.code })
      return { record: (await load(tx, id))!, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.record)
  })

  r.put('/:id', requireAnyPermission('record-scrap', 'edit-scrap'), async (req, res) => {
    const user = requireUser(req)
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const body = parse(updateSchema, req.body)
    const record = await withTransaction(ctx.db, async (tx) => {
      const old = await load(tx, id, true)
      if (!old) throw notFound('That scrap record')
      if (!mayChange(user, old)) throw forbidden('You can correct only your own scrap records.')
      if (old.version !== body.version) throw new ConflictError(old)
      const { machine, type, inspector } = await resolve(tx, user, ctx.config.FACTORY_TIMEZONE, body, id, old)
      await tx.query(`UPDATE scrap_records SET date = $2, factory = $3, machine_id = $4, machine_code = $5, machine_name = $6,
        scrap_type_id = $7, scrap_type_name = $8, weight_kg = $9, responsible_person = $10, inspector_id = $11, inspector_name = $12,
        card_image_id = $13, box_image_id = $14, updated_at = now(), updated_by_id = $15, updated_by_name = $16, version = version + 1
        WHERE id = $1`,
        [id, body.date, body.factory, machine.id, machine.code, machine.displayName, type.id, type.name, body.weightKg, body.responsiblePerson,
          inspector.id, inspector.name, body.cardImageId, body.boxImageId, user.id, user.name])
      const next = (await load(tx, id))!
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'ScrapRecord', entityId: id, item: `${next.scrapTypeName} · ${next.weightKg} kg`, workCenterCode: next.machineCode }, auditView(old), auditView(next))
      return next
    })
    res.json(record)
  })

  r.delete('/:id', requireAnyPermission('record-scrap', 'edit-scrap'), async (req, res) => {
    const user = requireUser(req)
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const { version } = parse(z.object({ version: z.coerce.number().int().min(0) }), req.query)
    await withTransaction(ctx.db, async (tx) => {
      const old = await load(tx, id, true)
      if (!old) throw notFound('That scrap record')
      if (!mayChange(user, old)) throw forbidden('You can delete only your own scrap records.')
      if (old.version !== version) throw new ConflictError(old)
      await tx.query('UPDATE scrap_records SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'ScrapRecord', entityId: id, item: `${old.scrapTypeName} · ${old.weightKg} kg`, workCenterCode: old.machineCode })
    })
    res.status(204).end()
  })

  return r
}
