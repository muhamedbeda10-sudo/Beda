// ============================================================================
// §5 — the drawing a sample is inspected against. The ERP writes a
// placeholder in DWG1 ("(V)", "V", "0", "NA", "X") on many lines and the
// drawing itself in DWG2: such a line asks for that drawing, and a line whose
// sheet names none takes a sample without one rather than refusing every save.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let lines: ProductionOrder[]

const sample = (drawing: string) => ({
  submissionId: randomUUID(),
  drawing,
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
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '14', name: 'Press Brake', line: 'PB', displayName: '14-Press Brake', process: 'forming' },
  })
  const line = (lineKey: string, drawing: string, drawingAlt: string) => ({
    lineKey, orderNumber: '20552-Ph3.3-RHE', item: `XL Mesh Shelf ${lineKey}`, itemCode: `MS-${lineKey}`, workCenterCode: '14', requiredQty: 100, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing, drawingAlt,
  })
  const imported = await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [line('532998', '', 'BS9301 (CTL)  / Gasp.334 - MJ916 (RF)'), line('532999', '(V)', '0')] },
  })
  expect(imported.status, JSON.stringify(imported.body)).toBe(200)
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
})
afterAll(() => app.stop())

async function open(lineKey: string): Promise<SessionWithOrder> {
  const order = lines.find((l) => l.lineKey === lineKey)!
  return (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })).body
}

describe('the drawing a sample names', () => {
  it('is required on a line whose drawing is only in DWG2, and that drawing is taken', async () => {
    const s = await open('532998')
    const refused = await app.api<ApiErrorBody>('POST', `/api/sessions/${s.id}/samples`, { token: inspector.token, body: sample('') })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toBe('Select a drawing.')
    const saved = await app.api('POST', `/api/sessions/${s.id}/samples`, { token: inspector.token, body: sample('BS9301 (CTL)  / Gasp.334 - MJ916 (RF)') })
    expect(saved.status, JSON.stringify(saved.body)).toBe(201)
  })

  it('is not asked of a line whose sheet names none (placeholders in both columns)', async () => {
    const s = await open('532999')
    const saved = await app.api('POST', `/api/sessions/${s.id}/samples`, { token: inspector.token, body: sample('') })
    expect(saved.status, JSON.stringify(saved.body)).toBe(201)
  })
})
