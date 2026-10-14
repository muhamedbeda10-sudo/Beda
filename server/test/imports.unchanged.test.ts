// ============================================================================
// §7.7, §24 — an ERP export imported again writes nothing it would not change.
// The order sheet and the production record are compared row by row with what
// is stored (/import/compare, written nowhere), and the import writes only the
// rows that differ: a row that would change nothing is counted as unchanged
// and keeps its last change. The same file imported twice writes nothing the
// second time.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { ImportCompareResponse, ImportResult, ProductionRecordImportRow } from '@qc/shared/api'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session

const LINES = [
  { lineKey: '462484', orderNumber: '19145-Ph1.23-EHF-(Rail)', item: 'Shuttle Rail : 215-SQ : 2550 : 25', itemCode: 'SH.RA.', workCenterCode: '19', requiredQty: 24, finishedQty: 24, drawing: 'Gasp.334-196457 (mm), SH060 (5-Inch)', date: '2025-05-15T11:07:44.000Z', planningWeek: '01/2026', shippingStatus: 'Shipped', dueDate: '2026-02-25' },
  { lineKey: '462494', orderNumber: '19145-Ph1.23-EHF-(Rail)', item: 'Shuttle Rail : 215-SQ : 3800 : 25', itemCode: 'SH.RA.', workCenterCode: '19', requiredQty: 24, finishedQty: 24, drawing: '(V)', drawingAlt: 'CUS19350-23', date: '2025-05-15T11:07:44.000Z', planningWeek: '01/2026', shippingStatus: null, dueDate: '2026-02-25' },
]

const RECORD: ProductionRecordImportRow = {
  lineKey: '462484',
  erpRecordId: '113290',
  week: '01/2026',
  orderNumber: '19145-Ph1.23-EHF-(Rail)',
  item: 'Shuttle Rail : 215-SQ : 2550 : 25',
  producedQty: 24,
  dayNo: 'Day1',
  workDay: '2025-12-26',
  workCenterCode: '19',
  actualHours: 2,
  plannedHours: 1.76,
}

const post = <T>(path: string, rows: unknown[]) => app.api<T>('POST', path, { token: admin.token, body: { rows } })
const changedAt = async (key: string) =>
  (await app.db.query<{ at: string }>(`SELECT updated_at::text AS at FROM production_orders WHERE line_key = $1`, [key])).rows[0].at

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
})
afterAll(() => app.stop())

describe('the order sheet imported again', () => {
  it('says what a file would add and change, writes only that, and the same file again writes nothing', async () => {
    expect((await post<ImportCompareResponse>('/api/orders/import/compare', LINES)).body).toEqual({ new: ['462484', '462494'], changed: [] })
    expect((await post<ImportResult>('/api/orders/import', LINES)).body).toEqual({ inserted: 2, updated: 0, unchanged: 0 })
    const before = await changedAt('462494')

    // The same rows again: nothing to compare as changed, nothing written.
    expect((await post<ImportCompareResponse>('/api/orders/import/compare', LINES)).body).toEqual({ new: [], changed: [] })
    expect((await post<ImportResult>('/api/orders/import', LINES)).body).toEqual({ inserted: 0, updated: 0, unchanged: 2 })
    expect(await changedAt('462494')).toBe(before)

    // One value changed (an ERP detail cleared counts too), one line added: only those.
    const next = [{ ...LINES[0], finishedQty: 20 }, { ...LINES[1], shippingStatus: 'Shipped' }, { ...LINES[1], lineKey: '535200' }]
    expect((await post<ImportCompareResponse>('/api/orders/import/compare', next)).body).toEqual({ new: ['535200'], changed: ['462484', '462494'] })
    expect((await post<ImportResult>('/api/orders/import', next)).body).toEqual({ inserted: 1, updated: 2, unchanged: 0 })
    const cleared = [{ ...next[1], shippingStatus: null }]
    expect((await post<ImportCompareResponse>('/api/orders/import/compare', cleared)).body).toEqual({ new: [], changed: ['462494'] })

    // A column a file does not carry leaves the stored value as it is: no change.
    const { finishedQty: _left, ...without } = next[0]
    expect((await post<ImportResult>('/api/orders/import', [without])).body).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
  })

  it('brings back a line marked deleted even when its values are the same', async () => {
    await app.db.query(`UPDATE production_orders SET deleted_at = now() WHERE line_key = '462484'`)
    const row = { ...LINES[0], finishedQty: 20 }
    expect((await post<ImportCompareResponse>('/api/orders/import/compare', [row])).body).toEqual({ new: [], changed: ['462484'] })
    expect((await post<ImportResult>('/api/orders/import', [row])).body).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect((await app.db.query(`SELECT 1 FROM production_orders WHERE line_key = '462484' AND deleted_at IS NULL`)).rowCount).toBe(1)
  })
})

describe('the production record imported again', () => {
  it('writes a record only when something in it changed', async () => {
    expect((await post<ImportCompareResponse>('/api/production-records/import/compare', [RECORD])).body).toEqual({ new: ['462484||113290'], changed: [] })
    expect((await post<ImportResult>('/api/production-records/import', [RECORD])).body).toEqual({ inserted: 1, updated: 0, unchanged: 0 })
    expect((await post<ImportCompareResponse>('/api/production-records/import/compare', [RECORD])).body).toEqual({ new: [], changed: [] })
    expect((await post<ImportResult>('/api/production-records/import', [RECORD])).body).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
    const more = { ...RECORD, producedQty: 30 }
    expect((await post<ImportCompareResponse>('/api/production-records/import/compare', [more])).body).toEqual({ new: [], changed: ['462484||113290'] })
    expect((await post<ImportResult>('/api/production-records/import', [more])).body).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
  })
})

describe('a batch of a large export', () => {
  it('may come gzipped, as the importer sends it', async () => {
    const rows = [{ ...LINES[0], lineKey: '700001' }]
    const res = await fetch(`${app.baseUrl}/api/orders/import/compare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ rows })),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ new: ['700001'], changed: [] })
  })

  it('takes 1,000 rows of the order sheet in one request', async () => {
    const wide = Array.from({ length: 1000 }, (_, i) => ({
      ...LINES[0],
      lineKey: String(600000 + i),
      delayComment: 'x'.repeat(400),
      statusReason: 'y'.repeat(400),
      coilSerialNumber: 'z'.repeat(400),
    }))
    const res = await post<ImportResult>('/api/orders/import', wide)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    expect(res.body).toEqual({ inserted: 1000, updated: 0, unchanged: 0 })
  })
})
