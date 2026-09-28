// ============================================================================
// §4 — Pre-Delivery Inspection: a PDI covers the items of one order that ship,
// and the list is found in full, filtered in SQL and walked back page by page.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { OrderNumberSummary, PDIListResponse, PDIOptionsResponse, PDIWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let viewer: Session
let lines: ProductionOrder[]
const line = (key: string) => lines.find((o) => o.lineKey === key)!

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  viewer = await app.login('watcher')
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        // One order, three items; the upright runs on two machines with a drawing each.
        { lineKey: 'P-1', orderNumber: '19868-Ph2.2B-EHF', item: 'Upright 80x60', itemCode: 'UP8060', workCenterCode: '31', customer: 'Beta Storage', drawing: 'DR-100/31' },
        { lineKey: 'P-2', orderNumber: '19868-Ph2.2B-EHF', item: 'Upright 80x60', itemCode: 'UP8060', workCenterCode: '48', customer: 'Beta Storage', drawing: 'DR-100/48' },
        { lineKey: 'P-3', orderNumber: '19868-Ph2.2B-EHF', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', customer: 'Beta Storage', drawing: 'BS9059/58' },
        { lineKey: 'P-4', orderNumber: '19868-Ph2.2B-EHF', item: 'Base Plate', itemCode: 'BP-10', workCenterCode: '58', customer: 'Beta Storage', drawing: '' },
        { lineKey: 'P-5', orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015', workCenterCode: '48', customer: 'Alpha Racking', drawing: 'BS9059/48' },
      ],
    },
  })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders?limit=100', { token: admin.token })).body
})
afterAll(() => app.stop())

describe('§4 — finding the order', () => {
  it('finds an order number by any part of it, those that start with it first', async () => {
    const mid = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?search=Ph2.2B&match=contains', { token: inspector.token })
    expect(mid.body.map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF'])
    expect(mid.body[0].lineCount).toBe(4)
    // The start of a number stays the only match for the inspection screen's prefix search.
    expect((await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?search=Ph2.2B', { token: inspector.token })).body).toEqual([])
    const both = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?search=2&match=contains', { token: inspector.token })
    expect(both.body.map((o) => o.orderNumber)).toEqual(['20480-Ph1.4-SMA', '19868-Ph2.2B-EHF'])
  })

  it('lists every line of the order, however many', async () => {
    const all = await app.api<ProductionOrder[]>('GET', '/api/orders?orderNumber=19868-ph2.2b-ehf&limit=500', { token: inspector.token })
    expect(all.body.map((o) => o.lineKey).sort()).toEqual(['P-1', 'P-2', 'P-3', 'P-4'])
  })
})

describe('§4 — a PDI covers the items ticked', () => {
  let first: PDIWithOrder

  it('records the lines of the items ticked, grouped by item with their drawings', async () => {
    const res = await app.api<PDIWithOrder>('POST', '/api/pdi', {
      token: inspector.token,
      body: { orderIds: [line('P-1').id, line('P-2').id, line('P-4').id], notes: 'First delivery', imageIds: [] },
    })
    expect(res.status).toBe(201)
    first = res.body
    expect(first.orderNumber).toBe('19868-Ph2.2B-EHF')
    expect(first.customer).toBe('Beta Storage')
    expect(first.items.map((i) => [i.itemCode, i.item, [...i.drawings].sort(), i.lineIds.length])).toEqual([
      ['BP-10', 'Base Plate', [], 1],
      ['UP8060', 'Upright 80x60', ['DR-100/31', 'DR-100/48'], 2],
    ])
  })

  it('refuses lines of two orders, an unknown line, and nothing ticked', async () => {
    const mixed = await app.api('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [line('P-3').id, line('P-5').id], imageIds: [] } })
    expect(mixed.status).toBe(400)
    const unknown = await app.api('POST', '/api/pdi', { token: inspector.token, body: { orderIds: ['00000000-0000-4000-8000-000000000000'], imageIds: [] } })
    expect(unknown.status).toBe(400)
    expect((await app.api('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [], imageIds: [] } })).status).toBe(400)
    expect((await app.api('POST', '/api/pdi', { token: viewer.token, body: { orderIds: [line('P-5').id], imageIds: [] } })).status).toBe(403)
  })

  it('is audited with the order and how many items it covers', async () => {
    const { rows } = await app.db.query<{ order_number: string; item: string }>(`SELECT order_number, item FROM audit_log WHERE entity = 'PDIDocument' AND entity_id = $1`, [first.id])
    expect(rows).toEqual([{ order_number: '19868-Ph2.2B-EHF', item: '2 items' }])
  })
})

describe('§4 — the PDI list', () => {
  beforeAll(async () => {
    await app.api('POST', '/api/pdi', { token: admin.token, body: { orderIds: [line('P-3').id], notes: 'Second delivery', imageIds: [] } })
    await app.api('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [line('P-5').id], notes: 'Shuttle beams', imageIds: [] } })
  })

  it('lists every PDI newest first, with the total, and walks back', async () => {
    const page = await app.api<PDIListResponse>('GET', '/api/pdi?limit=2', { token: viewer.token })
    expect(page.status).toBe(200)
    expect(page.body.total).toBe(3)
    expect(page.body.hasMore).toBe(true)
    expect(page.body.documents.map((d) => d.notes)).toEqual(['Shuttle beams', 'Second delivery'])
    const before = page.body.documents[1].createdAt
    const older = await app.api<PDIListResponse>('GET', `/api/pdi?limit=2&before=${encodeURIComponent(before)}`, { token: viewer.token })
    expect(older.body.documents.map((d) => d.notes)).toEqual(['First delivery'])
    expect(older.body.hasMore).toBe(false)
    expect(older.body.total).toBeUndefined()
  })

  it('narrows by any text, by item or drawing, by who and by day', async () => {
    const byDrawing = await app.api<PDIListResponse>('GET', '/api/pdi?q=DR-100', { token: viewer.token })
    expect(byDrawing.body.documents.map((d) => d.notes)).toEqual(['First delivery'])
    const byCustomer = await app.api<PDIListResponse>('GET', '/api/pdi?q=alpha', { token: viewer.token })
    expect(byCustomer.body.documents.map((d) => d.notes)).toEqual(['Shuttle beams'])
    const byItem = await app.api<PDIListResponse>('GET', '/api/pdi?item=light%20beam', { token: viewer.token })
    expect(byItem.body.documents.map((d) => d.notes)).toEqual(['Second delivery'])
    const byWho = await app.api<PDIListResponse>('GET', `/api/pdi?createdById=${admin.user.id}`, { token: viewer.token })
    expect(byWho.body.documents.map((d) => d.notes)).toEqual(['Second delivery'])
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await app.api<PDIListResponse>('GET', `/api/pdi?from=${today}&to=${tomorrow}`, { token: viewer.token })).body.total).toBe(3)
    expect((await app.api<PDIListResponse>('GET', `/api/pdi?from=${tomorrow}&to=${tomorrow}`, { token: viewer.token })).body.total).toBe(0)
    expect((await app.api('GET', `/api/pdi?from=${tomorrow}&to=${today}`, { token: viewer.token })).status).toBe(400)
  })

  it('offers everyone who recorded one', async () => {
    const res = await app.api<PDIOptionsResponse>('GET', '/api/pdi/options', { token: viewer.token })
    expect(res.body.createdBy.map((c) => c.name)).toEqual(['Admin', 'Inspector One'])
  })
})
