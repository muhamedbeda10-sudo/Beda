import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'

// §20 — a sample's and a session's figures, kept as the record is written
// (migration 0067), are always what the views worked out row by row before:
// after every kind of change the floor and the ERP make, each view's figures
// equal the old definitions, worked out here again from the rows.

let app: TestApp

beforeAll(async () => {
  app = await new TestApp().start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(40))
})

afterAll(async () => {
  await app.stop()
})

/** Rows of `a` not in `b`, and of `b` not in `a`: both empty when they are the same. */
async function differences(a: string, b: string): Promise<[number, number]> {
  const one = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ((${a}) EXCEPT ALL (${b})) d`)
  const two = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ((${b}) EXCEPT ALL (${a})) d`)
  return [one.rows[0].n, two.rows[0].n]
}

/** The samples' figures as ai.inspection_samples worked them out before 0067. */
const SAMPLES_THEN = `
SELECT x.id AS sample_id,
  (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL)::int AS dimension_rows,
  (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL)::int AS dimensions_measured,
  (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Pass')::int AS dimensions_pass,
  (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Warning')::int AS dimensions_warning,
  (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.status = 'Fail')::int AS dimensions_fail,
  (SELECT count(*) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL)::int AS defect_records,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL)::float8 AS defect_pieces,
  (SELECT count(*) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL AND d.disposition = 'Hold')::int AS hold_records,
  (SELECT string_agg(c.coil_number, ', ' ORDER BY c.coil_number) FROM sample_coils c WHERE c.sample_id = x.id AND c.deleted_at IS NULL) AS coils
FROM inspection_samples x JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
WHERE x.deleted_at IS NULL`

/** A sample's material as the report that was too slow worked it out: its coils' when they agree, else its order's expected grade's. */
const MATERIAL_THEN = `
WITH sc AS (
  SELECT sample_id, count(DISTINCT material_kind) FILTER (WHERE material_kind IN ('black', 'galvanized')) AS kinds,
         max(material_kind) FILTER (WHERE material_kind IN ('black', 'galvanized')) AS kind
    FROM ai.sample_coils GROUP BY sample_id)
SELECT s.sample_id,
       CASE WHEN sc.kinds = 1 THEN sc.kind WHEN sc.kinds = 2 THEN 'mixed' END AS coil_material,
       COALESCE(CASE WHEN sc.kinds = 1 THEN sc.kind END, ai.material_kind(s.expected_grade)) AS material
  FROM ai.inspection_samples s LEFT JOIN sc ON sc.sample_id = s.sample_id`

/** The sessions' figures as ai.inspection_sessions worked them out before 0067. */
const SESSIONS_THEN = `
SELECT s.id AS session_id,
  (SELECT string_agg(DISTINCT x.inspector_name, ', ') FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS sample_inspectors,
  (SELECT string_agg((q.stage || ': ') || trim_scale(q.qty), ' · ' ORDER BY q.stage) FROM session_stage_quantities q WHERE q.session_id = s.id AND q.deleted_at IS NULL) AS stages,
  (SELECT max(q.stage) FROM session_stage_quantities q WHERE q.session_id = s.id AND q.deleted_at IS NULL)::int AS top_stage,
  (SELECT count(*) FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL)::int AS samples,
  (SELECT COALESCE(sum(x.sample_qty), 0) FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL)::float8 AS pieces_inspected,
  (SELECT count(*) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::int AS defect_records,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::float8 AS defect_pieces,
  (SELECT count(*) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold')::int AS hold_records,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold')::float8 AS hold_pieces,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Rejected')::float8 AS disposition_rejected_pieces,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Repair')::float8 AS disposition_repair_pieces,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Used in another order')::float8 AS disposition_used_elsewhere_pieces,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Accept with concession')::float8 AS disposition_concession_pieces,
  (SELECT count(*) FROM dimension_results r JOIN inspection_samples x ON x.id = r.sample_id WHERE x.session_id = s.id AND x.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status = 'Fail')::int AS dimension_fails,
  (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id JOIN inspection_samples x ON x.id = pr.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND pr.deleted_at IS NULL AND l.deleted_at IS NULL)::int AS pt_lengths_tested,
  (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id JOIN inspection_samples x ON x.id = pr.sample_id
    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND pr.deleted_at IS NULL AND l.deleted_at IS NULL AND l.verdict = 'Reject / Repair')::int AS pt_lengths_rejected,
  (SELECT count(*) FROM session_notes n WHERE n.session_id = s.id AND n.deleted_at IS NULL)::int AS notes
FROM inspection_sessions s WHERE s.deleted_at IS NULL`

const SESSION_COLUMNS =
  'session_id, sample_inspectors, stages, top_stage, samples, pieces_inspected, defect_records, defect_pieces, hold_records, hold_pieces, disposition_rejected_pieces, disposition_repair_pieces, disposition_used_elsewhere_pieces, disposition_concession_pieces, dimension_fails, pt_lengths_tested, pt_lengths_rejected, notes'

