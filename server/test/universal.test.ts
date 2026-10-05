// ============================================================================
// §4, §15 — universal machines: presses, benders and anything that is not
// roll forming, welding or painting. One item of an order passes through
// several stages on the machine, a session each; the first is stage 1, a
// later one says its stage when it closes. The line's quantity is the order
// sheet's finished quantity, counted once in whatever span is read, and its
// defects are every stage's.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { KpiBreakdown, KpiGeneral } from '@qc/shared/kpi'
import type { SaveSampleRequest, SessionStagesResponse, SessionWithOrder } from '@qc/shared/api'
import type { Machine, ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let lines: ProductionOrder[]
const line = (key: string) => lines.find((o) => o.lineKey === key)!
const ids: Record<string, string> = {}

function day(offset = 0): string {
  return factoryDay(offset)
}

function defect(qty: number): SaveSampleRequest['defects'] {
  return [{ defectName: 'Burr', qty, disposition: 'Repair', notes: '', imageIds: [] }]
}

/** Open a session on the line with one sample carrying `qty` defect pieces; left open. */
async function open(order: ProductionOrder, qty: number): Promise<SessionWithOrder> {
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })
  expect(opened.status).toBe(201)
  const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, {
    token: inspector.token,
    body: { submissionId: randomUUID(), drawing: 'D-1', sampleQty: 10, dimensions: [], defects: defect(qty), coils: [] },
  })
  expect(saved.status).toBe(201)
  return (await app.api<SessionWithOrder>('GET', `/api/sessions/${opened.body.id}`, { token: inspector.token })).body
}

async function close(s: SessionWithOrder, finalQty: number, stage?: number) {
  return app.api<SessionWithOrder>('POST', `/api/sessions/${s.id}/close`, { token: inspector.token, body: { finalQty, version: s.version, ...(stage === undefined ? {} : { stage }) } })
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'U-1', orderNumber: '50001-A', item: 'Base Plate', itemCode: 'BP-10', workCenterCode: '90', requiredQty: 120, finishedQty: 100, customer: 'A', drawing: 'D-1' },
        { lineKey: 'U-2', orderNumber: '50001-A', item: 'Bracket', itemCode: 'BR-2', workCenterCode: '90', requiredQty: 60, finishedQty: 0, customer: 'A', drawing: 'D-1' },
        { lineKey: 'F-1', orderNumber: '50002-B', item: 'Upright', itemCode: 'UP-1', workCenterCode: '31', requiredQty: 500, finishedQty: 480, customer: 'B', drawing: 'D-1' },
      ],
    },
  })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
})
afterAll(() => app.stop())

describe('§4 — the four kinds of machine', () => {
  it('files a press, a mast machine and an "other" as universal', async () => {
    const press = await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '90', name: 'Press 90', line: 'LM3', displayName: '90-Press-LM3', process: 'مكبس', factory: 'Factory 1' } })
    expect(press.status).toBe(201)
    expect(press.body.process).toBe('universal')
    const mast = await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '91', name: 'Mast', line: 'LM3', displayName: '91-Mast-LM3', process: 'mast' } })
    expect(mast.body.process).toBe('universal')
    const other = await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '92', name: 'Saw', line: 'LM3', displayName: '92-Saw-LM3', process: 'Other' } })
    expect(other.body.process).toBe('universal')
  })
})

