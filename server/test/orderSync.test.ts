// ============================================================================
// §7.7 — the order sheet synced from the factory's Access database by an
// agent with an integration key: when a sync is due, a run in batches, the
// lines the run did not see retired only when it read the table whole, and
// the key good for nothing else and revocable.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { CreateIntegrationKeyResponse, OrderSyncDueResponse, OrderSyncRowsResponse, OrderSyncRun, OrderSyncStartResponse, OrderSyncStatusResponse } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let secret: string
let keyId: string

/** A row as the Access table gives it, with its own column names. */
const accessRow = (id: string, extra: Record<string, unknown> = {}) => ({
  'Order ID': id,
  Order: `ORD-${id}`,
  'Item ID': `IT-${id}`,
  Item: `Item ${id}`,
  'Work Center': '31',
  'Req Q': 100,
  'Finished Q': '1,250',
  'Raw Material Description': 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO',
  'Release Date': '2026-09-01T00:00:00.000Z',
  'Access Status': 'Active',
  Remarks: 'kept by the planners',
  ...extra,
})

const agent = <T>(method: string, path: string, body?: unknown, key = secret) => app.api<T>(method, `/api/agent/order-sync${path}`, { body, headers: { authorization: `Bearer ${key}` } })

/** One whole run: start, the rows in batches, finish with the count read. */
async function sync(rows: Record<string, unknown>[], opts: { batch?: number; total?: number } = {}): Promise<OrderSyncRun> {
  const start = await agent<OrderSyncStartResponse>('POST', '/runs', { source: 'PLANNING-PC · Orders' })
  expect(start.status).toBe(201)
  const size = opts.batch ?? 500
  for (let i = 0; i < rows.length; i += size) {
    const res = await agent<OrderSyncRowsResponse>('POST', `/runs/${start.body.runId}/rows`, { rows: rows.slice(i, i + size) })
    expect(res.status).toBe(200)
  }
  const done = await agent<OrderSyncRun>('POST', `/runs/${start.body.runId}/finish`, { total: opts.total ?? rows.length })
  expect(done.status).toBe(200)
  return done.body
}

const liveOrders = async () => (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  const created = await app.api<CreateIntegrationKeyResponse>('POST', '/api/integrations/keys', { token: admin.token, body: { name: 'Planning PC' } })
  expect(created.status).toBe(201)
  secret = created.body.secret
  keyId = created.body.key.id
})
afterAll(() => app.stop())

