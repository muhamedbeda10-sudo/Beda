// ============================================================================
// §7.7 — the coil register's import: only a coil the file changes is written
// and counted as updated; each change is audited field by field with its old
// and new value, and a coil brought back from deleted says so — as an MTC
// upload records its own.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportResult } from '@qc/shared/api'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session

const importCoils = async (rows: Record<string, unknown>[]) => {
  const res = await app.api<ImportResult>('POST', '/api/coils/import', { token: admin.token, body: { rows } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}
const coilId = async (number: string) => (await app.db.query<{ id: string }>(`SELECT id FROM coils WHERE lower(coil_number) = lower($1)`, [number])).rows[0].id
const trail = async (id: string) =>
  (
    await app.db.query<{ action: string; field: string; oldValue: string | null; newValue: string | null }>(
      `SELECT action, field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'Coil' AND entity_id = $1 ORDER BY id`,
      [id],
    )
  ).rows
const updatedAt = async (id: string) => (await app.db.query<{ at: string }>(`SELECT updated_at AS at FROM coils WHERE id = $1`, [id])).rows[0].at

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
})
afterAll(() => app.stop())

describe('§7.7 importing the coil register', () => {
  it('writes and counts only what changes, auditing each field with its old and new value', async () => {
    expect(await importCoils([
      { coilNumber: 'C-1', grade: 'S355JR', supplier: 'Ezz', thickness: 2.5 },
      { coilNumber: 'C-2', grade: 'S235JR', width: 1250 },
    ])).toEqual({ inserted: 2, updated: 0, unchanged: 0 })
    const c1 = await coilId('C-1')
    expect(await trail(c1)).toEqual([{ action: 'create', field: 'source', oldValue: null, newValue: 'Coil register import: C-1' }])
    const written = await updatedAt(c1)

    // The same file again: nothing written, nothing audited but the batch.
    expect(await importCoils([
      { coilNumber: 'c-1', grade: 'S355JR', supplier: 'Ezz', thickness: 2.5 },
      { coilNumber: 'C-2', grade: 'S235JR', width: 1250.0004 },
    ])).toEqual({ inserted: 0, updated: 0, unchanged: 2 })
    expect(await updatedAt(c1)).toBe(written)
    expect(await trail(c1)).toHaveLength(1)

    // One field changed, one left out (kept): one coil updated, its one change audited.
    expect(await importCoils([
      { coilNumber: 'C-1', grade: 'S355J2', thickness: 2.5 },
      { coilNumber: 'C-2', grade: 'S235JR' },
    ])).toEqual({ inserted: 0, updated: 1, unchanged: 1 })
    expect((await trail(c1)).slice(1)).toEqual([{ action: 'update', field: 'grade', oldValue: 'S355JR', newValue: 'S355J2' }])
    expect(await trail(await coilId('C-2'))).toHaveLength(1)
    const batch = await app.db.query<{ newValue: string }>(`SELECT new_value AS "newValue" FROM audit_log WHERE entity = 'Coil' AND entity_id = 'bulk-import' ORDER BY id`)
    expect(batch.rows.map((r) => r.newValue)).toEqual(['2 inserted, 0 updated, 0 unchanged', '0 inserted, 0 updated, 2 unchanged', '0 inserted, 1 updated, 1 unchanged'])
  })

  it('brings a deleted coil back, saying so, even when the file changes nothing in it', async () => {
    const c2 = await coilId('C-2')
    await app.db.query(`UPDATE coils SET deleted_at = now() WHERE id = $1`, [c2])
    expect(await importCoils([{ coilNumber: 'C-2', grade: 'S235JR', thickness: 3 }])).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect((await app.db.query(`SELECT deleted_at FROM coils WHERE id = $1`, [c2])).rows[0].deleted_at).toBeNull()
    expect((await trail(c2)).slice(1)).toEqual([
      { action: 'restore', field: 'source', oldValue: null, newValue: 'Coil register import' },
      { action: 'update', field: 'thickness', oldValue: '', newValue: '3' },
    ])
  })
})