describe('§4 — stages of an item on a universal machine', () => {
  it('closes the first session on a line as stage 1 without asking', async () => {
    const s = await open(line('U-1'), 2)
    const options = await app.api<SessionStagesResponse>('GET', `/api/sessions/${s.id}/stages`, { token: inspector.token })
    expect(options.body).toEqual({ asks: false, stages: [], next: 1 })
    const closed = await close(s, 100)
    expect(closed.status).toBe(200)
    expect(closed.body.stage).toBe(1)
    ids.first = s.id
  })

  it('asks a later session for its stage: one of the line\'s, or the next', async () => {
    const s = await open(line('U-1'), 3)
    const options = await app.api<SessionStagesResponse>('GET', `/api/sessions/${s.id}/stages`, { token: inspector.token })
    expect(options.body).toEqual({ asks: true, stages: [{ stage: 1, sessions: 1 }], next: 2 })
    expect((await close(s, 100)).status).toBe(400)
    expect((await close(s, 100, 3)).status).toBe(400)
    const closed = await close(s, 100, 2)
    expect(closed.status).toBe(200)
    expect(closed.body.stage).toBe(2)
    ids.second = s.id
  })

  it('takes an earlier stage again: more of stage 1', async () => {
    const s = await open(line('U-1'), 1)
    const options = await app.api<SessionStagesResponse>('GET', `/api/sessions/${s.id}/stages`, { token: inspector.token })
    expect(options.body).toEqual({ asks: true, stages: [{ stage: 1, sessions: 1 }, { stage: 2, sessions: 1 }], next: 3 })
    const closed = await close(s, 100, 1)
    expect(closed.body.stage).toBe(1)
    ids.third = s.id
    // The close is audited with its stage.
    const { rows } = await app.db.query<{ new_value: string }>(`SELECT new_value FROM audit_log WHERE entity_id = $1 AND field = 'stage'`, [s.id])
    expect(rows.map((r) => r.new_value)).toEqual(['1'])
  })

  it('leaves the stage empty on any other machine', async () => {
    const s = await open(line('F-1'), 2)
    expect((await app.api<SessionStagesResponse>('GET', `/api/sessions/${s.id}/stages`, { token: inspector.token })).body.asks).toBe(false)
    const closed = await close(s, 200, 2)
    expect(closed.status).toBe(200)
    expect(closed.body.stage).toBeUndefined()
    ids.forming = s.id
  })

  it('lets whoever corrects closed sessions correct a stage, within the line\'s stages', async () => {
    const third = (await app.api<SessionWithOrder>('GET', `/api/sessions/${ids.third}`, { token: admin.token })).body
    expect((await app.api('PATCH', `/api/sessions/${third.id}/quantities`, { token: inspector.token, body: { stage: 2, version: third.version } })).status).toBe(403)
    expect((await app.api('PATCH', `/api/sessions/${third.id}/quantities`, { token: admin.token, body: { stage: 4, version: third.version } })).status).toBe(400)
    const fixed = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${third.id}/quantities`, { token: admin.token, body: { stage: 2, version: third.version } })
    expect(fixed.status).toBe(200)
    expect(fixed.body.stage).toBe(2)
    const forming = (await app.api<SessionWithOrder>('GET', `/api/sessions/${ids.forming}`, { token: admin.token })).body
    expect((await app.api('PATCH', `/api/sessions/${forming.id}/quantities`, { token: admin.token, body: { stage: 1, version: forming.version } })).status).toBe(400)
  })
})

describe('§15 — the line\'s quantity counts once, its defects every stage', () => {
  beforeAll(async () => {
    // A line with no finished quantity on the sheet yet falls back on the largest final quantity typed on it.
    await close(await open(line('U-2'), 1), 40)
  })

  it('counts the sheet quantity once for all the stages of a line', async () => {
    const g = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${day(-1)}&to=${day(1)}`, { token: admin.token })).body
    const press = g.machines.find((m) => m.workCenterCode === '90')!
    // U-1: 100 on the sheet, once, and 2 + 3 + 1 rejected over three stages; U-2: 40, and 1 rejected.
    expect(press.piecesProduced).toBe(140)
    expect(press.productionDefectPieces).toBe(7)
    expect(press.process).toBe('universal')
    // The forming line keeps its session's final quantity.
    expect(g.machines.find((m) => m.workCenterCode === '31')!.piecesProduced).toBe(200)
    expect(g.totals.piecesProduced).toBe(340)
    expect(g.totals.productionDefectPieces).toBe(9)
  })

  it('counts it once in each month and once in the span', async () => {
    // Stage 2 of U-1 closed last month.
    await app.db.query(`UPDATE inspection_sessions SET closed_at = closed_at - interval '40 days' WHERE id = $1`, [ids.second])
    const from = `${day(-45).slice(0, 7)}-01`
    const b = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${from}&to=${day(1)}&process=universal`, { token: admin.token })).body
    const withMade = b.months.filter((m) => m.made > 0)
    // Last month: U-1's 100 and stage 2's 3 rejected. This month: U-1's 100 again and U-2's 40, with 2 + 1 + 1 rejected.
    expect(withMade.map((m) => [m.piecesProduced, m.productionDefectPieces])).toEqual([
      [100, 3],
      [140, 4],
    ])
    // The span counts U-1 once: 140 made plus 7 rejected.
    expect(b.totals).toMatchObject({ made: 147, productionDefectPieces: 7 })
    expect(b.series.machines.find((m) => m.key === '90')).toMatchObject({ made: 147, productionDefectPieces: 7 })
    const g = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${from}&to=${day(1)}`, { token: admin.token })).body
    expect(g.machines.find((m) => m.workCenterCode === '90')!.piecesProduced).toBe(140)
  })
})
