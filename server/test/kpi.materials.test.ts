// ============================================================================
// §15 — Comparisons, roll forming's raw material: the reject rate by coil
// supplier and by thickness, black or galvanized from the grade, and one
// thickness and material over the period. A session's made pieces are shared
// among its coils by its samples; a sample's rejected pieces go to its coils.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiMaterials } from '@qc/shared/kpi'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session

function today(offsetDays = 0): string {
  return factoryDay(offsetDays)
}

/** One sample: the coils it ran and the pieces it rejected. */
interface SampleSpec {
  coils: string[]
  rejected: number
}

async function run(order: ProductionOrder, samples: SampleSpec[], finalQty: number): Promise<void> {
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })
  expect(opened.status).toBe(201)
  for (const s of samples) {
    const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, {
      token: inspector.token,
      body: {
        submissionId: randomUUID(),
        drawing: 'D-1',
        sampleQty: 10,
        dimensions: [],
        defects: s.rejected > 0 ? [{ defectName: 'Edge', qty: s.rejected, disposition: 'Repair', notes: '', imageIds: [] }] : [],
        coils: s.coils.map((coilNumber) => ({ coilNumber })),
      },
    })
    if (saved.status !== 201) throw new Error(`sample ${saved.status} ${JSON.stringify(saved.body)}`)
  }
  const before = await app.api<SessionWithOrder>('GET', `/api/sessions/${opened.body.id}`, { token: inspector.token })
  const closed = await app.api('POST', `/api/sessions/${opened.body.id}/close`, { token: inspector.token, body: { finalQty, version: before.body.version } })
  if (closed.status !== 200) throw new Error(`close ${closed.status} ${JSON.stringify(closed.body)}`)
}

/** A list as the trend's filters take it: one JSON array in the address. */
const list = (values: (string | number)[]) => encodeURIComponent(JSON.stringify(values))
const materials = (query = '') => app.api<KpiMaterials>('GET', `/api/kpi/materials?from=${today(-1)}&to=${today(1)}${query}`, { token: admin.token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  for (const m of [
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
    { code: '32', name: 'Roll Forming', line: 'LM3', displayName: '32-Roll Forming-LM3', process: 'forming', factory: 'Factory 1' },
    { code: '77', name: 'Mast Line', line: 'LM7', displayName: '77-Mast Line-LM7', process: 'universal', factory: 'Factory 2' },
  ]) {
    expect((await app.api('POST', '/api/master/machines', { token: admin.token, body: m })).status).toBe(201)
  }
  await app.api('POST', '/api/coils/import', {
    token: admin.token,
    body: {
      rows: [
        { coilNumber: 'C1', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 1.5 },
        { coilNumber: 'C2', grade: 'DX51D+Z275', supplier: 'Suez Steel', thickness: 2 },
      ],
    },
  })
  const row = (lineKey: string, workCenterCode: string) => ({ lineKey, orderNumber: `ORD-${lineKey}`, item: 'Upright', itemCode: 'UP', workCenterCode, requiredQty: 500, finishedQty: 0, customer: 'A', expectedGrade: '', drawing: 'D-1' })
  await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [row('M-31', '31'), row('M-32', '32'), row('M-77', '77')] } })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  const line = (key: string) => orders.find((o) => o.lineKey === key)!
  // 31: Ezz alone — 100 made, 2 rejected.
  await run(line('M-31'), [{ coils: ['C1'], rejected: 2 }], 100)
  // 32: a sample on each coil — 100 made each; Ezz rejects 1, Suez 3.
  await run(line('M-32'), [{ coils: ['C1'], rejected: 1 }, { coils: ['C2'], rejected: 3 }], 200)
  // 32: one sample on both coils — 25 made and 2 rejected each.
  await run(line('M-32'), [{ coils: ['C1', 'C2'], rejected: 4 }], 50)
  // 31: no coil recorded — 40 made, 1 rejected.
  await run(line('M-31'), [{ coils: [], rejected: 1 }], 40)
  // A universal machine is not roll forming: never read here.
  await run(line('M-77'), [{ coils: ['C1'], rejected: 9 }], 300)
})
afterAll(() => app.stop())

