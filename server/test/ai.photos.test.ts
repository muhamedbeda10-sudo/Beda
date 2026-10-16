import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AI_PREVIEW_ROWS } from '@qc/shared/ai'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'
import { combinationRole, domainBits } from '../src/ai/domains'
import { runReadOnlyQuery, type RunOptions } from '../src/ai/runQuery'
import { describeAiSchema } from '../src/ai/schemaDoc'

// §20 — the assistant shows the floor's photos (migration 0068): one row per
// photo of a defect, a note, a PT record, a paint check (ai.inspection_photos)
// or a PDI (ai.pdi_photos), with what it was taken of; never a photo deleted,
// nor one of a record deleted; each read with its own domain.

const app = new TestApp()
const chat: RunOptions = { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: 'Africa/Cairo' }

const count = async (sql: string, params: unknown[] = []) => (await app.db.query<{ n: number }>(sql, params)).rows[0].n

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(40))
  // The made-up factory writes a PDI for about one order in ten: one with a photo, whatever it drew.
  await app.db.query(`
    WITH d AS (
      INSERT INTO pdi_documents (order_id, created_by_id, created_by_name)
      SELECT o.id, u.id, u.name FROM production_orders o, users u WHERE u.username = 'perf1' ORDER BY o.order_number LIMIT 1
      RETURNING id, created_by_id, created_by_name
    ), i AS (
      INSERT INTO images (storage_key, driver, original_filename, mime_type, byte_size, width, height, sha256, uploaded_by_id, uploaded_by_name)
      SELECT 'test/pdi-photo', 'local', 'pdi.jpg', 'image/jpeg', 1000, 800, 600, repeat('0', 64), created_by_id, created_by_name FROM d
      RETURNING id
    )
    INSERT INTO pdi_images (pdi_id, image_id, position) SELECT d.id, i.id, 0 FROM d, i`)
}, 60_000)
afterAll(() => app.stop())

describe('§20 the photos the assistant can show', () => {
  it('lists every live photo once, with what it was taken of', async () => {
    const byKind = await app.db.query<{ photo_of: string; n: number }>(`SELECT photo_of, count(*)::int AS n FROM ai.inspection_photos GROUP BY 1 ORDER BY 1`)
    expect(byKind.rows).toEqual([
      { photo_of: 'defect', n: await count(`SELECT count(*)::int AS n FROM defect_images`) },
      { photo_of: 'note', n: await count(`SELECT count(*)::int AS n FROM session_note_images`) },
      { photo_of: 'paint', n: await count(`SELECT count(*)::int AS n FROM paint_sample_images`) },
      { photo_of: 'pt', n: await count(`SELECT count(*)::int AS n FROM pt_record_images`) },
    ])
    for (const row of byKind.rows) expect(row.n, row.photo_of).toBeGreaterThan(0)
    expect(await count(`SELECT count(*)::int AS n FROM ai.pdi_photos`)).toBe(await count(`SELECT count(*)::int AS n FROM pdi_images`))
    expect(await count(`SELECT count(*)::int AS n FROM ai.pdi_photos`)).toBeGreaterThan(0)

    // A defect's photo says which defect, its sample, session and order line, numbered from 1.
    const { rows } = await app.db.query(
      `SELECT p.defect_name = d.defect_name AS same_defect, p.sample_id = d.sample_id AS same_sample, p.session_id = d.session_id AS same_session,
              p.order_number = d.order_number AS same_order, p.machine = d.machine AS same_machine, p.recorded_at = d.recorded_at AS same_time,
              p.photo_no BETWEEN 1 AND 2 AS numbered, p.note_id IS NULL AND p.pt_record_id IS NULL AS only_defect
         FROM ai.inspection_photos p JOIN ai.defects d ON d.defect_id = p.defect_id
        WHERE p.photo_of = 'defect'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Object.values(r).every(Boolean), JSON.stringify(r)).toBe(true)
  })

  it('leaves out a photo deleted, and the photos of a record deleted', async () => {
    const before = await count(`SELECT count(*)::int AS n FROM ai.inspection_photos`)
    const { rows } = await app.db.query<{ image_id: string; defect_id: string }>(`SELECT image_id, defect_id FROM defect_images ORDER BY image_id LIMIT 2`)
    await app.db.query(`UPDATE images SET deleted_at = now() WHERE id = $1`, [rows[0].image_id])
    expect(await count(`SELECT count(*)::int AS n FROM ai.inspection_photos`)).toBe(before - 1)
    expect(await count(`SELECT count(*)::int AS n FROM ai.inspection_photos WHERE photo_id = $1`, [rows[0].image_id])).toBe(0)

    const ofDefect = await count(`SELECT count(*)::int AS n FROM ai.inspection_photos WHERE defect_id = $1`, [rows[1].defect_id])
    expect(ofDefect).toBeGreaterThan(0)
    await app.db.query(`UPDATE defect_results SET deleted_at = now() WHERE id = $1`, [rows[1].defect_id])
    expect(await count(`SELECT count(*)::int AS n FROM ai.inspection_photos WHERE defect_id = $1`, [rows[1].defect_id])).toBe(0)

    const pdi = (await app.db.query<{ pdi_id: string }>(`SELECT pdi_id FROM pdi_images LIMIT 1`)).rows[0].pdi_id
    await app.db.query(`UPDATE pdi_documents SET deleted_at = now() WHERE id = $1`, [pdi])
    expect(await count(`SELECT count(*)::int AS n FROM ai.pdi_photos WHERE pdi_id = $1`, [pdi])).toBe(0)
  })

  it('is read with its own domain: inspection photos with the inspection record, PDI photos with the orders', async () => {
    const database = new URL(app.config.DATABASE_URL).pathname.slice(1)
    const inspectionOnly = combinationRole(database, domainBits(['inspection']))
    const ordersOnly = combinationRole(database, domainBits(['orders']))
    const can = async (role: string, view: string) =>
      (await app.db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, `ai.${view}`])).rows[0].ok
    expect(await can(inspectionOnly, 'inspection_photos')).toBe(true)
    expect(await can(inspectionOnly, 'pdi_photos')).toBe(false)
    expect(await can(ordersOnly, 'pdi_photos')).toBe(true)
    expect(await can(ordersOnly, 'inspection_photos')).toBe(false)

    const pool = app.aiReader.poolFor(['inspection'])!
    const shown = await runReadOnlyQuery(pool, `SELECT photo_id, defect_name, machine FROM ai.inspection_photos WHERE photo_of = 'defect' ORDER BY recorded_at DESC LIMIT 3`, chat)
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.columns).toEqual(['photo_id', 'defect_name', 'machine'])
    expect(shown.rows).toHaveLength(3)
    expect((await runReadOnlyQuery(pool, `SELECT photo_id FROM ai.pdi_photos LIMIT 1`, chat)).ok).toBe(false)
  })

  it('is in the data dictionary the model reads, with how to show photos', async () => {
    const inspection = await describeAiSchema(app.db, ['inspection'])
    expect(inspection).toContain('ai.inspection_photos')
    expect(inspection).toMatch(/return photo_id/)
    expect(inspection).not.toContain('ai.pdi_photos')
    expect(await describeAiSchema(app.db, ['orders'])).toContain('ai.pdi_photos')
  })
})
