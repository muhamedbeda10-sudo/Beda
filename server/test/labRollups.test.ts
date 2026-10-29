import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { judge } from '@qc/shared/lab'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'

// §26 — a lab test's figures (its specimens' averages, lowest and highest,
// and the verdict worked out from them: migration 0086) are always what its
// specimens say, after every kind of change: specimens added, corrected,
// removed, moved to another test; the test deleted and restored. And the
// screen's own working (shared/lab judge) reaches the same verdict.

let app: TestApp

beforeAll(async () => {
  app = await new TestApp().start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(120))
})
afterAll(() => app.stop())

/** The figures worked out from the rows, as their plain definition. */
const THEN = `
SELECT t.id, count(s.position)::int AS specimens,
       round(avg(s.tensile), 2)::float8 AS tensile_avg, min(s.tensile)::float8 AS tensile_low, max(s.tensile)::float8 AS tensile_high,
       round(avg(s.yield), 2)::float8 AS yield_avg, min(s.yield)::float8 AS yield_low, max(s.yield)::float8 AS yield_high,
       round(avg(s.elongation), 2)::float8 AS elongation_avg, min(s.elongation)::float8 AS elongation_low, max(s.elongation)::float8 AS elongation_high,
       bool_and(s.yield >= t.yield_min) AS yield_ok
  FROM lab_tests t LEFT JOIN lab_test_specimens s ON s.test_id = t.id GROUP BY t.id`
const NOW = `
SELECT id, specimens, tensile_avg::float8, tensile_low::float8, tensile_high::float8, yield_avg::float8, yield_low::float8, yield_high::float8,
       elongation_avg::float8, elongation_low::float8, elongation_high::float8, yield_ok FROM lab_tests`

async function same(): Promise<void> {
  for (const [a, b] of [[THEN, NOW], [NOW, THEN]]) {
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ((${a}) EXCEPT ALL (${b})) d`)
    expect(rows[0].n).toBe(0)
  }
}

describe('§26 a lab test’s figures are its specimens’', () => {
  it('after the record is made', async () => {
    expect((await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM lab_tests WHERE specimens > 0')).rows[0].n).toBeGreaterThan(5)
    await same()
  })

  it('after specimens are corrected, added, removed and moved', async () => {
    await app.db.query(`UPDATE lab_test_specimens SET yield = yield - 100 WHERE position = 2 AND test_id IN (SELECT id FROM lab_tests ORDER BY id LIMIT 5)`)
    await same()
    await app.db.query(`INSERT INTO lab_test_specimens (test_id, position, tensile) SELECT id, 4, 999 FROM lab_tests ORDER BY id LIMIT 3`)
    await same()
    await app.db.query(`DELETE FROM lab_test_specimens WHERE position = 1 AND test_id IN (SELECT id FROM lab_tests ORDER BY id DESC LIMIT 4)`)
    await same()
    await app.db.query(`UPDATE lab_test_specimens SET test_id = (SELECT id FROM lab_tests ORDER BY id DESC LIMIT 1), position = 9
      WHERE (test_id, position) = (SELECT test_id, position FROM lab_test_specimens ORDER BY test_id LIMIT 1)`)
    await same()
    await app.db.query(`DELETE FROM lab_test_specimens WHERE test_id = (SELECT id FROM lab_tests ORDER BY id LIMIT 1)`)
    await same()
  })

  it('after the test is deleted and restored, and the screen’s verdict agrees', async () => {
    await app.db.query(`UPDATE lab_tests SET deleted_at = now() WHERE id IN (SELECT id FROM lab_tests ORDER BY id LIMIT 2)`)
    await same()
    await app.db.query(`UPDATE lab_tests SET deleted_at = NULL`)
    await same()
    const { rows } = await app.db.query<{ result: string; limits: Record<string, number | null>; specimens: { tensile: number | null; yield: number | null; elongation: number | null }[] }>(`
      SELECT t.result, json_build_object('yieldMin', t.yield_min::float8, 'yieldMax', t.yield_max::float8, 'tensileMin', t.tensile_min::float8,
               'tensileMax', t.tensile_max::float8, 'elongationMin', t.elongation_min::float8) AS limits,
             COALESCE(json_agg(json_build_object('tensile', s.tensile::float8, 'yield', s.yield::float8, 'elongation', s.elongation::float8)) FILTER (WHERE s.test_id IS NOT NULL), '[]') AS specimens
        FROM lab_tests t LEFT JOIN lab_test_specimens s ON s.test_id = t.id GROUP BY t.id`)
    for (const r of rows) expect(judge(r.specimens, r.limits as never).result).toBe(r.result)
    expect(new Set(rows.map((r) => r.result))).toEqual(new Set(['pass', 'fail', 'no-results']))
  })
})
