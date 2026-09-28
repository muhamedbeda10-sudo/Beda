// ============================================================================
// §6 — History to Excel: the sessions the History filters match, with their
// samples, measurements and defects; and the PDIs the PDI filters match.
// Supervisors, administrators and viewers; never an inspector.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HistoryExportResponse, PDIWithOrder, SessionWithOrder } from '@qc/shared/api'
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
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/item-dimension-order', { token: admin.token, body: { itemCode: 'UP8060', item: 'Upright 80x60', dimensionName: 'Width', sequence: 1, nominal: 80, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'E-1', orderNumber: '40001-A', item: 'Upright 80x60', itemCode: 'UP8060', workCenterCode: '31', customer: 'Beta', drawing: 'D-1' },
        { lineKey: 'E-2', orderNumber: '40002-B', item: 'Base Plate', itemCode: 'BP-1', workCenterCode: '31', customer: 'Gamma', drawing: 'D-2' },
      ],
    },
  })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: line('E-1').id, startQty: 2 } })
  const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, {
    token: inspector.token,
    body: {
      submissionId: randomUUID(),
      drawing: 'D-1',
      sampleQty: 10,
      dimensions: [{ name: 'Width', sequence: 1, nominal: 80, tolPlus: 0.5, tolMinus: 0.5, actual: 80.2, unit: 'mm', source: 'item-order' as const }],
      defects: [{ defectName: 'Scratch', qty: 3, disposition: 'Hold', notes: 'side B', imageIds: [] }],
      coils: [],
    },
  })
  expect(saved.status).toBe(201)
  const again = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: line('E-2').id, startQty: 0 } })
  await app.api('POST', `/api/sessions/${again.body.id}/samples`, { token: inspector.token, body: { submissionId: randomUUID(), drawing: 'D-2', sampleQty: 5, dimensions: [], defects: [], coils: [] } })
  await app.api('POST', '/api/pdi', { token: inspector.token, body: { orderIds: [line('E-1').id], notes: 'Loaded', imageIds: [] } })
})
afterAll(() => app.stop())

describe('§6 — History to Excel', () => {
  it('is for supervisors, administrators and viewers', async () => {
    expect((await app.api('GET', '/api/sessions/history/export', { token: inspector.token })).status).toBe(403)
    expect((await app.api('GET', '/api/sessions/history/export', { token: viewer.token })).status).toBe(200)
  })

  it('holds every session the filters match, with its samples, measurements and defects', async () => {
    const all = (await app.api<HistoryExportResponse>('GET', '/api/sessions/history/export', { token: admin.token })).body
    expect(all.sessions.map((s) => s.orderNumber)).toEqual(['40001-A', '40002-B'])
    const s1 = all.sessions[0]
    expect(s1).toMatchObject({ item: 'Upright 80x60', machine: '31-Roll Forming-LM2', factory: 'Factory 1', status: 'Open', rejectedBeforeRelease: 2, samples: 1, piecesInspected: 10, defectPieces: 3, holdPieces: 3 })
    expect(all.samples.filter((x) => x.sessionRef === s1.ref)).toEqual([expect.objectContaining({ index: 1, sampleQty: 10, drawing: 'D-1', inspectorName: 'Inspector One' })])
    expect(all.measurements).toEqual([expect.objectContaining({ sessionRef: s1.ref, sampleIndex: 1, name: 'Width', nominal: 80, actual: 80.2 })])
    expect(all.defects).toEqual([{ sessionRef: s1.ref, sampleIndex: 1, defectName: 'Scratch', qty: 3, disposition: 'Hold', notes: 'side B' }])
    // The same filters as History.
    const one = (await app.api<HistoryExportResponse>('GET', '/api/sessions/history/export?q=gamma', { token: admin.token })).body
    expect(one.sessions.map((s) => s.orderNumber)).toEqual(['40002-B'])
    expect(one.defects).toEqual([])
  })
})

describe('§4 — PDIs to Excel', () => {
  it('holds every PDI the filters match, with its items, for the same people', async () => {
    expect((await app.api('GET', '/api/pdi/export', { token: inspector.token })).status).toBe(403)
    const res = await app.api<PDIWithOrder[]>('GET', '/api/pdi/export?q=40001', { token: viewer.token })
    expect(res.status).toBe(200)
    expect(res.body.map((d) => [d.orderNumber, d.notes, d.items.map((i) => i.itemCode)])).toEqual([['40001-A', 'Loaded', ['UP8060']]])
    expect((await app.api<PDIWithOrder[]>('GET', '/api/pdi/export?q=nothing-like-it', { token: viewer.token })).body).toEqual([])
  })
})
