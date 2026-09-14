// ============================================================================
// §4.4 / §6 — a session two inspectors share is found under either name.
//
// The dashboard attributes a sample to whoever recorded it; History used to
// find a session only by whoever opened it. A sample recorded in a
// colleague's session was therefore on the dashboard under one name and
// unfindable in History under it — so it could not be deleted from there.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HistoryOptionsResponse, HistoryResponse, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let opener: Session
let joiner: Session
let shared: string

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  opener = await app.register('opener', 'Hany Fathy')
  joiner = await app.register('joiner', 'Mahmoud Gafaar')
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
  })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing: 'D-1' },
      ],
    },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  shared = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: opener.token, body: { orderId: order.id, startQty: 0 } })).body.id
  // The joiner records in the opener's session, and never opens one of their own.
  const res = await app.api('POST', `/api/sessions/${shared}/samples`, {
    token: joiner.token,
    body: {
      submissionId: randomUUID(),
      drawing: 'D-1',
      sampleQty: 11,
      dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
      defects: [],
      coils: [],
    },
  })
  if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
})
afterAll(() => app.stop())

const ids = (r: { body: HistoryResponse }) => r.body.sessions.map((s) => s.id)

describe('a shared session is found under either inspector', () => {
  it('by the inspector filter', async () => {
    expect(ids(await app.api<HistoryResponse>('GET', `/api/sessions/history?inspectorId=${joiner.user.id}`, { token: admin.token }))).toEqual([shared])
    expect(ids(await app.api<HistoryResponse>('GET', `/api/sessions/history?inspectorId=${opener.user.id}`, { token: admin.token }))).toEqual([shared])
  })

  it('by name in the search box', async () => {
    expect(ids(await app.api<HistoryResponse>('GET', '/api/sessions/history?q=Gafaar', { token: admin.token }))).toEqual([shared])
  })

  it('and the joiner is offered in the filter list although they opened nothing', async () => {
    const res = await app.api<HistoryOptionsResponse>('GET', '/api/sessions/history/options', { token: admin.token })
    expect(res.body.inspectors.map((i) => i.name).sort()).toEqual(['Hany Fathy', 'Mahmoud Gafaar'])
  })

  it('so deleting it removes the joiner’s samples from the record', async () => {
    expect((await app.api('DELETE', `/api/sessions/${shared}`, { token: admin.token })).status).toBe(204)
    expect(ids(await app.api<HistoryResponse>('GET', `/api/sessions/history?inspectorId=${joiner.user.id}`, { token: admin.token }))).toEqual([])
    const opts = await app.api<HistoryOptionsResponse>('GET', '/api/sessions/history/options', { token: admin.token })
    expect(opts.body.inspectors).toEqual([])
  })
})