describe('§7.7 — order sync from Access', () => {
  it('gives the key once and keeps only its hash', async () => {
    expect(secret).toMatch(/^qck_[A-Za-z0-9_-]{43}$/)
    const stored = await app.db.query<{ key_hash: string; prefix: string }>(`SELECT key_hash, prefix FROM integration_keys WHERE id = $1`, [keyId])
    expect(stored.rows[0].key_hash).not.toContain(secret)
    expect(secret.startsWith(stored.rows[0].prefix)).toBe(true)
    const status = await app.api<OrderSyncStatusResponse>('GET', '/api/integrations/order-sync', { token: admin.token })
    expect(JSON.stringify(status.body)).not.toContain(secret)
  })

  it('refuses the agent without a valid key, and a person without the administrator role', async () => {
    expect((await agent('GET', '/due', undefined, 'qck_nope')).status).toBe(401)
    expect((await app.api('GET', '/api/agent/order-sync/due')).status).toBe(401)
    // A person's session is not an integration key.
    expect((await app.api('GET', '/api/agent/order-sync/due', { token: admin.token })).status).toBe(401)
    const insp = await app.register('insp', 'Inspector')
    expect((await app.api('GET', '/api/integrations/order-sync', { token: insp.token })).status).toBe(403)
    expect((await app.api('POST', '/api/integrations/keys', { token: insp.token, body: { name: 'x' } })).status).toBe(403)
  })

  it('is due the first time, then not until the interval or a request', async () => {
    expect((await agent<OrderSyncDueResponse>('GET', '/due')).body).toMatchObject({ due: true, reason: 'first', intervalMinutes: 15 })
    const run = await sync([accessRow('A1'), accessRow('A2')])
    expect(run).toMatchObject({ status: 'success', rowsReceived: 2, rowsExpected: 2, inserted: 2, updated: 0, retired: 0, invalid: 0, keyName: 'Planning PC' })
    expect(run.unknownColumns).toEqual(['Remarks'])
    expect((await agent<OrderSyncDueResponse>('GET', '/due')).body).toMatchObject({ due: false, reason: 'not-yet' })
    // Sync now: the next check says go, and the run answers the request.
    expect((await app.api('POST', '/api/integrations/order-sync/request', { token: admin.token })).status).toBe(204)
    expect((await app.api<OrderSyncStatusResponse>('GET', '/api/integrations/order-sync', { token: admin.token })).body.pendingRequest?.requestedByName).toBe('Admin')
    expect((await agent<OrderSyncDueResponse>('GET', '/due')).body).toMatchObject({ due: true, reason: 'requested' })
    await sync([accessRow('A1'), accessRow('A2')])
    expect((await app.api<OrderSyncStatusResponse>('GET', '/api/integrations/order-sync', { token: admin.token })).body.pendingRequest).toBeNull()
  })

  it("reads the Access columns as the importer does: numbers, dates and the grade from the material", async () => {
    const line = (await liveOrders()).find((o) => o.lineKey === 'A1')!
    expect(line).toMatchObject({ orderNumber: 'ORD-A1', itemCode: 'IT-A1', item: 'Item A1', workCenterCode: '31', requiredQty: 100, finishedQty: 1250, expectedGrade: 'S315MC', erpStatus: 'Active' })
  })

  it('updates in batches and retires a line the whole table no longer carries', async () => {
    const rows = ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => accessRow(id, { 'Finished Q': 300 }))
    const grow = await sync(rows, { batch: 2 })
    expect(grow).toMatchObject({ status: 'success', inserted: 3, updated: 2, retired: 0 })
    // A5 leaves the table: four of five lines seen, one retired.
    const shrink = await sync(rows.slice(0, 4), { batch: 3 })
    expect(shrink).toMatchObject({ status: 'success', retired: 1 })
    expect((await liveOrders()).map((o) => o.lineKey).sort()).toEqual(['A1', 'A2', 'A3', 'A4'])
    // Back in the table: back in the app.
    await sync(rows)
    expect((await liveOrders()).map((o) => o.lineKey).sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5'])
  })

  it('retires nothing from a run that did not arrive whole, read every row, or would retire more than half', async () => {
    const all = ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => accessRow(id))
    // The agent read five but sent four.
    const partial = await sync(all.slice(0, 4), { total: 5 })
    expect(partial).toMatchObject({ status: 'failed', retired: 0 })
    // A row that cannot be read.
    const bad = await sync([...all.slice(0, 4), accessRow('A5', { 'Req Q': 'many' })])
    expect(bad).toMatchObject({ status: 'warning', invalid: 1, retired: 0 })
    expect(bad.errors).toEqual([{ row: 5, lineKey: 'A5', message: 'Required qty is not a number ("many")' }])
    // A new line without its order number is that row's error, not the batch's.
    const orphan = await sync([...all, accessRow('B1', { Order: '' })])
    expect(orphan).toMatchObject({ status: 'warning', invalid: 1, inserted: 0 })
    expect(orphan.errors[0]).toMatchObject({ row: 6, lineKey: 'B1' })
    // Two of five: more than half would go.
    const tiny = await sync(all.slice(0, 2))
    expect(tiny).toMatchObject({ status: 'warning', retired: 0 })
    expect(tiny.message).toContain('more than half')
    expect(await liveOrders()).toHaveLength(5)
  })

  it('never retires a make-to-stock line', async () => {
    await app.db.query(`INSERT INTO production_orders (line_key, order_number, item, item_code, work_center_code) VALUES ('STOCK-31', 'STOCK', 'Stock', 'ST', '31')`)
    const run = await sync(['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => accessRow(id)))
    expect(run).toMatchObject({ status: 'success', retired: 0 })
    expect((await app.db.query(`SELECT deleted_at FROM production_orders WHERE line_key = 'STOCK-31'`)).rows[0].deleted_at).toBeNull()
  })

  it('reads Access moments without an offset as factory time, as the file importer does, so a line never flips', async () => {
    const all = ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => accessRow(id, { 'Release Date': id === 'A1' ? '2026-09-01T14:30:00' : '2026-09-01T00:00:00.000Z' }))
    // The agent's form, yyyy-MM-ddTHH:mm:ss: 14:30 on the factory floor (Cairo, UTC+3 in September).
    await sync(all)
    const stored = async () => (await app.db.query<{ at: string }>(`SELECT to_char(order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS at FROM production_orders WHERE line_key = 'A1'`)).rows[0].at
    expect(await stored()).toBe('2026-09-01T11:30')
    // The same line again, from either path, reads the same moment.
    await sync(all)
    expect(await stored()).toBe('2026-09-01T11:30')
    const line = (await liveOrders()).find((o) => o.lineKey === 'A1')!
    const viaFile = await app.api<{ inserted: number; updated: number; unchanged: number }>('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ lineKey: 'A1', orderNumber: line.orderNumber, item: line.item, itemCode: line.itemCode, workCenterCode: line.workCenterCode, date: new Date(Date.UTC(2026, 8, 1, 11, 30)).toISOString() }] },
    })
    expect(viaFile.body).toMatchObject({ updated: 0, unchanged: 1 })
    expect(await stored()).toBe('2026-09-01T11:30')
  })

  it('runs one at a time, fails a run the agent gives up on, and says so', async () => {
    const first = await agent<OrderSyncStartResponse>('POST', '/runs', { source: 'PLANNING-PC' })
    expect((await agent('POST', '/runs', { source: 'OTHER' })).status).toBe(409)
    expect((await agent<OrderSyncDueResponse>('GET', '/due')).body).toMatchObject({ due: false, reason: 'running' })
    expect((await agent('POST', `/runs/${first.body.runId}/fail`, { message: 'The Access file is locked.' })).status).toBe(204)
    const status = (await app.api<OrderSyncStatusResponse>('GET', '/api/integrations/order-sync', { token: admin.token })).body
    expect(status.runs[0]).toMatchObject({ status: 'failed', message: 'The Access file is locked.' })
    // A finished run takes no more rows.
    expect((await agent('POST', `/runs/${first.body.runId}/rows`, { rows: [accessRow('A1')] })).status).toBe(400)
  })

  it('refuses a table with no Order ID column', async () => {
    const start = await agent<OrderSyncStartResponse>('POST', '/runs', { source: 'PLANNING-PC' })
    const res = await agent<{ error: { message: string } }>('POST', `/runs/${start.body.runId}/rows`, { rows: [{ Item: 'x' }] })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('Order ID')
    await agent('POST', `/runs/${start.body.runId}/fail`, { message: 'wrong table' })
  })

  it('stops a revoked key at once', async () => {
    expect((await app.api('POST', `/api/integrations/keys/${keyId}/revoke`, { token: admin.token })).status).toBe(204)
    expect((await agent('GET', '/due')).status).toBe(401)
    const keys = (await app.api<OrderSyncStatusResponse>('GET', '/api/integrations/order-sync', { token: admin.token })).body.keys
    expect(keys[0].revokedAt).toBeTruthy()
    expect((await app.api('POST', `/api/integrations/keys/${keyId}/revoke`, { token: admin.token })).status).toBe(404)
  })
})
