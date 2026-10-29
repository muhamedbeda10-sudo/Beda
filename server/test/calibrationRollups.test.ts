import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'

// §27 — an instrument's count of certificates (migration 0088) is always what
// its certificates say, after every kind of change: certificates added,
// corrected, deleted and restored, moved to another instrument.

let app: TestApp

beforeAll(async () => {
  app = await new TestApp().start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(120))
})
afterAll(() => app.stop())

/** The count as its plain definition, and as kept. */
const THEN = `SELECT i.id, count(k.id)::int AS n FROM calibration_items i LEFT JOIN calibration_certificates k ON k.item_id = i.id AND k.deleted_at IS NULL GROUP BY i.id`
const NOW = `SELECT id, certificates AS n FROM calibration_items`

async function same(): Promise<void> {
  for (const [a, b] of [[THEN, NOW], [NOW, THEN]]) {
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ((${a}) EXCEPT ALL (${b})) d`)
    expect(rows[0].n).toBe(0)
  }
}

describe('§27 an instrument’s count is its certificates’', () => {
  it('after the record is made', async () => {
    expect((await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM calibration_items WHERE certificates = 3')).rows[0].n).toBeGreaterThan(50)
    await same()
  })

  it('after certificates are added, corrected, deleted, restored and moved', async () => {
    await app.db.query(`INSERT INTO calibration_certificates (item_id, kind, calibrated_on, interval_months, submission_id, request_hash, created_by_id, created_by_name, updated_by_id, updated_by_name)
      SELECT id, 'internal', current_date, 12, gen_random_uuid(), 'x', created_by_id, created_by_name, created_by_id, created_by_name FROM calibration_items ORDER BY id LIMIT 4`)
    await same()
    await app.db.query(`UPDATE calibration_certificates SET notes = 'corrected' WHERE id IN (SELECT id FROM calibration_certificates ORDER BY id LIMIT 10)`)
    await same()
    await app.db.query(`UPDATE calibration_certificates SET deleted_at = now() WHERE id IN (SELECT id FROM calibration_certificates ORDER BY id DESC LIMIT 7)`)
    await same()
    await app.db.query(`UPDATE calibration_certificates SET deleted_at = NULL WHERE id IN (SELECT id FROM calibration_certificates WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 3)`)
    await same()
    await app.db.query(`UPDATE calibration_certificates SET item_id = (SELECT id FROM calibration_items ORDER BY id DESC LIMIT 1)
      WHERE id IN (SELECT id FROM calibration_certificates ORDER BY created_at, id LIMIT 5)`)
    await same()
  })

  it('refuses to forget a certificate for good', async () => {
    await expect(app.db.query(`DELETE FROM calibration_certificates WHERE id IN (SELECT id FROM calibration_certificates LIMIT 1)`)).rejects.toThrow()
    await same()
  })
})
