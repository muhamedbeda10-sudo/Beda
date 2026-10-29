// ============================================================================
// §27 — Calibration: the instruments' plan, their certificates, scrapping,
// the configuration (categories, departments) and the old workbooks.
//
// The server works out what the forms work out — an instrument's status from
// its next calibration (the database works the date out itself, migration
// 0088), a certificate's errors and verdict (shared/calibration) — so every
// screen, export and the assistant read the same. A certificate moves its
// instrument on (moveItemOn): the latest gives it its last calibration,
// interval, kind and code, each change in the audit log, which is also the
// instrument's history.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import {
  CALIBRATION_IMPORT_CHUNK, CALIBRATION_KINDS, CALIBRATION_PERMISSIONS, CALIBRATION_STATUSES, DUE_SOON_DAYS, EMPTY_REFERENCE, MAX_GROUPS, MAX_INTERVAL_MONTHS, MAX_READINGS,
  calibrationStatus, codeDepartment, daysBetween, judgeCertificate, nameKey, workingDays,
  type CalibrationCategory, type CalibrationCertificate, type CalibrationCounts, type CalibrationDepartment, type CalibrationFile, type CalibrationHistoryEntry,
  type CalibrationImportResult, type CalibrationItem, type CalibrationItemDetail, type CalibrationItemList, type CalibrationOptions, type CalibrationStatus,
  type CertificateGroup,
} from '@qc/shared/calibration'
import { calendarDay } from '@qc/shared/rules'
import type { AppContext } from '../context'
import { requirePermission, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { PG, pgCode, withTransaction, type Queryable } from '../db/pool'
import { badRequest, ConflictError, duplicate, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { buildCalibrationFileStorageKey } from '../images/storage'
import { isPdf } from './workInstructions.routes'
import { qualityDay } from './qualityRecords.schemas'

const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`
const ITEM_COLUMNS = `i.id, i.category_id AS "categoryId", COALESCE(c.name, '') AS "categoryName", i.name, i.device_code AS "deviceCode", i.manufacturer,
  i.device_range AS "range", i.resolution, i.tolerance::float8 AS tolerance, i.unit, i.department_id AS "departmentId", COALESCE(d.name, '') AS "departmentName",
  i.holder, ${day('i.received_on')} AS "receivedOn", i.kind, i.calibration_code AS "calibrationCode", ${day('i.last_calibrated_on')} AS "lastCalibratedOn",
  i.interval_months AS "intervalMonths", ${day('i.next_due_on')} AS "nextDueOn", i.notes, i.scrapped_at AS "scrappedAt", ${day('i.scrapped_on')} AS "scrappedOn",
  i.scrap_reason AS "scrapReason", i.scrap_details AS "scrapDetails", i.scrapped_by_name AS "scrappedByName", i.certificates, i.source, i.version,
  i.created_at AS "createdAt", i.created_by_name AS "createdByName", i.updated_at AS "updatedAt", i.updated_by_name AS "updatedByName"`
const ITEM_FROM = `calibration_items i LEFT JOIN calibration_categories c ON c.id = i.category_id LEFT JOIN calibration_departments d ON d.id = i.department_id`

type ItemRow = Omit<CalibrationItem, 'status' | 'daysLeft' | 'scrap' | 'workingDays'> & {
  scrappedAt: Date | string | null
  scrappedOn: string | null
  scrapReason: string
  scrapDetails: string
  scrappedByName: string
}

/** A row as the screens read it: its status and days left as of the factory's day. */
function shapeItem(r: ItemRow, today: string): CalibrationItem {
  const { scrappedAt, scrappedOn, scrapReason, scrapDetails, scrappedByName, ...rest } = r
  const scrapped = scrappedAt !== null
  return {
    ...rest,
    status: calibrationStatus({ nextDueOn: r.nextDueOn, scrapped }, today),
    daysLeft: r.nextDueOn ? daysBetween(today, r.nextDueOn) : null,
    scrap: scrapped ? { scrappedOn, reason: scrapReason, details: scrapDetails, byName: scrappedByName, at: new Date(scrappedAt).toISOString() } : null,
    workingDays: workingDays(r.receivedOn, scrappedOn),
  }
}

const CERT_COLUMNS = `k.id, k.item_id AS "itemId", k.certificate_no AS "certificateNo", k.kind, ${day('k.calibrated_on')} AS "calibratedOn", k.interval_months AS "intervalMonths",
  ${day('k.next_due_on')} AS "nextDueOn", k.body, k.performed_by AS "performedBy", k.approved_by AS "approvedBy", k.resolution, k.tolerance::float8 AS tolerance, k.unit,
  k.reference, k.groups, k.readings, k.max_error::float8 AS "maxError", k.result, k.file_id AS "fileId", f.file_name AS "fileName", k.notes, k.source, k.version,
  k.created_at AS "createdAt", k.created_by_name AS "createdByName", k.updated_at AS "updatedAt", k.updated_by_name AS "updatedByName",
  json_build_object('name', i.name, 'deviceCode', i.device_code, 'manufacturer', i.manufacturer, 'range', i.device_range, 'calibrationCode', i.calibration_code,
    'departmentName', COALESCE(d.name, ''), 'holder', i.holder) AS item`
const CERT_FROM = `calibration_certificates k JOIN calibration_items i ON i.id = k.item_id LEFT JOIN calibration_departments d ON d.id = i.department_id
  LEFT JOIN calibration_files f ON f.id = k.file_id`

const CATEGORY_SELECT = `id, name, code_prefix AS "codePrefix", interval_months AS "intervalMonths", kind, resolution, tolerance::float8 AS tolerance, unit, template, reference, position`

/** What a status filter reads, as of the factory's day (x.today: LIST_FROM): the same lines as shared/calibration calibrationStatus. */
const STATUS_SQL: Record<CalibrationStatus, string> = {
  scrapped: 'i.scrapped_at IS NOT NULL',
  'no-date': 'i.scrapped_at IS NULL AND i.next_due_on IS NULL',
  overdue: 'i.scrapped_at IS NULL AND i.next_due_on < x.today',
  'due-soon': `i.scrapped_at IS NULL AND i.next_due_on >= x.today AND i.next_due_on <= x.today + ${DUE_SOON_DAYS}`,
  valid: `i.scrapped_at IS NULL AND i.next_due_on > x.today + ${DUE_SOON_DAYS}`,
}
/** The instruments with the day their status is read on ($1). */
const LIST_FROM = `${ITEM_FROM} CROSS JOIN (SELECT $1::date AS today) x`

const contains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const text = (max: number) => z.string().trim().max(max).default('')
const optionalDay = z.union([qualityDay, z.literal('').transform(() => null), z.null()]).default(null)
const months = z.number().int().min(1).max(MAX_INTERVAL_MONTHS)
const tolerance = z.number().finite().min(0).max(1_000_000).nullable().default(null)
const reading = z.number().finite().min(-1_000_000_000).max(1_000_000_000).nullable().default(null)

const itemSchema = z.object({
  categoryId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(200),
  deviceCode: text(120),
  manufacturer: text(120),
  range: text(120),
  resolution: text(60),
  tolerance,
  unit: text(20),
  departmentId: z.string().uuid().nullable().default(null),
  holder: text(200),
  receivedOn: optionalDay,
  kind: z.enum(CALIBRATION_KINDS),
  calibrationCode: text(120),
  lastCalibratedOn: optionalDay,
  intervalMonths: months,
  notes: text(4000),
})
type ItemData = z.infer<typeof itemSchema>

const referenceSchema = z.object({ name: text(200), manufacturer: text(200), serial: text(200), certificateNo: text(200), body: text(200) }).default(EMPTY_REFERENCE)
const groupsSchema = z.array(z.object({
  name: text(120),
  readings: z.array(z.object({ nominal: reading, reading })).max(MAX_READINGS).default([]),
})).max(MAX_GROUPS).default([])
const certificateSchema = z.object({
  itemId: z.string().uuid(),
  certificateNo: text(120),
  kind: z.enum(CALIBRATION_KINDS),
  calibratedOn: qualityDay,
  intervalMonths: months,
  body: text(200),
  performedBy: text(200),
  approvedBy: text(200),
  resolution: text(60),
  tolerance,
  unit: text(20),
  reference: referenceSchema,
  groups: groupsSchema,
  fileId: z.string().uuid().nullable().default(null),
  notes: text(4000),
})
type CertificateData = z.infer<typeof certificateSchema>

const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  codePrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{0,4}$/, 'A prefix is up to four letters (V, MI).').default(''),
  intervalMonths: months,
  kind: z.enum(CALIBRATION_KINDS),
  resolution: text(60),
  tolerance,
  unit: text(20),
  template: z.array(z.object({ name: z.string().trim().min(1).max(120), nominals: z.array(z.number().finite().min(-1e9).max(1e9)).max(MAX_READINGS) })).max(MAX_GROUPS).default([]),
  reference: referenceSchema,
})
const departmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9.]{0,12}$/, 'A code is letters, digits and dots (QC.01).').default(''),
})

const listSchema = z.object({
  q: z.string().trim().max(200).default(''),
  categoryId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  status: z.enum(CALIBRATION_STATUSES).optional(),
  kind: z.enum(CALIBRATION_KINDS).optional(),
  dueFrom: qualityDay.optional(),
  dueTo: qualityDay.optional(),
  view: z.enum(['plan', 'scrap']).default('plan'),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(50),
})

const scrapSchema = z.object({
  scrappedOn: qualityDay,
  reason: z.string().trim().min(1, 'Give the reason.').max(200),
  details: text(4000),
  version: z.number().int().min(0),
})

const registerRowSchema = z.object({
  department: text(120),
  name: z.string().trim().min(1).max(200),
  deviceCode: text(120),
  holder: text(200),
  receivedOn: optionalDay,
  kind: z.enum(CALIBRATION_KINDS),
  calibrationCode: text(120),
  lastCalibratedOn: optionalDay,
  intervalMonths: months,
  scrapped: z.boolean(),
  notes: text(4000),
})
const certificateLogRowSchema = z.object({
  calibrationCode: z.string().trim().min(1).max(120),
  name: text(200),
  manufacturer: text(120),
  range: text(120),
  resolution: text(60),
  calibratedOn: qualityDay,
  intervalMonths: months,
  groups: groupsSchema,
})
const scrapLogRowSchema = z.object({
  department: text(120),
  name: z.string().trim().min(1).max(200),
  holder: text(200),
  receivedOn: optionalDay,
  scrappedOn: qualityDay,
})
const importSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('register'), rows: z.array(registerRowSchema).min(1).max(CALIBRATION_IMPORT_CHUNK) }),
  z.object({ kind: z.literal('certificates'), rows: z.array(certificateLogRowSchema).min(1).max(CALIBRATION_IMPORT_CHUNK) }),
  z.object({ kind: z.literal('scrap'), rows: z.array(scrapLogRowSchema).min(1).max(CALIBRATION_IMPORT_CHUNK) }),
])

/** A stable id for an imported row: importing the same workbook again adds nothing twice. */
const importId = (kind: string, ...parts: (string | number | null)[]) =>
  createHash('sha256').update(`calibration-${kind}:${parts.map((p) => String(p ?? '').toLowerCase()).join('|')}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')

/** Readings with something in them, in groups with something in them. */
function cleanGroups(groups: CertificateGroup[]): CertificateGroup[] {
  return groups
    .map((g) => ({ name: g.name, readings: g.readings.filter((r) => r.nominal !== null || r.reading !== null) }))
    .filter((g) => g.readings.length > 0)
}

/** The instrument's own columns, in the order of ITEM_WRITE. */
const itemValues = (d: ItemData) => [d.categoryId, d.name, d.deviceCode, d.manufacturer, d.range, d.resolution, d.tolerance, d.unit || 'mm', d.departmentId, d.holder, d.receivedOn,
  d.kind, d.calibrationCode, d.lastCalibratedOn, d.intervalMonths, d.notes]
const ITEM_WRITE = `category_id, name, device_code, manufacturer, device_range, resolution, tolerance, unit, department_id, holder, received_on, kind, calibration_code,
  last_calibrated_on, interval_months, notes`
const ITEM_WRITE_COUNT = ITEM_WRITE.split(',').length

const CERT_WRITE = `certificate_no, kind, calibrated_on, interval_months, body, performed_by, approved_by, resolution, tolerance, unit, reference, groups, readings, max_error, result,
  file_id, notes`
const CERT_WRITE_COUNT = CERT_WRITE.split(',').length
function certValues(d: CertificateData, certificateNo: string): unknown[] {
  const groups = cleanGroups(d.groups)
  const j = judgeCertificate(groups, d.tolerance)
  return [certificateNo, d.kind, d.calibratedOn, d.intervalMonths, d.body, d.performedBy, d.approvedBy, d.resolution, d.tolerance, d.unit || 'mm', JSON.stringify(d.reference),
    JSON.stringify(groups), j.readings, j.maxError, j.result, d.fileId, d.notes]
}

/** An instrument as the audit log compares it. */
const itemAudit = (d: ItemData & { categoryName?: string; departmentName?: string }) => ({
  category: d.categoryName ?? d.categoryId ?? '', name: d.name, deviceCode: d.deviceCode, manufacturer: d.manufacturer, range: d.range, resolution: d.resolution,
  tolerance: d.tolerance, unit: d.unit, department: d.departmentName ?? d.departmentId ?? '', holder: d.holder, receivedOn: d.receivedOn ?? '', kind: d.kind,
  calibrationCode: d.calibrationCode, lastCalibratedOn: d.lastCalibratedOn ?? '', intervalMonths: d.intervalMonths, notes: d.notes,
})
const certAudit = (d: CertificateData) => ({
  certificateNo: d.certificateNo, kind: d.kind, calibratedOn: d.calibratedOn, intervalMonths: d.intervalMonths, body: d.body, performedBy: d.performedBy, approvedBy: d.approvedBy,
  resolution: d.resolution, tolerance: d.tolerance, unit: d.unit,
  reference: [d.reference.name, d.reference.manufacturer, d.reference.serial, d.reference.certificateNo, d.reference.body].filter(Boolean).join(' · '),
  readings: cleanGroups(d.groups).map((g) => `${g.name}: ${g.readings.map((r) => `${r.nominal ?? ''}→${r.reading ?? ''}`).join(', ')}`).join('; '),
  fileId: d.fileId ?? '', notes: d.notes,
})

/** Drops what did not change from two audit shapes. */
function onlyChanged(before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const key of Object.keys(after)) if (isDeepStrictEqual(before[key], after[key])) { delete before[key]; delete after[key] }
}

const codeTaken = (code: string) => duplicate(`Another instrument in use has the calibration code ${code}. Choose another code, or scrap that instrument first.`)

async function assertConfig(tx: Queryable, d: { categoryId: string | null; departmentId: string | null }) {
  if (d.categoryId && !(await tx.query('SELECT 1 FROM calibration_categories WHERE id = $1 AND deleted_at IS NULL', [d.categoryId])).rows.length) throw badRequest('That category is no longer in the configuration.')
  if (d.departmentId && !(await tx.query('SELECT 1 FROM calibration_departments WHERE id = $1 AND deleted_at IS NULL', [d.departmentId])).rows.length) throw badRequest('That department is no longer in the configuration.')
}

/** Names for the audit log: the category's and the department's, not their ids. */
async function configNames(tx: Queryable, d: { categoryId: string | null; departmentId: string | null }) {
  const { rows } = await tx.query<{ c: string | null; d: string | null }>(`SELECT (SELECT name FROM calibration_categories WHERE id = $1) AS c, (SELECT name FROM calibration_departments WHERE id = $2) AS d`,
    [d.categoryId, d.departmentId])
  return { categoryName: rows[0].c ?? '', departmentName: rows[0].d ?? '' }
}

export function calibrationRoutes(ctx: AppContext): Router {
  const r = Router()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_DOCUMENT_BYTES, files: 1, fields: 5 } })
  const today = () => calendarDay(new Date(), ctx.config.FACTORY_TIMEZONE)
  r.use(requirePermission(CALIBRATION_PERMISSIONS.view))

  async function readItem(q: Queryable, id: string): Promise<CalibrationItem | undefined> {
    const row = (await q.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = $1 AND i.deleted_at IS NULL`, [id])).rows[0]
    return row && shapeItem(row, today())
  }
  async function readCertificate(q: Queryable, id: string): Promise<CalibrationCertificate | undefined> {
    return (await q.query<CalibrationCertificate>(`SELECT ${CERT_COLUMNS} FROM ${CERT_FROM} WHERE k.id = $1 AND k.deleted_at IS NULL AND i.deleted_at IS NULL`, [id])).rows[0]
  }

  /**
   * The latest certificate moves its instrument on: its day, interval, kind and number become the instrument's
   * last calibration, interval, kind and calibration code — unless the instrument's own last calibration is later
   * (an older certificate entered afterwards), or `removed` was the certificate that set it.
   */
  async function moveItemOn(tx: Queryable, itemId: string, user: { id: string; name: string }, removed?: string) {
    const item = (await tx.query<{ last: string | null; interval: number; kind: string; code: string; name: string }>(`SELECT ${day('last_calibrated_on')} AS last,
      interval_months AS interval, kind, calibration_code AS code, name FROM calibration_items WHERE id = $1 FOR UPDATE`, [itemId])).rows[0]
    const latest = (await tx.query<{ day: string; interval: number; kind: string; no: string }>(`SELECT ${day('calibrated_on')} AS day, interval_months AS interval, kind,
      certificate_no AS no FROM calibration_certificates WHERE item_id = $1 AND deleted_at IS NULL ORDER BY calibrated_on DESC, created_at DESC LIMIT 1`, [itemId])).rows[0]
    if (!item || !latest) return
    if (item.last && latest.day < item.last && removed !== item.last) return
    const before = { lastCalibratedOn: item.last ?? '', intervalMonths: item.interval, kind: item.kind, calibrationCode: item.code }
    const after = { lastCalibratedOn: latest.day, intervalMonths: latest.interval, kind: latest.kind, calibrationCode: latest.no || item.code }
    onlyChanged(before, after)
    if (!Object.keys(after).length) return
    const next = { lastCalibratedOn: latest.day, intervalMonths: latest.interval, kind: latest.kind, calibrationCode: latest.no || item.code }
    try {
      await tx.query(`UPDATE calibration_items SET last_calibrated_on = $2, interval_months = $3, kind = $4, calibration_code = $5, updated_at = now(), updated_by_id = $6,
        updated_by_name = $7, version = version + 1 WHERE id = $1`, [itemId, next.lastCalibratedOn, next.intervalMonths, next.kind, next.calibrationCode, user.id, user.name])
    } catch (e) {
      if (pgCode(e) === PG.UNIQUE_VIOLATION) throw codeTaken(next.calibrationCode)
      throw e
    }
    await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: itemId, item: item.name }, before, after)
  }

  r.get('/options', async (_req, res) => {
    const [categories, departments, number, holders] = await Promise.all([
      ctx.db.query<CalibrationCategory>(`SELECT ${CATEGORY_SELECT} FROM calibration_categories WHERE deleted_at IS NULL ORDER BY position, lower(name)`),
      ctx.db.query<CalibrationDepartment>(`SELECT id, name, code, position FROM calibration_departments WHERE deleted_at IS NULL ORDER BY position, lower(name)`),
      ctx.db.query<{ n: number | null }>(`SELECT max((substring(calibration_code FROM '^\\s*[A-Za-z]{1,4}[.\\-]([0-9]{1,5})[.\\-]'))::int) AS n FROM calibration_items WHERE deleted_at IS NULL`),
      ctx.db.query<{ holder: string }>(`SELECT holder FROM calibration_items WHERE deleted_at IS NULL AND scrapped_at IS NULL AND btrim(holder) <> '' GROUP BY holder ORDER BY holder LIMIT 1000`),
    ])
    const body: CalibrationOptions = {
      categories: categories.rows,
      departments: departments.rows,
      nextCodeNumber: (number.rows[0].n ?? 0) + 1,
      holders: holders.rows.map((h) => h.holder),
      today: today(),
    }
    res.json(body)
  })

  // ---- Instruments -----------------------------------------------------------------------

  r.get('/items', async (req, res) => {
    const q = parse(listSchema, req.query)
    if (q.dueFrom && q.dueTo && q.dueFrom > q.dueTo) throw badRequest('The range ends before it starts.')
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    p(today())
    const clauses = ['i.deleted_at IS NULL']
    if (q.q) clauses.push(`concat_ws(' ', i.name, i.device_code, i.calibration_code, i.holder, i.manufacturer, i.device_range, i.notes, i.scrap_reason, c.name, d.name) ILIKE ${p(contains(q.q))}`)
    if (q.categoryId) clauses.push(`i.category_id = ${p(q.categoryId)}`)
    if (q.departmentId) clauses.push(`i.department_id = ${p(q.departmentId)}`)
    if (q.kind) clauses.push(`i.kind = ${p(q.kind)}`)
    if (q.dueFrom) clauses.push(`i.next_due_on >= ${p(q.dueFrom)}::date`)
    if (q.dueTo) clauses.push(`i.next_due_on <= ${p(q.dueTo)}::date`)
    const base = clauses.join(' AND ')
    // The cards count every status under the other filters; the list takes the status (the scrap log: scrapped alone).
    const status: CalibrationStatus | undefined = q.view === 'scrap' ? 'scrapped' : q.status
    const where = status ? `${base} AND ${STATUS_SQL[status]}` : q.view === 'plan' ? `${base} AND i.scrapped_at IS NULL` : base
    const counted = await ctx.db.query<CalibrationCounts>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE i.scrapped_at IS NULL)::int AS "inService",
      ${CALIBRATION_STATUSES.map((s) => `count(*) FILTER (WHERE ${STATUS_SQL[s]})::int AS "${s}"`).join(', ')}
      FROM ${LIST_FROM} WHERE ${base}`, params)
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${LIST_FROM} WHERE ${where}`, params)).rows[0].n
    const order = q.view === 'scrap' ? 'i.scrapped_on DESC NULLS LAST, i.scrapped_at DESC, i.id' : 'i.next_due_on ASC NULLS LAST, lower(i.name), i.calibration_code, i.id'
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${LIST_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params)
    const now = today()
    const body: CalibrationItemList = { items: rows.map((row) => shapeItem(row, now)), total, hasMore: q.offset + rows.length < total, counts: counted.rows[0] }
    res.json(body)
  })

  r.get('/items/:id', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const item = await readItem(ctx.db, id)
    if (!item) throw notFound('Instrument')
    const [certificates, history] = await Promise.all([
      ctx.db.query<CalibrationCertificate>(`SELECT ${CERT_COLUMNS} FROM ${CERT_FROM} WHERE k.item_id = $1 AND k.deleted_at IS NULL ORDER BY k.calibrated_on DESC, k.created_at DESC`, [id]),
      ctx.db.query<CalibrationHistoryEntry>(`SELECT a.at, a.user_name AS "userName", a.action, a.entity, a.field, a.old_value AS "oldValue", a.new_value AS "newValue", a.item
        FROM audit_log a WHERE a.deleted_at IS NULL AND ((a.entity = 'CalibrationItem' AND a.entity_id = $1::text)
          OR (a.entity = 'CalibrationCertificate' AND a.entity_id IN (SELECT id::text FROM calibration_certificates WHERE item_id = $1::uuid)))
        ORDER BY a.at DESC, a.id DESC LIMIT 300`, [id]),
    ])
    const body: CalibrationItemDetail = { item, certificates: certificates.rows, history: history.rows }
    res.json(body)
  })

  r.post('/items', requirePermission(CALIBRATION_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const body = parse(itemSchema.extend({ submissionId: z.string().uuid() }), req.body)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = (await tx.query<{ id: string; hash: string; by: string; deleted: boolean }>(`SELECT id, request_hash AS hash, created_by_id AS by, deleted_at IS NOT NULL AS deleted
        FROM calibration_items WHERE submission_id = $1`, [body.submissionId])).rows[0]
      if (prior) {
        if (prior.by !== user.id || prior.hash !== hash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values.')
        if (prior.deleted) throw notFound('Instrument')
        return { item: (await readItem(tx, prior.id))!, created: false }
      }
      await assertConfig(tx, body)
      const values = itemValues(body)
      let id: string
      try {
        id = (await tx.query<{ id: string }>(`INSERT INTO calibration_items (${ITEM_WRITE}, submission_id, request_hash, created_by_id, created_by_name, updated_by_id, updated_by_name)
          VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}, $${ITEM_WRITE_COUNT + 1}, $${ITEM_WRITE_COUNT + 2}, $${ITEM_WRITE_COUNT + 3}, $${ITEM_WRITE_COUNT + 4},
            $${ITEM_WRITE_COUNT + 3}, $${ITEM_WRITE_COUNT + 4}) RETURNING id`, [...values, body.submissionId, hash, user.id, user.name])).rows[0].id
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw codeTaken(body.calibrationCode)
        throw e
      }
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: id, item: `${body.calibrationCode} ${body.name}`.trim() })
      return { item: (await readItem(tx, id))!, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.item)
  })

  r.put('/items/:id', requirePermission(CALIBRATION_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(itemSchema.extend({ version: z.number().int().min(0) }), req.body)
    const item = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM calibration_items WHERE id = $1 FOR UPDATE', [id])
      const old = await readItem(tx, id)
      if (!old) throw notFound('Instrument')
      if (old.version !== body.version) throw new ConflictError(old)
      await assertConfig(tx, body)
      const before = itemAudit(old)
      const after = itemAudit({ ...body, ...(await configNames(tx, body)) })
      onlyChanged(before, after)
      if (!Object.keys(after).length) return old
      const values = itemValues(body)
      try {
        await tx.query(`UPDATE calibration_items SET (${ITEM_WRITE}) = (${values.map((_, i) => `$${i + 2}`).join(', ')}), updated_at = now(), updated_by_id = $${ITEM_WRITE_COUNT + 2},
          updated_by_name = $${ITEM_WRITE_COUNT + 3}, version = version + 1 WHERE id = $1`, [id, ...values, user.id, user.name])
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw codeTaken(body.calibrationCode)
        throw e
      }
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: id, item: `${body.calibrationCode} ${body.name}`.trim() }, before, after)
      return (await readItem(tx, id))!
    })
    res.json(item)
  })

  /** Takes an instrument out of use (F-Q-05-03): the day, why, and the details; the audit log keeps who and when. */
  r.post('/items/:id/scrap', requirePermission(CALIBRATION_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(scrapSchema, req.body)
    const item = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM calibration_items WHERE id = $1 FOR UPDATE', [id])
      const old = await readItem(tx, id)
      if (!old) throw notFound('Instrument')
      if (old.version !== body.version) throw new ConflictError(old)
      if (old.scrap) throw badRequest('This instrument is already scrapped.')
      if (body.scrappedOn > today()) throw badRequest('The scrapping day is still to come.')
      if (old.receivedOn && body.scrappedOn < old.receivedOn) throw badRequest('The scrapping day is before the instrument was received.')
      await tx.query(`UPDATE calibration_items SET scrapped_at = now(), scrapped_on = $2, scrap_reason = $3, scrap_details = $4, scrapped_by_id = $5, scrapped_by_name = $6,
        updated_at = now(), updated_by_id = $5, updated_by_name = $6, version = version + 1 WHERE id = $1`, [id, body.scrappedOn, body.reason, body.details, user.id, user.name])
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: id, item: `${old.calibrationCode} ${old.name}`.trim() },
        { status: 'In service', scrappedOn: '', scrapReason: '', scrapDetails: '' }, { status: 'Scrapped', scrappedOn: body.scrappedOn, scrapReason: body.reason, scrapDetails: body.details })
      return (await readItem(tx, id))!
    })
    res.json(item)
  })

  /** Back into use, a scrapping recorded by mistake: whoever sets calibration up. */
  r.post('/items/:id/restore', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { version } = parse(z.object({ version: z.number().int().min(0) }), req.body)
    const item = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM calibration_items WHERE id = $1 FOR UPDATE', [id])
      const old = await readItem(tx, id)
      if (!old) throw notFound('Instrument')
      if (old.version !== version) throw new ConflictError(old)
      if (!old.scrap) throw badRequest('This instrument is in use.')
      try {
        await tx.query(`UPDATE calibration_items SET scrapped_at = NULL, scrapped_on = NULL, scrap_reason = '', scrap_details = '', scrapped_by_id = NULL, scrapped_by_name = '',
          updated_at = now(), updated_by_id = $2, updated_by_name = $3, version = version + 1 WHERE id = $1`, [id, user.id, user.name])
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw codeTaken(old.calibrationCode)
        throw e
      }
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: id, item: `${old.calibrationCode} ${old.name}`.trim() },
        { status: 'Scrapped', scrappedOn: old.scrap.scrappedOn ?? '', scrapReason: old.scrap.reason, scrapDetails: old.scrap.details },
        { status: 'In service', scrappedOn: '', scrapReason: '', scrapDetails: '' })
      return (await readItem(tx, id))!
    })
    res.json(item)
  })

  /** An instrument entered by mistake: whoever sets calibration up. Its certificates go with it. */
  r.delete('/items/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ name: string; code: string }>(`SELECT name, calibration_code AS code FROM calibration_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Instrument')
      await tx.query('UPDATE calibration_items SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: id, item: `${old.code} ${old.name}`.trim() })
    })
    res.status(204).end()
  })

  // ---- Certificates -------------------------------------------------------------------------

  r.get('/certificates/:id', async (req, res) => {
    const cert = await readCertificate(ctx.db, parse(z.string().uuid(), req.params.id))
    if (!cert) throw notFound('Certificate')
    res.json(cert)
  })

  /** A PDF may go on a certificate when its uploader saves it, or when it is already on that certificate. */
  async function assertFile(tx: Queryable, fileId: string | null, userId: string, current?: string | null) {
    if (!fileId || fileId === current) return
    const f = (await tx.query<{ by: string }>('SELECT uploaded_by_id AS by FROM calibration_files WHERE id = $1', [fileId])).rows[0]
    if (!f) throw badRequest('The certificate’s PDF was not found. Attach it again.')
    if (f.by !== userId) throw forbidden('That PDF is not available to you.')
  }

  r.post('/certificates', requirePermission(CALIBRATION_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const body = parse(certificateSchema.extend({ submissionId: z.string().uuid() }), req.body)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = (await tx.query<{ id: string; hash: string; by: string; deleted: boolean }>(`SELECT id, request_hash AS hash, created_by_id AS by, deleted_at IS NOT NULL AS deleted
        FROM calibration_certificates WHERE submission_id = $1`, [body.submissionId])).rows[0]
      if (prior) {
        if (prior.by !== user.id || prior.hash !== hash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values.')
        if (prior.deleted) throw notFound('Certificate')
        return { cert: (await readCertificate(tx, prior.id))!, created: false }
      }
      const item = (await tx.query<{ code: string; name: string }>(`SELECT calibration_code AS code, name FROM calibration_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [body.itemId])).rows[0]
      if (!item) throw notFound('Instrument')
      await assertFile(tx, body.fileId, user.id)
      const certificateNo = body.certificateNo || item.code
      const values = certValues(body, certificateNo)
      const id = (await tx.query<{ id: string }>(`INSERT INTO calibration_certificates (item_id, ${CERT_WRITE}, submission_id, request_hash, created_by_id, created_by_name, updated_by_id, updated_by_name)
        VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(', ')}, $${CERT_WRITE_COUNT + 2}, $${CERT_WRITE_COUNT + 3}, $${CERT_WRITE_COUNT + 4}, $${CERT_WRITE_COUNT + 5},
          $${CERT_WRITE_COUNT + 4}, $${CERT_WRITE_COUNT + 5}) RETURNING id`, [body.itemId, ...values, body.submissionId, hash, user.id, user.name])).rows[0].id
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCertificate', entityId: id, item: `${certificateNo} ${item.name}`.trim() })
      await moveItemOn(tx, body.itemId, user)
      return { cert: (await readCertificate(tx, id))!, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.cert)
  })

  r.put('/certificates/:id', requirePermission(CALIBRATION_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(certificateSchema.extend({ version: z.number().int().min(0) }), req.body)
    const cert = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM calibration_certificates WHERE id = $1 FOR UPDATE', [id])
      const old = await readCertificate(tx, id)
      if (!old) throw notFound('Certificate')
      if (old.version !== body.version) throw new ConflictError(old)
      if (old.itemId !== body.itemId) throw badRequest('A certificate stays with its instrument.')
      await assertFile(tx, body.fileId, user.id, old.fileId)
      const certificateNo = body.certificateNo || old.item.calibrationCode
      const before = certAudit(old)
      const after = certAudit({ ...body, certificateNo })
      onlyChanged(before, after)
      if (!Object.keys(after).length) return old
      const values = certValues(body, certificateNo)
      await tx.query(`UPDATE calibration_certificates SET (${CERT_WRITE}) = (${values.map((_, i) => `$${i + 2}`).join(', ')}), updated_at = now(),
        updated_by_id = $${CERT_WRITE_COUNT + 2}, updated_by_name = $${CERT_WRITE_COUNT + 3}, version = version + 1 WHERE id = $1`, [id, ...values, user.id, user.name])
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCertificate', entityId: id, item: `${certificateNo} ${old.item.name}`.trim() }, before, after)
      await moveItemOn(tx, body.itemId, user, old.calibratedOn !== body.calibratedOn ? old.calibratedOn : undefined)
      return (await readCertificate(tx, id))!
    })
    res.json(cert)
  })

  r.delete('/certificates/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ itemId: string; no: string; day: string }>(`SELECT item_id AS "itemId", certificate_no AS no, ${day('calibrated_on')} AS day
        FROM calibration_certificates WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Certificate')
      await tx.query('UPDATE calibration_certificates SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCertificate', entityId: id, item: old.no })
      await moveItemOn(tx, old.itemId, user, old.day)
    })
    res.status(204).end()
  })

  // ---- The outside laboratories' PDFs ----------------------------------------------------------

  r.post('/files', requirePermission(CALIBRATION_PERMISSIONS.record), upload.single('file'), async (req, res) => {
    const user = requireUser(req)
    if (!req.file) throw badRequest('Attach the PDF as the "file" field.')
    if (!isPdf(req.file.buffer)) throw badRequest('Only PDF files are accepted.')
    const id = randomUUID()
    const key = buildCalibrationFileStorageKey(id)
    const fileName = (req.file.originalname || 'certificate.pdf').slice(0, 255)
    await ctx.images.put(key, req.file.buffer, 'application/pdf')
    try {
      await ctx.db.query(`INSERT INTO calibration_files (id, storage_key, driver, file_name, byte_size, sha256, uploaded_by_id, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, key, ctx.images.driver, fileName, req.file.buffer.length, createHash('sha256').update(req.file.buffer).digest('hex'), user.id, user.name])
    } catch (e) {
      await ctx.images.remove(key).catch(() => undefined)
      throw e
    }
    const body: CalibrationFile = { id, fileName, byteSize: req.file.buffer.length }
    res.status(201).json(body)
  })

  r.get('/files/:id/content', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const meta = (await ctx.db.query<{ storageKey: string; byteSize: number; sha256: string; fileName: string }>(`SELECT storage_key AS "storageKey", byte_size AS "byteSize", sha256,
      file_name AS "fileName" FROM calibration_files WHERE id = $1`, [id])).rows[0]
    if (!meta) throw notFound('That file')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()
    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The file bytes are missing from storage. The metadata and hash are still on record.')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${meta.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[calibration] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  // ---- Configuration ------------------------------------------------------------------------

  r.post('/categories', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const c = parse(categorySchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const inserted = (await tx.query<CalibrationCategory>(`INSERT INTO calibration_categories (name, code_prefix, interval_months, kind, resolution, tolerance, unit, template, reference,
        position, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT max(position) + 1 FROM calibration_categories WHERE deleted_at IS NULL), 1), $10)
        ON CONFLICT DO NOTHING RETURNING ${CATEGORY_SELECT}`,
      [c.name, c.codePrefix, c.intervalMonths, c.kind, c.resolution, c.tolerance, c.unit, JSON.stringify(c.template), JSON.stringify(c.reference), user.name])).rows[0]
      if (!inserted) throw duplicate(`${c.name} is already a category.`)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCategory', entityId: inserted.id, item: c.name })
      return inserted
    })
    res.status(201).json(row)
  })

  r.put('/categories/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const c = parse(categorySchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<CalibrationCategory>(`SELECT ${CATEGORY_SELECT} FROM calibration_categories WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Category')
      const { id: _id, position: _p, ...before } = old
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCategory', entityId: id, item: c.name },
        { ...before, template: JSON.stringify(before.template), reference: JSON.stringify(before.reference) }, { ...c, template: JSON.stringify(c.template), reference: JSON.stringify(c.reference) })
      try {
        return (await tx.query<CalibrationCategory>(`UPDATE calibration_categories SET name = $2, code_prefix = $3, interval_months = $4, kind = $5, resolution = $6, tolerance = $7, unit = $8,
          template = $9, reference = $10, updated_at = now(), updated_by_name = $11 WHERE id = $1 RETURNING ${CATEGORY_SELECT}`,
        [id, c.name, c.codePrefix, c.intervalMonths, c.kind, c.resolution, c.tolerance, c.unit, JSON.stringify(c.template), JSON.stringify(c.reference), user.name])).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`${c.name} is already a category.`)
        throw e
      }
    })
    res.json(row)
  })

  r.delete('/categories/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const used = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM calibration_items WHERE category_id = $1 AND deleted_at IS NULL AND scrapped_at IS NULL', [id])).rows[0].n
      if (used) throw badRequest(`${used} instrument${used === 1 ? ' is' : 's are'} of this category: move them to another first.`)
      const old = (await tx.query<{ name: string }>('UPDATE calibration_categories SET deleted_at = now(), updated_by_name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING name', [id, user.name])).rows[0]
      if (!old) throw notFound('Category')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'CalibrationCategory', entityId: id, item: old.name })
    })
    res.status(204).end()
  })

  r.post('/departments', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const d = parse(departmentSchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const inserted = (await tx.query<CalibrationDepartment>(`INSERT INTO calibration_departments (name, code, position)
        VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM calibration_departments WHERE deleted_at IS NULL), 1)) ON CONFLICT DO NOTHING RETURNING id, name, code, position`, [d.name, d.code])).rows[0]
      if (!inserted) throw duplicate(`${d.name} is already a department.`)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'CalibrationDepartment', entityId: inserted.id, item: d.name })
      return inserted
    })
    res.status(201).json(row)
  })

  r.put('/departments/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const d = parse(departmentSchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<CalibrationDepartment>('SELECT id, name, code, position FROM calibration_departments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
      if (!old) throw notFound('Department')
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationDepartment', entityId: id, item: d.name }, { name: old.name, code: old.code }, d)
      try {
        return (await tx.query<CalibrationDepartment>('UPDATE calibration_departments SET name = $2, code = $3 WHERE id = $1 RETURNING id, name, code, position', [id, d.name, d.code])).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`${d.name} is already a department.`)
        throw e
      }
    })
    res.json(row)
  })

  r.delete('/departments/:id', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const used = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM calibration_items WHERE department_id = $1 AND deleted_at IS NULL AND scrapped_at IS NULL', [id])).rows[0].n
      if (used) throw badRequest(`${used} instrument${used === 1 ? ' is' : 's are'} held in this department: move them to another first.`)
      const old = (await tx.query<{ name: string }>('UPDATE calibration_departments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING name', [id])).rows[0]
      if (!old) throw notFound('Department')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'CalibrationDepartment', entityId: id, item: old.name })
    })
    res.status(204).end()
  })

  // ---- The old workbooks ------------------------------------------------------------------------

  /**
   * The register (F-Q-05-01), the certificates log and the scrap form (F-Q-05-03), read on the client
   * (shared/calibration parse…) and sent in chunks. Importing a workbook again adds only what is new: each row
   * has a stable id, and an instrument in use is known by its calibration code.
   */
  r.post('/import', requirePermission(CALIBRATION_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const body = parse(importSchema, req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      // One import at a time: two never add the same instrument or department twice.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('calibration-import', 0))`)
      const out: CalibrationImportResult = { created: 0, updated: 0, existing: 0, unmatched: 0 }
      const departments = new Map((await tx.query<{ id: string; name: string; code: string }>(`SELECT id, name, code FROM calibration_departments WHERE deleted_at IS NULL`)).rows
        .map((d) => [nameKey(d.name), d]))
      const categories = (await tx.query<CalibrationCategory>(`SELECT ${CATEGORY_SELECT} FROM calibration_categories WHERE deleted_at IS NULL ORDER BY position`)).rows
      async function department(name: string): Promise<string | null> {
        const key = nameKey(name)
        if (!key) return null
        const found = departments.get(key)
        if (found) return found.id
        const row = (await tx.query<{ id: string; name: string; code: string }>(`INSERT INTO calibration_departments (name, position)
          VALUES ($1, COALESCE((SELECT max(position) + 1 FROM calibration_departments WHERE deleted_at IS NULL), 1)) RETURNING id, name, code`, [name.slice(0, 120)])).rows[0]
        departments.set(key, row)
        return row.id
      }
      const insertItem = async (d: ItemData, submissionId: string, scrap: { on: string | null; reason: string } | null) => {
        const values = itemValues(d)
        return (await tx.query<{ id: string }>(`INSERT INTO calibration_items (${ITEM_WRITE}, source, submission_id, request_hash, created_by_id, created_by_name, updated_by_id,
          updated_by_name, scrapped_at, scrapped_on, scrap_reason, scrapped_by_id, scrapped_by_name)
          VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}, 'import', $${ITEM_WRITE_COUNT + 1}, 'import', $${ITEM_WRITE_COUNT + 2}, $${ITEM_WRITE_COUNT + 3},
            $${ITEM_WRITE_COUNT + 2}, $${ITEM_WRITE_COUNT + 3}, CASE WHEN $${ITEM_WRITE_COUNT + 4}::boolean THEN now() END, $${ITEM_WRITE_COUNT + 5}::date, $${ITEM_WRITE_COUNT + 6},
            CASE WHEN $${ITEM_WRITE_COUNT + 4}::boolean THEN $${ITEM_WRITE_COUNT + 2}::uuid END, CASE WHEN $${ITEM_WRITE_COUNT + 4}::boolean THEN $${ITEM_WRITE_COUNT + 3} ELSE '' END)
          ON CONFLICT (submission_id) DO NOTHING RETURNING id`,
        [...values, submissionId, user.id, user.name, !!scrap, scrap?.on ?? null, scrap?.reason ?? ''])).rows[0]?.id
      }

      if (body.kind === 'register') {
        const codesByDepartment = new Map<string, Map<string, number>>()
        for (const row of body.rows) {
          const code = row.calibrationCode
          if (code && !row.scrapped && (await tx.query(`SELECT 1 FROM calibration_items WHERE lower(btrim(calibration_code)) = lower(btrim($1)) AND deleted_at IS NULL AND scrapped_at IS NULL`, [code])).rows.length) {
            out.existing++
            continue
          }
          const departmentId = await department(row.department)
          const category = guessCategory(row.name, code, categories)
          const d: ItemData = {
            categoryId: category?.id ?? null, name: row.name, deviceCode: row.deviceCode, manufacturer: '', range: '', resolution: category?.resolution ?? '', tolerance: category?.tolerance ?? null,
            unit: category?.unit || 'mm', departmentId, holder: row.holder, receivedOn: row.receivedOn, kind: row.kind, calibrationCode: code, lastCalibratedOn: row.lastCalibratedOn,
            intervalMonths: row.intervalMonths, notes: row.notes,
          }
          const id = await insertItem(d, importId('register', row.name, row.deviceCode, row.holder, row.receivedOn, code, row.lastCalibratedOn),
            row.scrapped ? { on: null, reason: 'Scrapped (هالك) in the imported register' } : null)
          if (!id) { out.existing++; continue }
          out.created++
          const dept = departmentId && codeDepartment(code)
          if (dept && departmentId) {
            const counts = codesByDepartment.get(departmentId) ?? new Map<string, number>()
            counts.set(dept, (counts.get(dept) ?? 0) + 1)
            codesByDepartment.set(departmentId, counts)
          }
        }
        // A department without a code takes the one its instruments' codes carry most.
        for (const [id, counts] of codesByDepartment) {
          const code = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
          if (code && /^[A-Z0-9.]{1,12}$/.test(code)) await tx.query(`UPDATE calibration_departments SET code = $2 WHERE id = $1 AND code = ''`, [id, code])
        }
      } else if (body.kind === 'certificates') {
        for (const row of body.rows) {
          const item = (await tx.query<{ id: string; tolerance: number | null; unit: string; reference: unknown }>(`SELECT i.id, i.tolerance::float8 AS tolerance, i.unit,
            COALESCE(c.reference, '{}') AS reference FROM calibration_items i LEFT JOIN calibration_categories c ON c.id = i.category_id
            WHERE lower(btrim(i.calibration_code)) = lower(btrim($1)) AND i.deleted_at IS NULL ORDER BY i.scrapped_at NULLS FIRST, i.created_at DESC LIMIT 1 FOR UPDATE OF i`,
          [row.calibrationCode])).rows[0]
          if (!item) { out.unmatched++; continue }
          const reference = { ...EMPTY_REFERENCE, ...(item.reference as object) }
          const d: CertificateData = {
            itemId: item.id, certificateNo: row.calibrationCode, kind: 'internal', calibratedOn: row.calibratedOn, intervalMonths: row.intervalMonths, body: '', performedBy: '',
            approvedBy: '', resolution: row.resolution, tolerance: item.tolerance, unit: item.unit, reference, groups: row.groups, fileId: null, notes: '',
          }
          const values = certValues(d, row.calibrationCode)
          const inserted = (await tx.query<{ id: string }>(`INSERT INTO calibration_certificates (item_id, ${CERT_WRITE}, source, submission_id, request_hash, created_by_id,
            created_by_name, updated_by_id, updated_by_name) VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(', ')}, 'import', $${CERT_WRITE_COUNT + 2}, 'import',
            $${CERT_WRITE_COUNT + 3}, $${CERT_WRITE_COUNT + 4}, $${CERT_WRITE_COUNT + 3}, $${CERT_WRITE_COUNT + 4}) ON CONFLICT (submission_id) DO NOTHING RETURNING id`,
          [item.id, ...values, importId('certificate', row.calibrationCode, row.calibratedOn), user.id, user.name])).rows[0]
          if (!inserted) { out.existing++; continue }
          out.created++
          // What the log knows of the instrument fills what its register row left empty.
          await tx.query(`UPDATE calibration_items SET manufacturer = CASE WHEN manufacturer = '' THEN $2 ELSE manufacturer END,
            device_range = CASE WHEN device_range = '' THEN $3 ELSE device_range END, resolution = CASE WHEN resolution = '' THEN $4 ELSE resolution END WHERE id = $1`,
          [item.id, row.manufacturer.slice(0, 120), row.range.slice(0, 120), row.resolution.slice(0, 60)])
          await moveItemOn(tx, item.id, user)
        }
      } else {
        for (const row of body.rows) {
          const candidates = (await tx.query<{ id: string; name: string; scrapped: boolean; scrappedOn: string | null }>(`SELECT id, name, scrapped_at IS NOT NULL AS scrapped,
            ${day('scrapped_on')} AS "scrappedOn" FROM calibration_items WHERE deleted_at IS NULL AND lower(btrim(holder)) = lower(btrim($1))
            AND ($2::date IS NULL OR received_on = $2::date) ORDER BY scrapped_at NULLS FIRST, received_on, created_at FOR UPDATE`, [row.holder, row.receivedOn])).rows
            .filter((c) => nameKey(c.name) === nameKey(row.name))
          const same = candidates.find((c) => c.scrapped && c.scrappedOn === row.scrappedOn)
          if (same) { out.existing++; continue }
          const match = candidates.find((c) => c.scrapped && !c.scrappedOn) ?? candidates.find((c) => !c.scrapped)
          if (match) {
            await tx.query(`UPDATE calibration_items SET scrapped_at = COALESCE(scrapped_at, now()), scrapped_on = $2,
              scrap_reason = CASE WHEN scrap_reason = '' OR scrapped_on IS NULL THEN 'Imported from the scrap form F-Q-05-03' ELSE scrap_reason END,
              scrapped_by_id = COALESCE(scrapped_by_id, $3), scrapped_by_name = CASE WHEN scrapped_by_name = '' THEN $4 ELSE scrapped_by_name END,
              updated_at = now(), updated_by_id = $3, updated_by_name = $4, version = version + 1 WHERE id = $1`, [match.id, row.scrappedOn, user.id, user.name])
            await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'CalibrationItem', entityId: match.id, item: match.name },
              { status: match.scrapped ? 'Scrapped' : 'In service', scrappedOn: '' }, { status: 'Scrapped', scrappedOn: row.scrappedOn })
            out.updated++
            continue
          }
          if (row.receivedOn && row.scrappedOn < row.receivedOn) { out.unmatched++; continue }
          const category = guessCategory(row.name, '', categories)
          const d: ItemData = {
            categoryId: category?.id ?? null, name: row.name, deviceCode: '', manufacturer: '', range: '', resolution: '', tolerance: null, unit: category?.unit || 'mm',
            departmentId: await department(row.department), holder: row.holder, receivedOn: row.receivedOn, kind: category?.kind ?? 'internal', calibrationCode: '',
            lastCalibratedOn: null, intervalMonths: category?.intervalMonths ?? 12, notes: '',
          }
          const id = await insertItem(d, importId('scrap', row.name, row.holder, row.receivedOn, row.scrappedOn), { on: row.scrappedOn, reason: 'Imported from the scrap form F-Q-05-03' })
          if (id) out.created++
          else out.existing++
        }
      }
      if (out.created || out.updated) {
        await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'CalibrationImport', entityId: body.kind,
          item: `${body.kind}: ${out.created} added, ${out.updated} updated` })
      }
      return out
    })
    res.json(result)
  })

  return r
}

/** Words that name each kind of instrument in the register, for an imported row whose code has no known prefix. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/vernier|باكوليس/i, 'V'],
  [/شريط|tape/i, 'M'],
  [/micrometer|ميكروميتر|ميكرومتر/i, 'MI'],
  [/protractor|زاوي|square|level/i, 'A'],
  [/dial|ساعة/i, 'DG'],
  [/feeler|فيلر|فيليير|foil/i, 'F'],
  [/flow/i, 'FM'],
  [/torque|عزم/i, 'TQ'],
]

/** The category an imported instrument belongs to: by its code's prefix (V.01…), else by its name's words. */
export function guessCategory(name: string, code: string, categories: CalibrationCategory[]): CalibrationCategory | null {
  const prefix = /^\s*([A-Za-z]{1,4})[.\-]\d/.exec(code)?.[1].toUpperCase()
  const byPrefix = (p: string | undefined) => (p ? categories.find((c) => c.codePrefix === p) ?? null : null)
  const fromCode = byPrefix(prefix)
  if (fromCode) return fromCode
  for (const [words, p] of CATEGORY_WORDS) if (words.test(name)) return byPrefix(p)
  return null
}
