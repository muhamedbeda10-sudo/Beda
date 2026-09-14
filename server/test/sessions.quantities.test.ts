// ============================================================================
// §4 — a session's quantities can be corrected after the fact.
//
// The quantity rejected before release is typed when a session opens and the
// final quantity when it closes; both are as mis-keyed as any measurement.
// An open session's are corrected by its inspector, a closed session's by a
// supervisor; a make-to-stock session has no rejected quantity; and every
// change lands in the audit log.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, AuditListResponse, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let other: Session
let supervisor: Session
let order: ProductionOrder

const sample = () => ({
  submissionId: randomUUID(),
  drawing: 'D-1',
  sampleQty: 10,
  dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
  defects: [],
  coils: [],
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  other = await app.register('other', 'Inspector Two')
  supervisor = await app.register('sup', 'Supervisor')
  await app.api('PATCH', `/api/users/${supervisor.user.id}`, { token: admin.token, body: { role: 'supervisor' } })
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' },
  })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [{ lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing: 'D-1' }],
    },
  })
  order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
})
afterAll(() => app.stop())

async function open(startQty: number): Promise<SessionWithOrder> {
  return (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty } })).body
}

describe('correcting a session’s quantities', () => {
  it('lets the inspector correct the rejected quantity on their open session, and audits it', async () => {
    const s = await open(12)
    const res = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { startQty: 21, version: s.version } })
    expect(res.status).toBe(200)
    expect(res.body.startQtyConfirmed?.qty).toBe(21)
    expect(res.body.startQtyConfirmed?.byName).toBe('Inspector One')
    expect(res.body.version).toBe(s.version + 1)
    const audit = (await app.api<AuditListResponse>('GET', '/api/audit?q=20095', { token: admin.token })).body.entries
    const entry = audit.find((e) => e.entity === 'InspectionSession' && e.field === 'startQty')
    expect(entry?.oldValue).toBe('12')
    expect(entry?.newValue).toBe('21')
  })

  it('refuses a stale version, so two corrections cannot cross', async () => {
    const s = await open(5)
    const res = await app.api('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { startQty: 6, version: s.version + 7 } })
    expect(res.status).toBe(409)
  })

  it('refuses the final quantity while the session is open', async () => {
    const s = await open(0)
    const res = await app.api<ApiErrorBody>('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { finalQty: 90, version: s.version } })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/closes/)
  })

  it('lets a supervisor correct the final quantity of a closed session, not an inspector', async () => {
    const s = await open(3)
    const saved = await app.api('POST', `/api/sessions/${s.id}/samples`, { token: inspector.token, body: sample() })
    expect(saved.status).toBe(201)
    // The save may have moved the session's version; close against what it is now.
    const current = (await app.api<SessionWithOrder>('GET', `/api/sessions/${s.id}`, { token: inspector.token })).body
    const closing = await app.api<SessionWithOrder>('POST', `/api/sessions/${s.id}/close`, { token: inspector.token, body: { finalQty: 100, version: current.version } })
    expect(closing.status, JSON.stringify(closing.body)).toBe(200)
    const closed = closing.body
    expect(closed.status).toBe('Closed')
    expect((await app.api('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { finalQty: 95, version: closed.version } })).status).toBe(403)
    const res = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${s.id}/quantities`, { token: supervisor.token, body: { finalQty: 95, startQty: 4, version: closed.version } })
    expect(res.status).toBe(200)
    expect(res.body.finalQty).toBe(95)
    expect(res.body.startQtyConfirmed?.qty).toBe(4)
  })

  it('another inspector may still correct an open session: they may edit open sessions', async () => {
    const s = await open(1)
    expect((await app.api('PATCH', `/api/sessions/${s.id}/quantities`, { token: other.token, body: { startQty: 2, version: s.version } })).status).toBe(200)
  })

  it('refuses nothing, a negative quantity, and a rejected quantity on a stock session', async () => {
    const s = await open(1)
    expect((await app.api('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { version: s.version } })).status).toBe(400)
    expect((await app.api('PATCH', `/api/sessions/${s.id}/quantities`, { token: inspector.token, body: { startQty: -1, version: s.version } })).status).toBe(400)
    await app.api('POST', '/api/master/machines', {
      token: admin.token,
      body: { code: '21', name: 'Press 400T', line: 'LM1', displayName: '21-Press 400T', process: 'other' },
    })
    const stock = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { workCenterCode: '21', producedQty: 50 } })
    expect(stock.status).toBe(201)
    {
      const bad = await app.api<ApiErrorBody>('PATCH', `/api/sessions/${stock.body.id}/quantities`, { token: inspector.token, body: { startQty: 1, version: stock.body.version } })
      expect(bad.status).toBe(400)
      const ok = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${stock.body.id}/quantities`, { token: inspector.token, body: { producedQty: 60, version: stock.body.version } })
      expect(ok.status).toBe(200)
      expect(ok.body.producedQty).toBe(60)
    }
  })
})