/** The order lines' defect pieces, and the closed sessions', as worked out before 0067. */
const ORDERS_THEN = `
SELECT o.id AS order_line_id,
  (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
    WHERE x.order_id = o.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::float8 AS defect_pieces
FROM production_orders o WHERE o.deleted_at IS NULL`

async function expectAsBefore(): Promise<void> {
  expect(
    await differences(
      SAMPLES_THEN,
      'SELECT sample_id, dimension_rows, dimensions_measured, dimensions_pass, dimensions_warning, dimensions_fail, defect_records, defect_pieces, hold_records, coils FROM ai.inspection_samples',
    ),
    'samples',
  ).toEqual([0, 0])
  expect(await differences(MATERIAL_THEN, 'SELECT sample_id, coil_material, material FROM ai.inspection_samples'), 'material').toEqual([0, 0])
  expect(await differences(SESSIONS_THEN, `SELECT ${SESSION_COLUMNS} FROM ai.inspection_sessions`), 'sessions').toEqual([0, 0])
  expect(await differences(ORDERS_THEN, 'SELECT order_line_id, defect_pieces FROM ai.order_lines'), 'order lines').toEqual([0, 0])
  expect(
    await differences(
      `SELECT session_id, defect_pieces FROM (${SESSIONS_THEN}) t WHERE session_id IN (SELECT session_id FROM ai.production_sessions)`,
      'SELECT session_id, defect_pieces FROM ai.production_sessions',
    ),
    'production sessions',
  ).toEqual([0, 0])
  expect(
    await differences(
      `SELECT c.id, (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d WHERE d.sample_id = c.sample_id AND d.deleted_at IS NULL)::float8
         FROM sample_coils c JOIN inspection_samples x ON x.id = c.sample_id AND x.deleted_at IS NULL JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
        WHERE c.deleted_at IS NULL`,
      'SELECT sample_coil_id, sample_defect_pieces FROM ai.sample_coils',
    ),
    'sample coils',
  ).toEqual([0, 0])
  expect(
    await differences(
      `SELECT r.id, s.material FROM dimension_results r JOIN ai.inspection_samples s ON s.sample_id = r.sample_id WHERE r.deleted_at IS NULL`,
      'SELECT measurement_id, material FROM ai.dimension_measurements',
    ),
    'measurements',
  ).toEqual([0, 0])
}

