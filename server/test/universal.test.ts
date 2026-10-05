// ============================================================================
// §4, §15 — universal machines: presses, benders and anything that is not
// roll forming, welding or painting. The first session closed on a line (an
// item of an order on the machine) says what it is: a final product, whose
// later sessions each inspect a new quantity, or an item that passes through
// stages, where a session may cover several stages at once (two presses),
// each with its quantity. A staged line made, in any span, the quantity of
// the highest stage recorded in it; a line closed before the choice existed
// is counted at the order sheet's quantity, once, as it was.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { KpiBreakdown, KpiGeneral } from '@qc/shared/kpi'
import type { CloseSessionRequest, SaveSampleRequest, SessionStagesResponse, SessionWithOrder } from '@qc/shared/api'
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

async function close(s: SessionWithOrder, body: Omit<CloseSessionRequest, 'version'>) {
  return app.api<SessionWithOrder>('POST', `/api/sessions/${s.id}/close`, { token: inspector.token, body: { ...body, version: s.version } })
}
const staged = (...stages: [number, number][]): Omit<CloseSessionRequest, 'version'> => ({ universal: { kind: 'staged', stages: stages.map(([stage, qty]) => ({ stage, qty })) } })
const options = async (s: SessionWithOrder) => (await app.api<SessionStagesResponse>('GET', `/api/sessions/${s.id}/stages`, { token: inspector.token })).body

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
        { lineKey: 'U-3', orderNumber: '50001-A', item: 'Clip', itemCode: 'CL-3', workCenterCode: '90', requiredQty: 80, finishedQty: 70, customer: 'A', drawing: 'D-1' },
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

describe('§4 — a line on a universal machine: stages', () => {
  it("lets the line's first close choose, and covers two stages at once", async () => {
    const s = await open(line('U-1'), 2)
    expect(await options(s)).toEqual({ universal: true, lineKind: null, stages: [], next: 1 })
    // Not stage 2 before stage 1.
    expect((await close(s, staged([2, 100]))).status).toBe(400)
    const closed = await close(s, staged([1, 100], [2, 100]))
    expect(closed.status).toBe(200)
    expect(closed.body).toMatchObject({ universalKind: 'staged', stages: [{ stage: 1, qty: 100 }, { stage: 2, qty: 100 }], finalQty: 100 })
    ids.first = s.id
  })

  it('keeps a later session to stages, with no gap', async () => {
    const s = await open(line('U-1'), 3)
    expect(await options(s)).toEqual({ universal: true, lineKind: 'staged', stages: [{ stage: 1, sessions: 1 }, { stage: 2, sessions: 1 }], next: 3 })
    expect((await close(s, { universal: { kind: 'final' }, finalQty: 90 })).status).toBe(400)
    expect((await close(s, staged([4, 90]))).status).toBe(400)
    const closed = await close(s, staged([3, 90]))
    expect(closed.body).toMatchObject({ universalKind: 'staged', stages: [{ stage: 3, qty: 90 }], finalQty: 90 })
    ids.second = s.id
    // The close is audited with its stages.
    const { rows } = await app.db.query<{ new_value: string }>(`SELECT new_value FROM audit_log WHERE entity_id = $1 AND field = 'stages'`, [s.id])
    expect(rows.map((r) => r.new_value)).toEqual(['3: 90'])
  })

  it("reads an older client's single stage as that stage at the final quantity", async () => {
    const s = await open(line('U-1'), 1)
    expect((await close(s, { finalQty: 100 })).status).toBe(400)
    const closed = await close(s, { finalQty: 100, stage: 1 })
    expect(closed.body).toMatchObject({ universalKind: 'staged', stages: [{ stage: 1, qty: 100 }] })
    ids.third = s.id
  })
})

describe('§4 — a line on a universal machine: a final product', () => {
  it('takes a new quantity at every session, and never a stage', async () => {
    const s = await open(line('U-2'), 1)
    const first = await close(s, { universal: { kind: 'final' }, finalQty: 40 })
    expect(first.body).toMatchObject({ universalKind: 'final', finalQty: 40 })
    expect(first.body.stages).toBeUndefined()
    const next = await open(line('U-2'), 1)
    expect(await options(next)).toEqual({ universal: true, lineKind: 'final', stages: [], next: 1 })
    expect((await close(next, staged([1, 25]))).status).toBe(400)
    // An older client sends the quantity alone: one more inspection of a new quantity.
    expect((await close(next, { finalQty: 25 })).body).toMatchObject({ universalKind: 'final', finalQty: 25 })
  })

  it('leaves both out on any other machine', async () => {
    const s = await open(line('F-1'), 2)
    expect((await options(s)).universal).toBe(false)
    expect((await close(s, { ...staged([1, 200]), finalQty: 200 })).status).toBe(400)
    const closed = await close(s, { finalQty: 200, stage: 2 })
    expect(closed.status).toBe(200)
    expect(closed.body.universalKind).toBeUndefined()
    expect(closed.body.stages).toBeUndefined()
    ids.forming = s.id
  })
})

