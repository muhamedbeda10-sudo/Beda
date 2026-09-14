// ============================================================================
// §7 — a session's defects, listed with their samples, so a Hold can be
// decided from the board without opening each sample. Deciding one goes
// through the existing correction, which is what the last case exercises.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SessionDefectsResponse, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let session: SessionWithOrder

const sample = (defects: { name: string; disposition: 'Hold' | 'Repair' }[]) => ({
  submissionId: randomUUID(),
  drawing: 'D-1',
  sampleQty: 10,
  dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
  defects: defects.map((d) => ({ defectName: d.name, qty: 2, disposition: d.disposition, notes: '', imageIds: [] })),
  coils: [],
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' } })
  for (const name of ['Edge', 'Scratch']) await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: name } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing: 'D-1' }] },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  session = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })).body
  // Two samples: a Hold on each, and one already decided.
  for (const body of [sample([{ name: 'Edge', disposition: 'Hold' }]), sample([{ name: 'Scratch', disposition: 'Hold' }, { name: 'Edge', disposition: 'Repair' }])]) {
    const res = await app.api('POST', `/api/sessions/${session.id}/samples`, { token: inspector.token, body })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
})
afterAll(() => app.stop())

describe('a session’s defects, for deciding Holds from the board', () => {
  it('lists every live defect with the sample it sits on', async () => {
    const res = await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })
    expect(res.status).toBe(200)
    // Sample by sample, and by name within one — the order the list draws.
    expect(res.body.defects.map((d) => [d.sampleIndex, d.defectName, d.disposition])).toEqual([
      [1, 'Edge', 'Hold'],
      [2, 'Edge', 'Repair'],
      [2, 'Scratch', 'Hold'],
    ])
    expect(res.body.defects.every((d) => typeof d.version === 'number')).toBe(true)
  })

  it('needs a signed-in reader and a real session id', async () => {
    expect((await app.api('GET', `/api/samples/defects?sessionId=${session.id}`)).status).toBe(401)
    expect((await app.api('GET', '/api/samples/defects?sessionId=nope', { token: inspector.token })).status).toBe(400)
  })

  it('a Hold decided through the correction leaves the list of Holds', async () => {
    const before = (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body
    const hold = before.defects.find((d) => d.defectName === 'Scratch')!
    const res = await app.api<DefectResult>('PATCH', `/api/samples/defects/${hold.id}`, { token: inspector.token, body: { disposition: 'Repair', qty: hold.qty, version: hold.version } })
    expect(res.status).toBe(200)
    const after = (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body
    expect(after.defects.filter((d) => d.disposition === 'Hold').map((d) => d.defectName)).toEqual(['Edge'])
    const s = (await app.api<SessionWithOrder>('GET', `/api/sessions/${session.id}`, { token: inspector.token })).body
    expect(s.holdCount).toBe(1)
  })
})
