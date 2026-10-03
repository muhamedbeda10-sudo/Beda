// ============================================================================
// Two items of one order can share a code: "Locker Slopping Top Front : 300 :
// 450 : N2" and "… : N3", both LST-300, both on the same press. Each is its
// own item: its notes and photos, its earlier-defect marker, the nominals
// offered again, its grouped sessions and a pick from an item list never
// reach the other.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HistoryGroupResponse, HistoryOptionsResponse, HistoryResponse, OrderListOptionsResponse, OrderListResponse, SessionNotesResponse, SessionWithOrder, WizardContext } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
const N2 = 'Locker Slopping Top Front : 300 : 450 : N2'
const N3 = 'Locker Slopping Top Front : 300 : 450 : N3'
let lineN2: ProductionOrder
let lineN3: ProductionOrder
let sessionN2: SessionWithOrder
let sessionN3: SessionWithOrder

const sample = (opts: { defect?: boolean; note?: string; nominal: number }) => ({
  submissionId: randomUUID(),
  drawing: 'D-1',
  sampleQty: 10,
  dimensions: [{ name: 'Width', sequence: 1, nominal: opts.nominal, tolPlus: 0.5, tolMinus: 0.5, actual: opts.nominal, unit: 'mm', source: 'manual' }],
  defects: opts.defect ? [{ defectName: 'Edge', qty: 2, disposition: 'Repair', notes: '', imageIds: [] }] : [],
  coils: [],
  ...(opts.note ? { note: { text: opts.note, imageIds: [] } } : {}),
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Press brake 3', line: 'F1', displayName: 'Press brake 3 F1', process: 'forming' } })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: 'Edge' } })
  const row = (lineKey: string, item: string) => ({ lineKey, orderNumber: '20622-HYH', item, itemCode: 'LST-300', workCenterCode: '31', requiredQty: 100, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing: 'D-1' })
  await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [row('L-N2', N2), row('L-N3', N3)] } })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  lineN2 = orders.find((o) => o.item === N2)!
  lineN3 = orders.find((o) => o.item === N3)!
  sessionN2 = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: lineN2.id, startQty: 0 } })).body
  const s2 = await app.api('POST', `/api/sessions/${sessionN2.id}/samples`, { token: inspector.token, body: sample({ defect: true, note: 'Burr on the N2 lip', nominal: 125 }) })
  if (s2.status !== 201) throw new Error(`N2 sample ${s2.status} ${JSON.stringify(s2.body)}`)
  sessionN3 = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: lineN3.id, startQty: 0 } })).body
})
afterAll(() => app.stop())

describe('two items of one order sharing a code', () => {
  it('keeps the notes (and their photos) on their own line', async () => {
    const n2 = await app.api<SessionNotesResponse>('GET', `/api/orders/${lineN2.id}/notes`, { token: inspector.token })
    const n3 = await app.api<SessionNotesResponse>('GET', `/api/orders/${lineN3.id}/notes`, { token: inspector.token })
    expect(n2.body.notes.map((n) => n.text)).toEqual(['Burr on the N2 lip'])
    expect(n3.body.notes).toEqual([])
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sessionN3.id}/wizard`, { token: inspector.token })
    expect(ctx.status).toBe(200)
    expect(ctx.body.orderNotes).toEqual([])
  })

  it("does not offer one item's nominals to the other", async () => {
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sessionN3.id}/wizard`, { token: inspector.token })
    expect(ctx.body.previousDimensions).toEqual([])
    const own = await app.api<WizardContext>('GET', `/api/sessions/${sessionN2.id}/wizard`, { token: inspector.token })
    expect(own.body.previousDimensions.map((d) => d.nominal)).toEqual([125])
  })

  it("does not mark one item with the other's defects", async () => {
    const s = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionN3.id}`, { token: inspector.token })
    expect(s.body.priorDefectsElsewhere).toBe(false)
  })

  it('groups the sessions of one item by its code and its name', async () => {
    const one = await app.api<HistoryGroupResponse>('GET', `/api/sessions/history/group?itemCode=LST-300&itemName=${encodeURIComponent(N3)}`, { token: admin.token })
    expect(one.body.sessions.map((s) => s.sessionId)).toEqual([sessionN3.id])
    const both = await app.api<HistoryGroupResponse>('GET', '/api/sessions/history/group?itemCode=LST-300', { token: admin.token })
    expect(both.body.sessions.map((s) => s.sessionId).sort()).toEqual([sessionN2.id, sessionN3.id].sort())
  })

  it('lists both items, and a pick lands on that one item in History and Access', async () => {
    const opts = (await app.api<HistoryOptionsResponse>('GET', '/api/sessions/history/options', { token: admin.token })).body
    expect(opts.items.map((i) => i.item).sort()).toEqual([N2, N3])
    const picked = await app.api<HistoryResponse>('GET', `/api/sessions/history?item=${encodeURIComponent(`LST-300 — ${N2}`)}`, { token: admin.token })
    expect(picked.body.sessions.map((s) => s.id)).toEqual([sessionN2.id])
    const typed = await app.api<HistoryResponse>('GET', '/api/sessions/history?item=lst-300', { token: admin.token })
    expect(typed.body.sessions).toHaveLength(2)

    const sheet = (await app.api<OrderListOptionsResponse>('GET', '/api/orders/list/options', { token: admin.token })).body
    expect(sheet.items.map((i) => i.item).sort()).toEqual([N2, N3])
    const lines = await app.api<OrderListResponse>('GET', `/api/orders/list?item=${encodeURIComponent(`LST-300 — ${N3}`)}`, { token: admin.token })
    expect(lines.body.orders.map((o) => o.id)).toEqual([lineN3.id])
  })
})