describe('§4 — correcting a closed universal session', () => {
  it('is for whoever corrects closed records, within the line\'s stages', async () => {
    const third = (await app.api<SessionWithOrder>('GET', `/api/sessions/${ids.third}`, { token: admin.token })).body
    const patch = (token: string, body: object) => app.api<SessionWithOrder>('PATCH', `/api/sessions/${third.id}/quantities`, { token, body: { ...body, version: third.version } })
    expect((await patch(inspector.token, { universal: { kind: 'staged', stages: [{ stage: 2, qty: 100 }] } })).status).toBe(403)
    expect((await patch(admin.token, { universal: { kind: 'staged', stages: [{ stage: 5, qty: 100 }] } })).status).toBe(400)
    // A staged session's quantity is its stages'.
    expect((await patch(admin.token, { finalQty: 80 })).status).toBe(400)
    const fixed = await patch(admin.token, { universal: { kind: 'staged', stages: [{ stage: 1, qty: 100 }, { stage: 2, qty: 95 }] } })
    expect(fixed.status).toBe(200)
    expect(fixed.body).toMatchObject({ stages: [{ stage: 1, qty: 100 }, { stage: 2, qty: 95 }], finalQty: 95 })
    // The old quantity is marked deleted, never erased.
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM session_stage_quantities WHERE session_id = $1 AND deleted_at IS NOT NULL`, [third.id])
    expect(rows[0].n).toBe(1)
    const forming = (await app.api<SessionWithOrder>('GET', `/api/sessions/${ids.forming}`, { token: admin.token })).body
    expect((await app.api('PATCH', `/api/sessions/${forming.id}/quantities`, { token: admin.token, body: { universal: { kind: 'final' }, version: forming.version } })).status).toBe(400)
  })

  it('turns a wrong choice the other way', async () => {
    const third = (await app.api<SessionWithOrder>('GET', `/api/sessions/${ids.third}`, { token: admin.token })).body
    const toFinal = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${third.id}/quantities`, { token: admin.token, body: { universal: { kind: 'final' }, finalQty: 60, version: third.version } })
    expect(toFinal.body).toMatchObject({ universalKind: 'final', finalQty: 60 })
    expect(toFinal.body.stages).toBeUndefined()
    const back = await app.api<SessionWithOrder>('PATCH', `/api/sessions/${third.id}/quantities`, {
      token: admin.token,
      body: { universal: { kind: 'staged', stages: [{ stage: 1, qty: 100 }] }, version: toFinal.body.version },
    })
    expect(back.body).toMatchObject({ universalKind: 'staged', stages: [{ stage: 1, qty: 100 }], finalQty: 100 })
  })
})

describe('§15 — what a universal line made', () => {
  beforeAll(async () => {
    // U-3 was closed before the choice existed: twice, on the order sheet's 70.
    for (const qty of [1, 1]) {
      const s = await open(line('U-3'), qty)
      await close(s, { finalQty: 70, stage: 1 })
      await app.db.query(`UPDATE inspection_sessions SET universal_kind = NULL WHERE id = $1`, [s.id])
    }
  })

  it('reads a staged line off its highest stage, a final product added up, an older line once off the sheet', async () => {
    const g = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${day(-1)}&to=${day(1)}`, { token: admin.token })).body
    const press = g.machines.find((m) => m.workCenterCode === '90')!
    // U-1: stage 3's 90 (2 + 3 + 1 rejected); U-2: 40 + 25 (1 + 1); U-3: the sheet's 70, once (1 + 1).
    expect(press.piecesProduced).toBe(90 + 65 + 70)
    expect(press.productionDefectPieces).toBe(6 + 2 + 2)
    expect(press.process).toBe('universal')
    expect(g.machines.find((m) => m.workCenterCode === '31')!.piecesProduced).toBe(200)
  })

  it('reads the highest stage of each month, and of the span', async () => {
    // Stage 3 of U-1 closed last month.
    await app.db.query(`UPDATE inspection_sessions SET closed_at = closed_at - interval '40 days' WHERE id = $1`, [ids.second])
    const from = `${day(-45).slice(0, 7)}-01`
    const b = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${from}&to=${day(1)}&process=universal`, { token: admin.token })).body
    const withMade = b.months.filter((m) => m.made > 0)
    // Last month: U-1's stage 3, 90, and its 3 rejected. This month: U-1's highest is stage 2, the first session's 100 (the third is back to stage 1), with U-2's 65 and U-3's 70.
    expect(withMade.map((m) => [m.piecesProduced, m.productionDefectPieces])).toEqual([
      [90, 3],
      [100 + 65 + 70, 3 + 2 + 2],
    ])
    // The span: U-1 once at stage 3's 90.
    expect(b.totals).toMatchObject({ made: 90 + 65 + 70 + 10, productionDefectPieces: 10 })
    expect(b.series.machines.find((m) => m.key === '90')).toMatchObject({ made: 235, productionDefectPieces: 10 })
  })
})