describe('§20 the samples’ and sessions’ figures, kept as the record is written', () => {
  it('are filled for the record already there, and equal the old definitions', async () => {
    const kept = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sample_rollups`)
    expect(kept.rows[0].n).toBeGreaterThan(100)
    await expectAsBefore()
  })

  it('follow every change to a sample’s rows: added, removed, changed or unmeasured', async () => {
    await app.db.query(`UPDATE dimension_results SET deleted_at = now() WHERE sequence = 4`)
    await app.db.query(`UPDATE dimension_results SET status = 'Warning' WHERE sequence = 5`)
    await app.db.query(`UPDATE dimension_results SET actual = NULL, status = 'Pending' WHERE sequence = 6`)
    await app.db.query(`UPDATE dimension_results SET status = 'Fail' WHERE sequence = 7 AND sample_id IN (SELECT id FROM inspection_samples LIMIT 20)`)
    await app.db.query(`UPDATE defect_results SET deleted_at = now() WHERE id IN (SELECT id FROM defect_results LIMIT 10)`)
    await app.db.query(`UPDATE defect_results SET disposition = 'Hold', qty = qty + 2 WHERE id IN (SELECT id FROM defect_results WHERE deleted_at IS NULL LIMIT 10)`)
    await app.db.query(`INSERT INTO defect_results (sample_id, defect_name, qty, disposition) SELECT id, 'Scratch', 3, 'Repair' FROM inspection_samples LIMIT 15`)
    await app.db.query(`UPDATE defect_results SET deleted_at = now() WHERE id IN (SELECT id FROM defect_results WHERE defect_name = 'Scratch' LIMIT 5)`)
    await expectAsBefore()
  })

  it('follow PT lengths, notes and stages', async () => {
    await app.db.query(`UPDATE pt_tested_lengths SET verdict = 'Reject / Repair' WHERE seq = 1 AND pt_record_id IN (SELECT id FROM pt_records LIMIT 3)`)
    await app.db.query(`UPDATE pt_tested_lengths SET deleted_at = now() WHERE seq = 2`)
    await app.db.query(`UPDATE pt_records SET deleted_at = now() WHERE id IN (SELECT id FROM pt_records LIMIT 1)`)
    await app.db.query(`INSERT INTO session_notes (session_id, order_id, author_id, author_name, text) SELECT id, order_id, inspector_id, inspector_name, 'More' FROM inspection_sessions LIMIT 7`)
    await app.db.query(`UPDATE session_notes SET deleted_at = now() WHERE id IN (SELECT id FROM session_notes LIMIT 3)`)
    await app.db.query(`INSERT INTO session_stage_quantities (session_id, stage, qty) SELECT id, 9, 12.50 FROM inspection_sessions LIMIT 5 ON CONFLICT DO NOTHING`)
    await app.db.query(`UPDATE session_stage_quantities SET qty = qty + 1 WHERE stage = 1`)
    await app.db.query(`UPDATE session_stage_quantities SET deleted_at = now() WHERE stage = 2`)
    await expectAsBefore()
  })

  it('follow coils and their grades: the register, the sample’s own grade, and the order’s expected grade', async () => {
    // One sample of each kind of material: galvanized and black coils on one, mixed.
    const [mixed] = (await app.db.query<{ id: string }>(`SELECT id FROM inspection_samples ORDER BY id LIMIT 1`)).rows
    await app.db.query(`INSERT INTO sample_coils (sample_id, coil_number, grade) VALUES ($1, 'EXTRA-1', 'S235JR'), ($1, 'EXTRA-2', 'DX51D+Z')`, [mixed.id])
    await app.db.query(`UPDATE coils SET grade = 'DX51D+Z140' WHERE id IN (SELECT id FROM coils ORDER BY coil_number LIMIT 5)`)
    await app.db.query(`UPDATE coils SET deleted_at = now() WHERE id IN (SELECT id FROM coils ORDER BY coil_number DESC LIMIT 2)`)
    await app.db.query(`UPDATE sample_coils SET deleted_at = now() WHERE id IN (SELECT id FROM sample_coils WHERE coil_number LIKE 'C%' LIMIT 8)`)
    await app.db.query(`UPDATE production_orders SET expected_grade = 'S350GD+Z275' WHERE id IN (SELECT id FROM production_orders WHERE expected_grade = 'S235JR' LIMIT 6)`)
    // Samples whose coils are all gone fall back on their order's expected grade.
    await app.db.query(`UPDATE sample_coils SET deleted_at = now() WHERE sample_id IN (SELECT id FROM inspection_samples ORDER BY id DESC LIMIT 4)`)
    const shown = await app.db.query<{ coilMaterial: string }>(`SELECT coil_material AS "coilMaterial" FROM ai.inspection_samples WHERE sample_id = $1`, [mixed.id])
    expect(shown.rows).toEqual([{ coilMaterial: 'mixed' }])
    await expectAsBefore()
  })

  it('follow samples moved, changed, deleted or restored, and sessions deleted', async () => {
    const [a, b] = (await app.db.query<{ id: string }>(`SELECT id FROM inspection_sessions ORDER BY id LIMIT 2`)).rows
    await app.db.query(`UPDATE inspection_samples SET session_id = $2, index = index + 100 WHERE id IN (SELECT id FROM inspection_samples WHERE session_id = $1 LIMIT 2)`, [a.id, b.id])
    await app.db.query(`UPDATE inspection_samples SET deleted_at = now() WHERE id IN (SELECT id FROM inspection_samples ORDER BY created_at LIMIT 6)`)
    await app.db.query(`UPDATE inspection_samples SET deleted_at = NULL WHERE id IN (SELECT id FROM inspection_samples WHERE deleted_at IS NOT NULL LIMIT 2)`)
    await app.db.query(`UPDATE inspection_samples SET sample_qty = sample_qty + 4, inspector_name = 'Someone Else' WHERE id IN (SELECT id FROM inspection_samples LIMIT 9)`)
    await app.db.query(`UPDATE inspection_sessions SET deleted_at = now() WHERE id IN (SELECT id FROM inspection_sessions ORDER BY id DESC LIMIT 2)`)
    await expectAsBefore()
  })

  it('give a new session and its first sample their rows as they are saved', async () => {
    const [order] = (await app.db.query<{ id: string; code: string }>(`SELECT id, work_center_code AS code FROM production_orders LIMIT 1`)).rows
    const [user] = (await app.db.query<{ id: string }>(`SELECT id FROM users LIMIT 1`)).rows
    const session = await app.db.query<{ id: string }>(
      `INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name) VALUES (99, $1, $2, $3, 'New') RETURNING id`,
      [order.id, order.code, user.id],
    )
    const sessionId = session.rows[0].id
    expect((await app.db.query(`SELECT samples FROM ai.inspection_sessions WHERE session_id = $1`, [sessionId])).rows).toEqual([{ samples: 0 }])
    const sample = await app.db.query<{ id: string }>(
      `INSERT INTO inspection_samples (session_id, order_id, index, shift, inspector_id, inspector_name, drawing, sample_qty, submission_id)
       VALUES ($1, $2, 1, 'A', $3, 'New', 'D', 2, gen_random_uuid()) RETURNING id`,
      [sessionId, order.id, user.id],
    )
    await app.db.query(`INSERT INTO dimension_results (sample_id, name, nominal, tol_plus, tol_minus, actual, status, source) VALUES ($1, 'L', 100, 1, 1, 102, 'Fail', 'manual')`, [sample.rows[0].id])
    const shown = await app.db.query(`SELECT samples, pieces_inspected AS "pieces", dimension_fails AS "fails" FROM ai.inspection_sessions WHERE session_id = $1`, [sessionId])
    expect(shown.rows).toEqual([{ samples: 1, pieces: 2, fails: 1 }])
    await expectAsBefore()
  })
})