describe('§15 — roll forming raw material', () => {
  it('shares each session among its coils by its samples, by supplier', async () => {
    const res = await materials()
    expect(res.status).toBe(200)
    expect(res.body.suppliers.map((s) => [s.label, s.made, s.productionDefectPieces])).toEqual([
      ['Ezz Steel', 230, 5],
      ['Suez Steel', 130, 5],
      ['No supplier recorded', 41, 1],
    ])
    expect(res.body.suppliers[0].defectRatePct).toBeCloseTo((5 / 230) * 100, 3)
  })

  it('reads the thicknesses, with black and galvanized from the grade', async () => {
    const { thicknesses, thicknessOptions } = (await materials()).body
    expect(thicknessOptions).toEqual([1.5, 2])
    expect(thicknesses.map((t) => [t.label, t.made, t.productionDefectPieces, t.black.made, t.galvanized.made])).toEqual([
      ['1.5 mm', 230, 5, 230, 0],
      ['2 mm', 130, 5, 0, 130],
      ['No thickness recorded', 41, 1, 0, 0],
    ])
  })

  it('follows one thickness and material over the period', async () => {
    const galv = (await materials(`&thicknesses=${list([2])}&material=galvanized`)).body.trend
    expect(galv.grain).toBe('day')
    expect(galv.total).toMatchObject({ made: 130, productionDefectPieces: 5 })
    expect(galv.points.map((p) => p.made)).toEqual([0, 130, 0])
    expect((await materials(`&thicknesses=${list([2])}&material=black`)).body.trend.total.made).toBe(0)
    expect((await materials('&material=black')).body.trend.total).toMatchObject({ made: 230, productionDefectPieces: 5 })
    expect((await materials()).body.trend.total).toMatchObject({ made: 401, productionDefectPieces: 11 })
    // One supplier, or the coils with none recorded.
    expect((await materials(`&suppliers=${list(['Suez Steel'])}`)).body.trend.total).toMatchObject({ made: 130, productionDefectPieces: 5 })
    expect((await materials(`&suppliers=${list([''])}`)).body.trend.total).toMatchObject({ made: 41, productionDefectPieces: 1 })
    expect((await materials('&grain=week')).body.trend.grain).toBe('week')
  })

  it('lists every supplier, thickness and grade together, for the table', async () => {
    const { details, gradeOptions } = (await materials()).body
    expect(details.map((d) => [d.supplier, d.thickness, d.grade, d.material, d.made, d.productionDefectPieces])).toEqual([
      ['Ezz Steel', 1.5, 'S355JR', 'black', 230, 5],
      ['Suez Steel', 2, 'DX51D+Z275', 'galvanized', 130, 5],
      ['', null, '', 'unknown', 41, 1],
    ])
    expect(gradeOptions).toEqual(['DX51D+Z275', 'S355JR'])
  })

  it('follows several suppliers, thicknesses or grades at once — the same supplier typed two ways', async () => {
    const both = (await materials(`&suppliers=${list(['suez steel', 'EZZ STEEL'])}`)).body.trend
    expect(both.suppliers).toEqual(['suez steel', 'EZZ STEEL'])
    expect(both.total).toMatchObject({ made: 360, productionDefectPieces: 10 })
    expect((await materials(`&suppliers=${list(['Ezz Steel', ''])}`)).body.trend.total).toMatchObject({ made: 271, productionDefectPieces: 6 })
    expect((await materials(`&thicknesses=${list([1.5, 2])}`)).body.trend.total).toMatchObject({ made: 360, productionDefectPieces: 10 })
    expect((await materials(`&grades=${list(['S355JR', 'DX51D+Z275'])}&material=galvanized`)).body.trend.total.made).toBe(130)
  })

  it('follows one grade over the period', async () => {
    const g = (await materials(`&grades=${list(['dx51d+z275'])}`)).body.trend
    expect(g.grades).toEqual(['dx51d+z275'])
    expect(g.total).toMatchObject({ made: 130, productionDefectPieces: 5 })
    expect((await materials(`&grades=${list(['S355JR'])}&thicknesses=${list([2])}`)).body.trend.total.made).toBe(0)
  })

  it('narrows to the roll forming machines picked', async () => {
    const one = (await materials('&workCenterCode=31')).body
    expect(one.workCenterCodes).toEqual(['31'])
    expect(one.suppliers.map((s) => [s.label, s.made])).toEqual([
      ['Ezz Steel', 102],
      ['No supplier recorded', 41],
    ])
    // A machine of another process reads nothing here.
    expect((await materials('&workCenterCode=77')).body.suppliers).toEqual([])
  })

  it('refuses a bad material or thickness, and a reader without the dashboard', async () => {
    expect((await materials('&material=steel')).status).toBe(400)
    expect((await materials(`&thicknesses=${list([-1])}`)).status).toBe(400)
    expect((await materials('&suppliers=not-json')).status).toBe(400)
    expect((await app.api('GET', `/api/kpi/materials?from=${today(-1)}&to=${today(1)}`, { token: inspector.token })).status).toBe(403)
  })
})
