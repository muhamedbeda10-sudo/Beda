import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { OrderListOptionsResponse, OrderListResponse } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let viewer: Session
let inspector: Session
const get = (query: string, token: string) => app.api<OrderListResponse>('GET', `/api/orders/list${query ? `?${query}` : ''}`, { token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  viewer = await app.login('watcher')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '24', name: 'Stam Upright', line: 'B', displayName: '24-Stam Upright', process: 'punching', factory: 'Factory 2' } })
  // 150 lines: a needle at line 137, the rest filler on two machines, one of them cancelled.
  const rows = Array.from({ length: 150 }, (_, i) => ({
    lineKey: `L-${i + 1}`,
    orderNumber: i === 136 ? '20999-NEEDLE' : `2${String(i).padStart(4, '0')}-Ph1-XYZ`,
    item: i === 136 ? 'Deep Shelf Panel' : 'XL Light Beam',
    itemCode: i === 136 ? 'DSP-9' : `125185TA${i % 7}`,
    workCenterCode: i % 2 === 0 ? '58' : '024',
    requiredQty: 100,
    finishedQty: i % 3 === 0 ? 100 : 40,
    customer: i % 5 === 0 ? 'El Hoda Foods' : 'Beta Storage',
    expectedGrade: 'S355JR',
    drawing: `D-${i + 1}`,
    erpStatus: i === 10 ? 'Cancel' : 'Active',
  }))
  const imported = await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows } })
  expect(imported.status).toBe(200)
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders?search=20999&includeCancelled=true', { token: admin.token })).body
  const needle = orders.find((o) => o.orderNumber === '20999-NEEDLE')!
  await app.api('POST', '/api/sessions', { token: admin.token, body: { orderId: needle.id, startQty: 0 } })
})
afterAll(() => app.stop())

describe('§19 — Access: the imported lines as a table', () => {
  it('pages the whole sheet and counts every line, cancelled ones included', async () => {
    const first = await get('', admin.token)
    expect(first.status).toBe(200)
    expect(first.body.orders).toHaveLength(100)
    expect(first.body.total).toBe(150)
    expect(first.body.hasMore).toBe(true)
    const rest = await get('offset=100', admin.token)
    expect(rest.body.orders).toHaveLength(50)
    expect(rest.body.hasMore).toBe(false)
    expect(first.body.orders.some((o) => o.erpStatus === 'Cancel') || rest.body.orders.some((o) => o.erpStatus === 'Cancel')).toBe(true)
    // Each line carries its remaining quantity and its factory from the machine catalogue.
    const any = first.body.orders[0]
    expect(any.remainingQty).toBe(any.requiredQty - any.finishedQty)
    expect(['Factory 1', 'Factory 2']).toContain(any.factory)
  })

  it('finds the needle by any of its words, past the first page', async () => {
    for (const q of ['NEEDLE', 'deep shelf', 'DSP-9', 'L-137', 'D-137']) {
      const res = await get(`q=${encodeURIComponent(q)}`, admin.token)
      expect(res.body.total, q).toBe(1)
      expect(res.body.orders[0].orderNumber).toBe('20999-NEEDLE')
    }
  })

  it('filters by machine as the floor writes it, by factory, by status, by remaining and by inspected', async () => {
    expect((await get('workCenterCode=24', admin.token)).body.total).toBe(75)
    expect((await get('workCenterCode=%20024%20', admin.token)).body.total).toBe(75)
    expect((await get('factory=Factory%202', admin.token)).body.total).toBe(75)
    expect((await get('erpStatus=cancel', admin.token)).body.total).toBe(1)
    expect((await get('item=dsp-9', admin.token)).body.total).toBe(1)
    // i ≡ 3 (mod 7) gives 21 lines in 0..149, less the needle at i = 136, which carries DSP-9.
    expect((await get('item=125185TA3', admin.token)).body.total).toBe(20)
    // Any part of the code or the name, as typed.
    expect((await get('item=125185ta', admin.token)).body.total).toBe(149)
    expect((await get('item=shelf', admin.token)).body.total).toBe(1)
    expect((await get('item=%25', admin.token)).body.total).toBe(0)
    expect((await get('remaining=done', admin.token)).body.total).toBe(50)
    expect((await get('remaining=open', admin.token)).body.total).toBe(100)
    const inspected = await get('inspected=yes', admin.token)
    expect(inspected.body.total).toBe(1)
    expect(inspected.body.orders[0].sessions).toBe(1)
    expect((await get('inspected=no', admin.token)).body.total).toBe(149)
    expect((await get('inspected=no&workCenterCode=58&remaining=done', admin.token)).body.total).toBe(25)
  })

  it('is not for an inspector', async () => {
    expect((await get('', inspector.token)).status).toBe(403)
    expect((await app.api('GET', '/api/orders/list/options', { token: inspector.token })).status).toBe(403)
  })

  it('offers the filter options and reads for a viewer', async () => {
    const options = await app.api<OrderListOptionsResponse>('GET', '/api/orders/list/options', { token: viewer.token })
    expect(options.status).toBe(200)
    expect(options.body.erpStatuses).toEqual(['Active', 'Cancel'])
    expect(options.body.factories).toEqual(['Factory 1', 'Factory 2'])
    expect(options.body.workCenterCodes).toEqual(['024', '58'])
    expect(options.body.items).toHaveLength(8)
    expect(options.body.items.find((i) => i.itemCode === 'DSP-9')?.item).toBe('Deep Shelf Panel')
    expect((await get('q=needle', viewer.token)).body.total).toBe(1)
  })
})
