// ============================================================================
// §5 — a machine whose samples must name their coil (Configuration →
// Machines, coilRequired; migration 0057): roll forming, the 400 t press. A
// sample there is refused without one, on the server as in the wizard; the
// switch is set and read like the machine's other ones.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, SessionWithOrder } from '@qc/shared/api'
import type { Machine, ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let lines: ProductionOrder[]

const sample = (coils: { coilNumber: string }[]) => ({
  submissionId: randomUUID(),
  drawing: 'D-1',
  sampleQty: 10,
  dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
  defects: [],
  coils,
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  for (const body of [
    { code: '21', name: 'Press 400 T', line: 'PL', displayName: '21-Press 400 T', process: 'forming', coilRequired: true },
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming', process: 'forming' },
  ]) {
    const made = await app.api('POST', '/api/master/machines', { token: admin.token, body })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
  }
  const line = (lineKey: string, workCenterCode: string) => ({ lineKey, orderNumber: '19145-Ph14.23-EHF', item: `Connector ${lineKey}`, itemCode: `BC-${lineKey}`, workCenterCode, requiredQty: 100, finishedQty: 0, customer: 'Beta', drawing: 'D-1' })
  await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [line('486768', '21'), line('486769', '31')] } })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
})
afterAll(() => app.stop())

const open = async (lineKey: string) =>
  (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: lines.find((l) => l.lineKey === lineKey)!.id, startQty: 0 } })).body

describe('a machine that requires the coil', () => {
  it('is set and read with the machine, off unless turned on', async () => {
    const machines = (await app.api<Machine[]>('GET', '/api/master/machines', { token: admin.token })).body
    expect(machines.map((m) => [m.code, m.coilRequired])).toEqual([
      ['21', true],
      ['31', false],
    ])
  })

  it('refuses a sample without a coil there, takes it with one, and asks nothing of another machine', async () => {
    const press = await open('486768')
    const refused = await app.api<ApiErrorBody>('POST', `/api/sessions/${press.id}/samples`, { token: inspector.token, body: sample([]) })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toBe('Add the coil this sample was made from: this machine requires it.')
    const saved = await app.api('POST', `/api/sessions/${press.id}/samples`, { token: inspector.token, body: sample([{ coilNumber: 'C10021' }]) })
    expect(saved.status, JSON.stringify(saved.body)).toBe(201)

    const roll = await open('486769')
    const free = await app.api('POST', `/api/sessions/${roll.id}/samples`, { token: inspector.token, body: sample([]) })
    expect(free.status, JSON.stringify(free.body)).toBe(201)
  })
})
