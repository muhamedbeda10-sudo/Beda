// ============================================================================
// §15 — defect rate by coil supplier counts roll forming only.
//
// A coil is consumed on the forming line; by the time the piece is welded or
// painted, a defect says nothing about the steel's supplier. So the supplier
// figure is built from forming samples alone, and a coil recorded on a
// welding sample is left out of it.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session

const today = (offset = 0) => {
  return factoryDay(offset)
}
const period = () => `from=${today(-1)}&to=${today(1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`

function sample(process: 'forming' | 'welding', defects: number): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'D-1',
    sampleQty: 10,
    dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
    defects: Array.from({ length: defects }, () => ({ defectName: 'Edge', qty: 1, disposition: 'Repair' as const, notes: '', imageIds: [] })),
    coils: [{ coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }],
    ...(process === 'welding'
      ? {
          pt: {
            testFrequencyPct: 10,
            consumableLots: { Cleaner: 'B1', Penetrant: 'B2', Developer: 'B3' },
            weldingWireBatch: 'WW-1',
            connectorWireBatch: 'CW-1',
            testedLengths: [{ lengthMm: 150, verdict: 'Accept' as const }],
            imageIds: [],
          },
        }
      : {}),
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  for (const m of [
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' },
    { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding' },
  ]) {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: m })
  }
  for (const code of ['31', '58']) await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: code, defectName: 'Edge' } })
  await app.api('POST', '/api/master/pt-consumables', { token: admin.token, body: { kind: 'Cleaner', productName: 'SKC-S', lotBatch: 'B1' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20001-A', item: 'Beam', itemCode: 'B1', workCenterCode: '31', requiredQty: 100, finishedQty: 0, customer: 'X', expectedGrade: '', drawing: 'D-1' },
        { lineKey: 'L-2', orderNumber: '20001-A', item: 'Beam', itemCode: 'B1', workCenterCode: '58', requiredQty: 100, finishedQty: 0, customer: 'X', expectedGrade: '', drawing: 'D-1' },
      ],
    },
  })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  for (const [code, process, defects] of [
    ['31', 'forming', 2],
    ['58', 'welding', 5],
  ] as const) {
    const order = orders.find((o) => o.workCenterCode === code)!
    const s = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })).body
    const res = await app.api('POST', `/api/sessions/${s.id}/samples`, { token: inspector.token, body: sample(process, defects) })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
})
afterAll(() => app.stop())

describe('defect rate by coil supplier', () => {
  it('counts the forming sample and leaves the welding one out', async () => {
    const o = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body
    // Both samples carry the same coil; only forming's 2 defects in 10 pieces count.
    expect(o.suppliers).toEqual([{ supplier: 'Ezz Steel', grade: 'S355JR', samples: 1, pieces: 10, defectPieces: 2, inspectedDefectPct: 20 }])
    expect(o.counts.suppliers).toBe(1)
    // The welding defects are still in every other figure.
    expect(o.current.defectPieces).toBe(7)
  })
})
