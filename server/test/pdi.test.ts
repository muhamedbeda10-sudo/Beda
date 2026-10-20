// ============================================================================
// §4 — Pre-Delivery Inspection: a PDI covers the items of one order that ship,
// and the list is found in full, filtered in SQL and walked back page by page.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ColumnValuesResponse, OrderItemOption, OrderNumberSummary, PDIListResponse, PDIOptionsResponse, PDIWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, factoryDay, type Session } from './harness'

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
        // Cancelled lines, however the sheet spells it: never offered.
        { lineKey: 'P-6', orderNumber: '19868-Ph2.2B-EHF', item: 'Old Beam', itemCode: 'OB-1', workCenterCode: '58', customer: 'Beta Storage', drawing: 'X', erpStatus: 'Cancelled' },
        { lineKey: 'P-7', orderNumber: '19868-Ph2.2B-EHF', item: 'Old Spacer', itemCode: 'OS-1', workCenterCode: '58', customer: 'Beta Storage', drawing: 'X', erpStatus: 'ملغي' },
        { lineKey: 'P-8', orderNumber: '77777-CAN', item: 'Gone', itemCode: 'G-1', workCenterCode: '31', customer: 'Nobody', drawing: 'X', erpStatus: 'Canceled' },
        // Two items that share an item code stay two.
        { lineKey: 'S-1', orderNumber: '31000-SHARED', item: 'Frame A', itemCode: 'FR-1', workCenterCode: '31', customer: 'Gamma', drawing: 'FA' },
        { lineKey: 'S-2', orderNumber: '31000-SHARED', item: 'Frame B', itemCode: 'FR-1', workCenterCode: '31', customer: 'Gamma', drawing: 'FB' },
      ],
    },
  })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting', line: 'LM4', displayName: '48-Painting-LM4', process: 'paint', factory: 'Factory 2' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'Welding', line: 'LM4', displayName: '58-Welding-LM4', process: 'welding', factory: 'Factory 1' } })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders?limit=100&includeCancelled=true', { token: admin.token })).body
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

  it('finds it by every word typed, in any order', async () => {
    for (const search of ['19868 ph2', 'ph2 19868', 'EHF 2.2b']) {
      const res = await app.api<OrderNumberSummary[]>('GET', `/api/orders/numbers?search=${encodeURIComponent(search)}&match=contains`, { token: inspector.token })
      expect(res.body.map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF'])
    }
  })

  it('never offers a cancelled line, however the sheet spells it', async () => {
    const all = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?match=contains&search=-', { token: inspector.token })
    expect(all.body.map((o) => o.orderNumber)).not.toContain('77777-CAN')
    // The order's own lines leave the cancelled ones out, and so does its count.
    expect(all.body.find((o) => o.orderNumber === '19868-Ph2.2B-EHF')!.lineCount).toBe(4)
    const lines19868 = await app.api<ProductionOrder[]>('GET', '/api/orders?orderNumber=19868-Ph2.2B-EHF&limit=500', { token: inspector.token })
    expect(lines19868.body.map((o) => o.lineKey).sort()).toEqual(['P-1', 'P-2', 'P-3', 'P-4'])
  })

  it('narrows to the orders with a line in a factory, on a machine or of an item', async () => {
    const list = async (query: string) => (await app.api<OrderNumberSummary[]>('GET', `/api/orders/numbers?match=contains&${query}`, { token: inspector.token })).body
    expect((await list('factory=Factory%202')).map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF', '20480-Ph1.4-SMA'])
    const onWelding = await list('machine=58')
    expect(onWelding.map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF'])
    // The count is every line of the order, not the lines on that machine.
    expect(onWelding[0].lineCount).toBe(4)
    expect((await list('item=shuttle')).map((o) => o.orderNumber)).toEqual(['20480-Ph1.4-SMA'])
    expect((await list('item=DR-100')).map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF'])
    expect((await list('item=beam&factory=Factory%201&search=198')).map((o) => o.orderNumber)).toEqual(['19868-Ph2.2B-EHF'])
    // A cancelled line does not make its order a match.
    expect(await list('item=old%20beam')).toEqual([])
  })

  it('lists the items of the open lines for the item list, narrowed and searched', async () => {
    const all = (await app.api<OrderItemOption[]>('GET', '/api/orders/items', { token: inspector.token })).body
    expect(all.map((i) => i.item)).toEqual(['Base Plate', 'Frame A', 'Frame B', 'Shuttle Beam', 'Upright 80x60', 'XL Light Beam'])
    expect(all.find((i) => i.item === 'Upright 80x60')!.lineCount).toBe(2)
    const onPaint = (await app.api<OrderItemOption[]>('GET', '/api/orders/items?factory=Factory%202', { token: inspector.token })).body
    expect(onPaint.map((i) => i.item)).toEqual(['Shuttle Beam', 'Upright 80x60'])
    expect((await app.api<OrderItemOption[]>('GET', '/api/orders/items?search=light%20xl', { token: inspector.token })).body.map((i) => i.item)).toEqual(['XL Light Beam'])
    // An item picked from the list narrows the orders to it exactly.
    const picked = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?match=contains&itemCode=FR-1&itemName=Frame%20B', { token: inspector.token })
    expect(picked.body.map((o) => o.orderNumber)).toEqual(['31000-SHARED'])
    expect((await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?match=contains&itemCode=FR-1&itemName=Frame%20C', { token: inspector.token })).body).toEqual([])
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

  it('keeps two items that share a code apart', async () => {
    const res = await app.api<PDIWithOrder>('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [line('S-1').id, line('S-2').id], notes: 'Frames', imageIds: [] } })
    expect(res.status).toBe(201)
    expect(res.body.items.map((i) => [i.itemCode, i.item, i.drawings])).toEqual([
      ['FR-1', 'Frame A', ['FA']],
      ['FR-1', 'Frame B', ['FB']],
    ])
  })

  it('refuses a cancelled line', async () => {
    const res = await app.api<{ error: string }>('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [line('P-1').id, line('P-6').id], imageIds: [] } })
    expect(res.status).toBe(400)
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
    expect(page.body.total).toBe(4)
    expect(page.body.hasMore).toBe(true)
    expect(page.body.documents.map((d) => d.notes)).toEqual(['Shuttle beams', 'Second delivery'])
    const before = page.body.documents[1].createdAt
    const older = await app.api<PDIListResponse>('GET', `/api/pdi?limit=2&before=${encodeURIComponent(before)}`, { token: viewer.token })
    expect(older.body.documents.map((d) => d.notes)).toEqual(['Frames', 'First delivery'])
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
    // Days as the PDI list reads them: factory days (08:00 to 08:00).
    const today = factoryDay()
    const tomorrow = factoryDay(2)
    expect((await app.api<PDIListResponse>('GET', `/api/pdi?from=${today}&to=${tomorrow}`, { token: viewer.token })).body.total).toBe(4)
    expect((await app.api<PDIListResponse>('GET', `/api/pdi?from=${tomorrow}&to=${tomorrow}`, { token: viewer.token })).body.total).toBe(0)
    expect((await app.api('GET', `/api/pdi?from=${tomorrow}&to=${today}`, { token: viewer.token })).status).toBe(400)
  })

  it('offers everyone who recorded one', async () => {
    const res = await app.api<PDIOptionsResponse>('GET', '/api/pdi/options', { token: viewer.token })
    expect(res.body.createdBy.map((c) => c.name)).toEqual(['Admin', 'Inspector One'])
  })

  describe('Excel\'s column filters, over every PDI', () => {
    const cf = (filters: object) => `cf=${encodeURIComponent(JSON.stringify(filters))}`
    const list = (query: string) => app.api<PDIListResponse>('GET', `/api/pdi?${query}`, { token: viewer.token })
    const values = (query: string) => app.api<ColumnValuesResponse>('GET', `/api/pdi/values?${query}`, { token: viewer.token })

    it('ticks values, leaves some out, and finds a piece of text in any column', async () => {
      const ticked = await list(cf({ order: { values: ['19868-Ph2.2B-EHF'] } }))
      expect(ticked.body.total).toBe(2)
      expect(ticked.body.documents.map((d) => d.notes)).toEqual(['Second delivery', 'First delivery'])
      const allBut = await list(cf({ order: { except: ['19868-Ph2.2B-EHF'] } }))
      expect(allBut.body.documents.map((d) => d.notes)).toEqual(['Shuttle beams', 'Frames'])
      // Every item a PDI covers is in its cell, not only the first.
      expect((await list(cf({ items: { contains: 'frame b' } }))).body.documents.map((d) => d.notes)).toEqual(['Frames'])
      expect((await list(cf({ items: { contains: 'upright' }, by: { values: ['Inspector One'] } }))).body.total).toBe(1)
    })

    it('lists a column\'s values under every other filter, with their counts', async () => {
      const orders = await values('column=order')
      expect(orders.status).toBe(200)
      expect(orders.body.values).toEqual([
        { value: '19868-Ph2.2B-EHF', count: 2 },
        { value: '20480-Ph1.4-SMA', count: 1 },
        { value: '31000-SHARED', count: 1 },
      ])
      // The order filter narrows who is listed; the column's own filter does not narrow its own list.
      const by = await values(`column=by&${cf({ order: { values: ['19868-Ph2.2B-EHF'] }, by: { values: ['Admin'] } })}`)
      expect(by.body.values).toEqual([
        { value: 'Admin', count: 1 },
        { value: 'Inspector One', count: 1 },
      ])
      expect((await values('column=customer&search=ta')).body.values.map((v) => v.value)).toEqual(['Beta Storage'])
    })

    it('sorts by a column and pages by position, counting on the first page only', async () => {
      const first = await list('sort=customer:asc&limit=2')
      expect(first.body.documents.map((d) => d.customer)).toEqual(['Alpha Racking', 'Beta Storage'])
      expect(first.body.total).toBe(4)
      expect(first.body.hasMore).toBe(true)
      const next = await list('sort=customer:asc&limit=2&offset=2')
      expect(next.body.documents.map((d) => d.customer)).toEqual(['Beta Storage', 'Gamma'])
      expect(next.body.hasMore).toBe(false)
      expect(next.body.total).toBeUndefined()
      expect((await list('sort=photos:desc&limit=10')).body.total).toBe(4)
    })

    it('exports what the column filters let through, and refuses a column it does not have', async () => {
      const exported = await app.api<PDIWithOrder[]>('GET', `/api/pdi/export?${cf({ customer: { values: ['Gamma'] } })}`, { token: admin.token })
      expect(exported.body.map((d) => d.notes)).toEqual(['Frames'])
      expect((await list(cf({ secret: { values: ['x'] } }))).status).toBe(400)
      expect((await list('sort=secret:asc')).status).toBe(400)
      expect((await values('column=secret')).status).toBe(400)
    })
  })
})
