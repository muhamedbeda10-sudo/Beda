// ============================================================================
// §26 — The lab: material testing reports, the machine's log, its setup.
//
// The server works out what the report works out (the test standard, the
// grade's standard and limits for the thickness, the averages and verdict:
// the database keeps the last two, migration 0086), so a test reads the same
// on every screen whatever a browser sent. A test keeps the limits it was
// judged by until its grade, size or type is changed.
// ============================================================================

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router } from 'express'
import { z } from 'zod'
import {
  LAB_FORM, LAB_LISTS, LAB_MAX_SPECIMENS, LAB_SPECIMEN_ROWS, LAB_PERMISSIONS, LAB_SPECIMENS, LAB_IMPORT_CHUNK, HARDNESS_STANDARD, LAB_TEST_TYPE, SPECIMEN_INFO,
  gradeFor, gradeRows, labReference, limitsOf, parseLabReference, sizeThickness,
  type LabCoilLookup, type LabCoilTest, type LabGrade, type LabImportResult, type LabListValue, type LabOptions, type LabTest, type LabTestData, type LabTestList,
} from '@qc/shared/lab'
import { buildGradeIndex } from '@qc/shared/rules'
import type { AppContext } from '../context'
import { requirePermission, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { PG, pgCode, withTransaction, type Queryable } from '../db/pool'
import { badRequest, ConflictError, duplicate, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { assertImagesUsable } from './images.links'
import { readableImageIds } from './images.routes'
import { qualityDay } from './qualityRecords.schemas'

const n = (v: string) => `${v}::float8`
const BASE_SELECT = `t.id, t.reference, to_char(t.test_date, 'YYYY-MM-DD') AS "testDate", t.specimen_type AS "specimenType", t.specimen_code AS "specimenCode",
  t.size, ${n('t.thickness')} AS thickness, t.grade, t.machine, t.indenter, t.hardness_scale AS "hardnessScale", ${n('t.hardness')} AS hardness,
  t.supplier, t.certificate, t.cus_no AS "cusNo", ${n('t.mtc_tensile')} AS "mtcTensile", ${n('t.mtc_yield')} AS "mtcYield", ${n('t.mtc_elongation')} AS "mtcElongation",
  t.tested_by AS "testedBy", t.notes, t.test_standard AS "testStandard", t.material_standard AS "materialStandard", t.hardness_spec AS "hardnessSpec",
  t.hardness_standard AS "hardnessStandard",
  json_build_object('yieldMin', ${n('t.yield_min')}, 'yieldMax', ${n('t.yield_max')}, 'tensileMin', ${n('t.tensile_min')}, 'tensileMax', ${n('t.tensile_max')}, 'elongationMin', ${n('t.elongation_min')}) AS limits,
  ${n('t.tensile_avg')} AS "tensileAvg", ${n('t.yield_avg')} AS "yieldAvg", ${n('t.elongation_avg')} AS "elongationAvg",
  t.tensile_ok AS "tensileOk", t.yield_ok AS "yieldOk", t.elongation_ok AS "elongationOk", t.result, t.source, t.form, t.version,
  t.created_at AS "createdAt", t.created_by_name AS "createdByName", t.updated_at AS "updatedAt", t.updated_by_name AS "updatedByName",
  EXISTS (SELECT 1 FROM coils c WHERE lower(c.coil_number) = lower(btrim(t.specimen_code)) AND c.deleted_at IS NULL) AS "coilFound"`
/** A test whole: its specimens (the report's rows, at least three, empty ones as nulls) and its images. */
const SELECT = `${BASE_SELECT},
  COALESCE((SELECT json_agg(json_build_object('tensile', ${n('s.tensile')}, 'yield', ${n('s.yield')}, 'elongation', ${n('s.elongation')}) ORDER BY p.n)
    FROM generate_series(1, GREATEST(${LAB_SPECIMEN_ROWS}, (SELECT max(position) FROM lab_test_specimens WHERE test_id = t.id))) AS p(n)
    LEFT JOIN lab_test_specimens s ON s.test_id = t.id AND s.position = p.n), '[]') AS specimens,
  COALESCE((SELECT array_agg(x.image_id ORDER BY x.position) FROM lab_test_images x WHERE x.test_id = t.id AND x.removed_at IS NULL), '{}') AS "imageIds"`
/** The log's rows: no specimens or images, which the log does not show. */
const LIST_SELECT = `${BASE_SELECT}, '[]'::json AS specimens, '{}'::uuid[] AS "imageIds"`

const contains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const text = (max: number) => z.string().trim().max(max).default('')
const value = (max: number) => z.number().finite().min(0).max(max).nullable().default(null)
const specimenSchema = z.object({ tensile: value(100_000), yield: value(100_000), elongation: value(1000) })
const dataSchema = z.object({
  reference: text(60),
  testDate: qualityDay,
  specimenType: z.enum(LAB_SPECIMENS),
  specimenCode: text(120),
  size: text(120),
  grade: text(60),
  machine: text(120),
  specimens: z.array(specimenSchema).max(LAB_MAX_SPECIMENS).default([]),
  indenter: text(120),
  hardnessScale: text(20),
  hardness: value(10_000),
  supplier: text(200),
  certificate: text(200),
  cusNo: text(120),
  mtcTensile: value(100_000),
  mtcYield: value(100_000),
  mtcElongation: value(1000),
  testedBy: text(200),
  notes: text(4000),
  imageIds: z.array(z.string().uuid()).max(20).default([]).transform((v) => Array.from(new Set(v))),
})
type Data = z.infer<typeof dataSchema>
const listSchema = z.object({
  q: z.string().trim().max(200).default(''),
  specimenType: z.enum(LAB_SPECIMENS).optional(),
  result: z.enum(['pass', 'fail', 'no-limits', 'no-results']).optional(),
  from: qualityDay.optional(),
  to: qualityDay.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(50),
})
const num = (max: number) => z.number().finite().min(0).max(max).nullable().default(null)
const gradeSchema = z.object({
  family: z.enum(['sheet', 'bolt', 'wire']),
  grade: z.string().trim().min(1).max(60),
  standard: text(120),
  thicknessFrom: num(1000),
  thicknessTo: num(1000),
  yieldMin: num(100_000),
  yieldMax: num(100_000),
  tensileMin: num(100_000),
  tensileMax: num(100_000),
  elongationMin: num(1000),
  hardness: text(60),
}).superRefine((g, ctx) => {
  const order = (a: number | null, b: number | null, path: string, message: string) => { if (a !== null && b !== null && a > b) ctx.addIssue({ code: 'custom', path: [path], message }) }
  order(g.yieldMin, g.yieldMax, 'yieldMax', 'The maximum yield is below the minimum.')
  order(g.tensileMin, g.tensileMax, 'tensileMax', 'The highest tensile strength is below the lowest.')
  if (g.thicknessFrom !== null && g.thicknessTo !== null && g.thicknessFrom >= g.thicknessTo) ctx.addIssue({ code: 'custom', path: ['thicknessTo'], message: 'The band ends before it starts.' })
})
const listValueSchema = z.object({ list: z.enum(LAB_LISTS), value: z.string().trim().min(1).max(120) })
const importRowSchema = z.object({
  reference: z.string().trim().min(1).max(60),
  testDate: qualityDay,
  specimenType: z.enum(LAB_SPECIMENS),
  specimenCode: text(120),
  size: text(120),
  grade: text(60),
  tensile: value(100_000),
  yield: value(100_000),
  elongation: value(1000),
  hardness: value(10_000),
  certificate: text(200),
  cusNo: text(120),
  testedBy: text(200),
  notes: text(4000),
  mtcTensile: value(100_000),
  mtcYield: value(100_000),
  mtcElongation: value(1000),
})

const GRADE_SELECT = `id, family, grade, standard, ${n('thickness_from')} AS "thicknessFrom", ${n('thickness_to')} AS "thicknessTo",
  ${n('yield_min')} AS "yieldMin", ${n('yield_max')} AS "yieldMax", ${n('tensile_min')} AS "tensileMin", ${n('tensile_max')} AS "tensileMax",
  ${n('elongation_min')} AS "elongationMin", hardness, position`

async function loadGrades(q: Queryable): Promise<LabGrade[]> {
  return (await q.query<LabGrade>(`SELECT ${GRADE_SELECT} FROM lab_grades WHERE deleted_at IS NULL ORDER BY family, position, lower(grade), thickness_from NULLS FIRST`)).rows
}
async function loadEquivalence(q: Queryable) {
  const { rows } = await q.query<{ gradeA: string; gradeB: string }>(`SELECT grade_a AS "gradeA", grade_b AS "gradeB" FROM grade_mappings WHERE deleted_at IS NULL`)
  return { mappings: rows, index: buildGradeIndex(rows) }
}

/** What the report works out from what was entered: its standards and the limits of the grade's band. */
interface Worked {
  testStandard: string
  materialStandard: string
  thickness: number | null
  yieldMin: number | null
  yieldMax: number | null
  tensileMin: number | null
  tensileMax: number | null
  elongationMin: number | null
  hardnessSpec: string
}
function work(d: Pick<Data, 'specimenType' | 'size' | 'grade'>, grades: LabGrade[], index: Map<string, string>): Worked {
  const info = SPECIMEN_INFO[d.specimenType]
  const thickness = sizeThickness(d.specimenType, d.size)
  const row = gradeFor(gradeRows(grades, info.family, d.grade, index), thickness)
  return { testStandard: info.testStandard, materialStandard: row?.standard ?? '', thickness, ...limitsOf(row), hardnessSpec: row?.hardness ?? '' }
}

/** The next number of a year: after the counter, and after any number already taken by hand or by import. */
async function nextReference(tx: Queryable, year: number): Promise<string> {
  const taken = await tx.query<{ n: number | null }>(`SELECT max((substring(btrim(reference) FROM '^0*([0-9]{1,6})-'))::int) AS n FROM lab_tests
    WHERE btrim(reference) ~ ('^[0-9]{1,6}-' || $1 || '$')`, [String(year % 100).padStart(2, '0')])
  for (let attempt = 0; attempt < 1000; attempt++) {
    const counter = await tx.query<{ n: number }>(`INSERT INTO lab_test_counters (year, last_number) VALUES ($1, GREATEST($2::bigint, 0) + 1)
      ON CONFLICT (year) DO UPDATE SET last_number = GREATEST(lab_test_counters.last_number, $2::bigint) + 1 RETURNING last_number AS n`, [year, taken.rows[0].n ?? 0])
    const reference = labReference(counter.rows[0].n, year)
    if (!(await tx.query('SELECT 1 FROM lab_tests WHERE lower(btrim(reference)) = lower($1) AND deleted_at IS NULL', [reference])).rows.length) return reference
  }
  throw badRequest('Enter a certificate number.')
}

/** A number written by hand or imported moves the year's counter past it. */
async function claimReference(tx: Queryable, reference: string): Promise<void> {
  const parsed = parseLabReference(reference)
  if (!parsed) return
  await tx.query(`INSERT INTO lab_test_counters (year, last_number) VALUES ($1, $2)
    ON CONFLICT (year) DO UPDATE SET last_number = GREATEST(lab_test_counters.last_number, EXCLUDED.last_number)`, [parsed.year, parsed.number])
}

async function referenceFree(tx: Queryable, reference: string, except?: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM lab_tests WHERE lower(btrim(reference)) = lower(btrim($1)) AND deleted_at IS NULL', [reference])
  if (rows.some((r) => r.id !== except)) throw duplicate(`Test ${reference} already exists. Choose another certificate number.`)
}

async function writeSpecimens(tx: Queryable, testId: string, specimens: Data['specimens']): Promise<void> {
  const kept = specimens.map((s, i) => ({ ...s, position: i + 1 })).filter((s) => s.tensile !== null || s.yield !== null || s.elongation !== null)
  await tx.query('DELETE FROM lab_test_specimens WHERE test_id = $1 AND NOT (position = ANY($2::int[]))', [testId, kept.map((s) => s.position)])
  if (!kept.length) return
  await tx.query(`INSERT INTO lab_test_specimens (test_id, position, tensile, yield, elongation)
    SELECT $1, x.position, x.tensile, x.yield, x.elongation FROM json_to_recordset($2::json) AS x(position int, tensile numeric, yield numeric, elongation numeric)
    ON CONFLICT (test_id, position) DO UPDATE SET tensile = EXCLUDED.tensile, yield = EXCLUDED.yield, elongation = EXCLUDED.elongation
    WHERE (lab_test_specimens.tensile, lab_test_specimens.yield, lab_test_specimens.elongation) IS DISTINCT FROM (EXCLUDED.tensile, EXCLUDED.yield, EXCLUDED.elongation)`,
  [testId, JSON.stringify(kept)])
}

async function attachImages(tx: Queryable, testId: string, ids: string[]) {
  await tx.query('UPDATE lab_test_images SET removed_at = now() WHERE test_id = $1 AND removed_at IS NULL AND NOT (image_id = ANY($2::uuid[]))', [testId, ids])
  for (const [position, id] of ids.entries()) {
    await tx.query(`INSERT INTO lab_test_images (test_id, image_id, position) VALUES ($1,$2,$3)
      ON CONFLICT (test_id, image_id) DO UPDATE SET position = EXCLUDED.position, removed_at = NULL`, [testId, id, position])
  }
}

/** The test's own columns, in the order of the INSERT below. */
function columns(d: Data, w: Worked): unknown[] {
  return [d.reference, d.testDate, d.specimenType, d.specimenCode, d.size, w.thickness, d.grade, w.materialStandard, w.testStandard, d.machine,
    w.yieldMin, w.yieldMax, w.tensileMin, w.tensileMax, w.elongationMin, w.hardnessSpec, d.indenter, d.hardnessScale, d.hardness,
    d.supplier, d.certificate, d.cusNo, d.mtcTensile, d.mtcYield, d.mtcElongation, d.testedBy, d.notes]
}
const COLUMNS = `reference, test_date, specimen_type, specimen_code, size, thickness, grade, material_standard, test_standard, machine,
  yield_min, yield_max, tensile_min, tensile_max, elongation_min, hardness_spec, indenter, hardness_scale, hardness,
  supplier, certificate, cus_no, mtc_tensile, mtc_yield, mtc_elongation, tested_by, notes`
const COLUMN_COUNT = COLUMNS.split(',').length

/** A test as the audit log compares it: what was entered, and the limits it is judged by. */
function auditShape(d: LabTestData, limits: LabTest['limits'], reference: string): Record<string, unknown> {
  const t = (v: number | null) => (v === null ? '' : String(v))
  return {
    reference, testDate: d.testDate, specimenType: d.specimenType, specimenCode: d.specimenCode, size: d.size, grade: d.grade, machine: d.machine,
    // Each sample by its row: results moved to another row are a change.
    specimens: d.specimens.map((s, i) => (s.tensile !== null || s.yield !== null || s.elongation !== null ? `${i + 1}: ${[s.tensile, s.yield, s.elongation].map(t).join(' / ')}` : '')).filter(Boolean).join('; '),
    limits: [limits.yieldMin, limits.yieldMax, limits.tensileMin, limits.tensileMax, limits.elongationMin].map(t).join(' / '),
    indenter: d.indenter, hardnessScale: d.hardnessScale, hardness: d.hardness, supplier: d.supplier, certificate: d.certificate, cusNo: d.cusNo,
    mtcTensile: d.mtcTensile, mtcYield: d.mtcYield, mtcElongation: d.mtcElongation, testedBy: d.testedBy, notes: d.notes, imageIds: d.imageIds,
  }
}

export function labRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requirePermission(LAB_PERMISSIONS.view))

  async function read(q: Queryable, id: string): Promise<LabTest | undefined> {
    return (await q.query<LabTest>(`SELECT ${SELECT} FROM lab_tests t WHERE t.id = $1 AND t.deleted_at IS NULL`, [id])).rows[0]
  }

  r.get('/options', async (_req, res) => {
    const [grades, lists, equivalence] = await Promise.all([
      loadGrades(ctx.db),
      ctx.db.query<LabListValue>(`SELECT id, list, value, position FROM lab_list_values WHERE deleted_at IS NULL ORDER BY list, position, lower(value)`),
      loadEquivalence(ctx.db),
    ])
    const year = new Date().getFullYear()
    const taken = await ctx.db.query<{ n: number | null }>(`SELECT GREATEST((SELECT last_number FROM lab_test_counters WHERE year = $1),
      (SELECT max((substring(btrim(reference) FROM '^0*([0-9]{1,6})-'))::int) FROM lab_tests WHERE deleted_at IS NULL AND btrim(reference) ~ ('^[0-9]{1,6}-' || $2 || '$'))) AS n`,
    [year, String(year % 100).padStart(2, '0')])
    const body: LabOptions = { grades, lists: lists.rows, gradeMappings: equivalence.mappings, nextReference: labReference((taken.rows[0].n ?? 0) + 1, year) }
    res.json(body)
  })

  /** What the coil register knows of a specimen code, and the lab's earlier tests of it. */
  r.get('/coil', async (req, res) => {
    const { number } = parse(z.object({ number: z.string().trim().min(1).max(120) }), req.query)
    const [coil, tests] = await Promise.all([
      ctx.db.query<NonNullable<LabCoilLookup['coil']>>(`SELECT coil_number AS "coilNumber", COALESCE(grade, '') AS grade, COALESCE(supplier, '') AS supplier,
        ${n('thickness')} AS thickness, ${n('yield')} AS yield, COALESCE(notes, '') AS notes FROM coils WHERE lower(coil_number) = lower($1) AND deleted_at IS NULL`, [number]),
      ctx.db.query<LabCoilLookup['tests'][number]>(`SELECT id, reference, to_char(test_date, 'YYYY-MM-DD') AS "testDate", result FROM lab_tests
        WHERE lower(btrim(specimen_code)) = lower($1) AND deleted_at IS NULL ORDER BY test_date DESC, created_at DESC LIMIT 50`, [number]),
    ])
    const body: LabCoilLookup = { coil: coil.rows[0] ?? null, tests: tests.rows }
    res.json(body)
  })

  /** Coil search: the lab's tests of the coils on screen. */
  r.get('/by-coils', async (req, res) => {
    const numbers = parse(z.string().max(5000).default(''), req.query.numbers).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 100)
    if (!numbers.length) return res.json([])
    const { rows } = await ctx.db.query<LabCoilTest>(`SELECT lower(btrim(specimen_code)) AS "coilNumber", id, reference, to_char(test_date, 'YYYY-MM-DD') AS "testDate", result
      FROM lab_tests WHERE lower(btrim(specimen_code)) = ANY($1::text[]) AND deleted_at IS NULL ORDER BY test_date DESC, created_at DESC LIMIT 500`, [numbers])
    res.json(rows)
  })

  r.get('/', async (req, res) => {
    const q = parse(listSchema, req.query)
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['t.deleted_at IS NULL']
    if (q.q) clauses.push(`concat_ws(' ', t.reference, t.specimen_code, t.grade, t.size, t.supplier, t.certificate, t.cus_no, t.tested_by, t.notes) ILIKE ${p(contains(q.q))}`)
    if (q.specimenType) clauses.push(`t.specimen_type = ${p(q.specimenType)}`)
    if (q.result) clauses.push(`t.result = ${p(q.result)}`)
    if (q.from) clauses.push(`t.test_date >= ${p(q.from)}::date`)
    if (q.to) clauses.push(`t.test_date <= ${p(q.to)}::date`)
    const where = clauses.join(' AND ')
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM lab_tests t WHERE ${where}`, params)).rows[0].n
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<LabTest>(`SELECT ${LIST_SELECT} FROM lab_tests t WHERE ${where}
      ORDER BY t.test_date DESC, (substring(btrim(t.reference) FROM '^0*([0-9]{1,6})-'))::int DESC NULLS LAST, t.created_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const body: LabTestList = { tests: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  r.get('/:id', async (req, res) => {
    const test = await read(ctx.db, parse(z.string().uuid(), req.params.id))
    if (!test) throw notFound('Lab test')
    res.json(test)
  })

  r.post('/', requirePermission(LAB_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const body = parse(dataSchema.extend({ submissionId: z.string().uuid() }), req.body)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = (await tx.query<{ id: string; hash: string; by: string; deleted: boolean }>(`SELECT id, request_hash AS hash, created_by_id AS by, deleted_at IS NOT NULL AS deleted
        FROM lab_tests WHERE submission_id = $1`, [body.submissionId])).rows[0]
      if (prior) {
        if (prior.by !== user.id || prior.hash !== hash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values.')
        if (prior.deleted) throw notFound('Lab test')
        return { test: (await read(tx, prior.id))!, created: false }
      }
      await assertImagesUsable(tx, body.imageIds)
      if ((await readableImageIds(tx, user, body.imageIds)).size !== body.imageIds.length) throw forbidden('One of these images is not available to you.')
      // One number at a time: two saves never take the same one.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('lab-test-reference', 0))`)
      const reference = body.reference || await nextReference(tx, Number(body.testDate.slice(0, 4)))
      await referenceFree(tx, reference)
      await claimReference(tx, reference)
      const { index } = await loadEquivalence(tx)
      const w = work(body, await loadGrades(tx), index)
      const values = columns({ ...body, reference }, w)
      const inserted = await tx.query<{ id: string }>(`INSERT INTO lab_tests (${COLUMNS}, hardness_standard, test_type, form, submission_id, request_hash,
        created_by_id, created_by_name, updated_by_id, updated_by_name)
        VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}, $${COLUMN_COUNT + 1}, $${COLUMN_COUNT + 2}, $${COLUMN_COUNT + 3}, $${COLUMN_COUNT + 4}, $${COLUMN_COUNT + 5},
          $${COLUMN_COUNT + 6}, $${COLUMN_COUNT + 7}, $${COLUMN_COUNT + 6}, $${COLUMN_COUNT + 7}) RETURNING id`,
      [...values, HARDNESS_STANDARD, LAB_TEST_TYPE, JSON.stringify(LAB_FORM), body.submissionId, hash, user.id, user.name])
      const id = inserted.rows[0].id
      await writeSpecimens(tx, id, body.specimens)
      await attachImages(tx, id, body.imageIds)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'LabTest', entityId: id, item: `${reference} ${body.specimenCode}`.trim() })
      return { test: (await read(tx, id))!, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.test)
  })

  r.put('/:id', requirePermission(LAB_PERMISSIONS.record), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(dataSchema.extend({ version: z.number().int().min(0) }), req.body)
    const test = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM lab_tests WHERE id = $1 FOR UPDATE', [id])
      const old = await read(tx, id)
      if (!old) throw notFound('Lab test')
      if (old.version !== body.version) throw new ConflictError(old)
      await assertImagesUsable(tx, body.imageIds)
      // Images already on the test stay usable by whoever may edit it.
      const fresh = body.imageIds.filter((i) => !old.imageIds.includes(i))
      if ((await readableImageIds(tx, user, fresh)).size !== fresh.length) throw forbidden('One of these images is not available to you.')
      const reference = body.reference || old.reference
      if (reference.toLowerCase() !== old.reference.toLowerCase()) {
        // As a new test takes a number: one at a time.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('lab-test-reference', 0))`)
        await referenceFree(tx, reference, id)
        await claimReference(tx, reference)
      }
      // The limits it was judged by stay unless what decides them changed.
      const { index } = await loadEquivalence(tx)
      const recomputed = work(body, await loadGrades(tx), index)
      const same = old.specimenType === body.specimenType && old.size === body.size && old.grade === body.grade
      const w: Worked = same
        ? { testStandard: old.testStandard, materialStandard: old.materialStandard, thickness: old.thickness, ...old.limits, hardnessSpec: old.hardnessSpec }
        : recomputed
      const before = auditShape(old, old.limits, old.reference)
      const after = auditShape(body, w, reference)
      for (const key of Object.keys(after)) if (isDeepStrictEqual(before[key], after[key])) { delete before[key]; delete after[key] }
      const changes = await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'LabTest', entityId: id, item: `${reference} ${body.specimenCode}`.trim() }, before, after)
      if (!changes) return old
      const values = columns({ ...body, reference }, w)
      try {
        await tx.query(`UPDATE lab_tests SET (${COLUMNS}) = (${values.map((_, i) => `$${i + 2}`).join(', ')}),
          updated_at = now(), updated_by_id = $${COLUMN_COUNT + 2}, updated_by_name = $${COLUMN_COUNT + 3}, version = version + 1 WHERE id = $1`,
        [id, ...values, user.id, user.name])
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`Test ${reference} already exists. Choose another certificate number.`)
        throw e
      }
      await writeSpecimens(tx, id, body.specimens)
      await attachImages(tx, id, body.imageIds)
      return (await read(tx, id))!
    })
    res.json(test)
  })

  r.delete('/:id', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ reference: string; code: string }>(`SELECT reference, specimen_code AS code FROM lab_tests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Lab test')
      await tx.query('UPDATE lab_tests SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'LabTest', entityId: id, item: `${old.reference} ${old.code}`.trim() })
    })
    res.status(204).end()
  })

  // ---- Setup ---------------------------------------------------------------------------

  r.post('/grades', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const g = parse(gradeSchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const inserted = await tx.query<LabGrade>(`INSERT INTO lab_grades (family, grade, standard, thickness_from, thickness_to, yield_min, yield_max, tensile_min, tensile_max,
        elongation_min, hardness, position, updated_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE((SELECT max(position) + 1 FROM lab_grades WHERE family = $1 AND deleted_at IS NULL), 1), $12)
        ON CONFLICT DO NOTHING RETURNING ${GRADE_SELECT}`,
      [g.family, g.grade, g.standard, g.thicknessFrom, g.thicknessTo, g.yieldMin, g.yieldMax, g.tensileMin, g.tensileMax, g.elongationMin, g.hardness, user.name])
      if (!inserted.rows[0]) throw duplicate(`${g.grade} already has limits for this thickness.`)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'LabGrade', entityId: inserted.rows[0].id, item: g.grade })
      return inserted.rows[0]
    })
    res.status(201).json(row)
  })

  r.put('/grades/:id', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const g = parse(gradeSchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<LabGrade>(`SELECT ${GRADE_SELECT} FROM lab_grades WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Grade')
      const { id: _id, position: _p, ...before } = old
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'LabGrade', entityId: id, item: g.grade }, before, g)
      try {
        return (await tx.query<LabGrade>(`UPDATE lab_grades SET family = $2, grade = $3, standard = $4, thickness_from = $5, thickness_to = $6, yield_min = $7, yield_max = $8,
          tensile_min = $9, tensile_max = $10, elongation_min = $11, hardness = $12, updated_at = now(), updated_by_name = $13 WHERE id = $1 RETURNING ${GRADE_SELECT}`,
        [id, g.family, g.grade, g.standard, g.thicknessFrom, g.thicknessTo, g.yieldMin, g.yieldMax, g.tensileMin, g.tensileMax, g.elongationMin, g.hardness, user.name])).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`${g.grade} already has limits for this thickness.`)
        throw e
      }
    })
    res.json(row)
  })

  r.delete('/grades/:id', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ grade: string }>('UPDATE lab_grades SET deleted_at = now(), updated_by_name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING grade', [id, user.name])).rows[0]
      if (!old) throw notFound('Grade')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'LabGrade', entityId: id, item: old.grade })
    })
    res.status(204).end()
  })

  r.post('/lists', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const v = parse(listValueSchema, req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const inserted = await tx.query<LabListValue>(`INSERT INTO lab_list_values (list, value, position)
        VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM lab_list_values WHERE list = $1 AND deleted_at IS NULL), 1))
        ON CONFLICT DO NOTHING RETURNING id, list, value, position`, [v.list, v.value])
      if (!inserted.rows[0]) throw duplicate(`${v.value} is already on the list.`)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'LabList', entityId: inserted.rows[0].id, item: `${v.list}: ${v.value}` })
      return inserted.rows[0]
    })
    res.status(201).json(row)
  })

  r.delete('/lists/:id', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ list: string; value: string }>('UPDATE lab_list_values SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING list, value', [id])).rows[0]
      if (!old) throw notFound('List value')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'LabList', entityId: id, item: `${old.list}: ${old.value}` })
    })
    res.status(204).end()
  })

  /**
   * The machine log's workbook, read on the client (shared/lab parseLabLog),
   * in chunks: each row a test with its averages as one specimen. A number
   * already in the lab is left as it is, so importing the log again adds only
   * what is new.
   */
  r.post('/import', requirePermission(LAB_PERMISSIONS.setup), async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(z.object({ rows: z.array(importRowSchema).min(1).max(LAB_IMPORT_CHUNK) }), req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('lab-test-reference', 0))`)
      const grades = await loadGrades(tx)
      const { index } = await loadEquivalence(tx)
      const taken = new Set((await tx.query<{ ref: string }>(`SELECT lower(btrim(reference)) AS ref FROM lab_tests WHERE lower(btrim(reference)) = ANY($1::text[]) AND deleted_at IS NULL`,
        [rows.map((x) => x.reference.toLowerCase())])).rows.map((x) => x.ref))
      const out: LabImportResult = { created: 0, existing: 0 }
      for (const row of rows) {
        if (taken.has(row.reference.toLowerCase())) { out.existing++; continue }
        taken.add(row.reference.toLowerCase())
        const d: Data = { ...row, machine: '', specimens: [{ tensile: row.tensile, yield: row.yield, elongation: row.elongation }], indenter: '', hardnessScale: '', supplier: '', imageIds: [] }
        const w = work(d, grades, index)
        const submissionId = createHash('sha256').update(`lab-log:${row.reference.toLowerCase()}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')
        const values = columns(d, w)
        const inserted = await tx.query<{ id: string }>(`INSERT INTO lab_tests (${COLUMNS}, hardness_standard, test_type, source, form, submission_id, request_hash,
          created_by_id, created_by_name, updated_by_id, updated_by_name)
          VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}, $${COLUMN_COUNT + 1}, $${COLUMN_COUNT + 2}, 'log-import', $${COLUMN_COUNT + 3}, $${COLUMN_COUNT + 4}, 'log-import',
            $${COLUMN_COUNT + 5}, $${COLUMN_COUNT + 6}, $${COLUMN_COUNT + 5}, $${COLUMN_COUNT + 6})
          ON CONFLICT (submission_id) DO NOTHING RETURNING id`,
        [...values, HARDNESS_STANDARD, LAB_TEST_TYPE, JSON.stringify(LAB_FORM), submissionId, user.id, user.name])
        if (!inserted.rows[0]) { out.existing++; continue }
        await writeSpecimens(tx, inserted.rows[0].id, d.specimens)
        // Only a number of the test's own year moves that year's counter.
        if (parseLabReference(row.reference)?.year === Number(row.testDate.slice(0, 4))) await claimReference(tx, row.reference)
        out.created++
      }
      if (out.created) await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'LabLogImport', entityId: rows[0].reference, item: `${out.created} tests from the machine log` })
      return out
    })
    res.json(result)
  })

  return r
}
