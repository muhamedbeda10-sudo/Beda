// ============================================================================
// §15 — the general page and the analysis page's slices: the plant over the
// last months with no filter, the process groups, the month-by-month trend,
// and how spread each defect is over days and orders.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { Machine, ProductionOrder } from '@qc/shared/types'
import { GENERAL_MONTHS, type KpiBreakdown, type KpiGeneral, type KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session

function today(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}
const period = () => `from=${today(-1)}&to=${today(1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`

function sample(defects: SaveSampleRequest['defects']): SaveSampleRequest {
  return { submissionId: randomUUID(), drawing: 'D-1', sampleQty: 10, dimensions: [], defects, coils: [] }
}

/** Open a session on the line, record one sample with the defects, close it on the final quantity. */
async function run(order: ProductionOrder, defects: SaveSampleRequest['defects'], finalQty: number, rejectedBeforeRelease = 0): Promise<string> {
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: rejectedBeforeRelease } })
  expect(opened.status).toBe(201)
  const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, { token: inspector.token, body: sample(defects) })
  if (saved.status !== 201) throw new Error(`sample save ${saved.status} ${JSON.stringify(saved.body)}`)
  const before = await app.api<SessionWithOrder>('GET', `/api/sessions/${opened.body.id}`, { token: inspector.token })
  const closed = await app.api('POST', `/api/sessions/${opened.body.id}/close`, { token: inspector.token, body: { finalQty, version: before.body.version } })
  expect(closed.status).toBe(200)
  return opened.body.id
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' } })
  const mast = await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '77', name: 'Mast Line', line: 'LM7', displayName: '77-Mast Line-LM7', process: 'mast', factory: 'Factory 2' } })
  expect(mast.status).toBe(201)
  // A mast machine is a universal machine: the register files it so.
  expect(mast.body.process).toBe('universal')
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'G-1', orderNumber: '30001-A', item: 'Upright 80x60', itemCode: 'UP8060', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'A', expectedGrade: '', drawing: 'D-1' },
        { lineKey: 'G-2', orderNumber: '30002-B', item: 'Upright 80x60', itemCode: 'UP8060', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'B', expectedGrade: '', drawing: 'D-1' },
        { lineKey: 'G-3', orderNumber: '30003-C', item: 'Mast 120', itemCode: 'MAST120', workCenterCode: '77', requiredQty: 500, finishedQty: 0, customer: 'C', expectedGrade: '', drawing: 'D-2' },
      ],
    },
  })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  const line = (key: string) => orders.find((o) => o.lineKey === key)!
  // Two orders on the forming line share a scratch; the mast line has a dent.
  await run(line('G-1'), [{ defectName: 'Scratch', qty: 2, disposition: 'Repair', notes: '', imageIds: [] }], 100)
  await run(line('G-2'), [{ defectName: 'Scratch', qty: 3, disposition: 'Repair', notes: '', imageIds: [] }], 200)
  // The mast line had 7 pieces rejected before the release inspection: not a clean first part.
  await run(line('G-3'), [{ defectName: 'Dent', qty: 1, disposition: 'Rejected', notes: '', imageIds: [] }], 300, 7)
})
afterAll(() => app.stop())

describe('§15 — process groups and the month view', () => {
  it('narrows the analysis to a process group of the register', async () => {
    const mast = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&process=universal`, { token: admin.token })
    expect(mast.status).toBe(200)
    expect(mast.body.byMachine.map((m) => m.key)).toEqual(['77'])
    expect(mast.body.current.piecesProduced).toBe(300)
    expect(mast.body.current.productionDefectPieces).toBe(1)
    const forming = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&process=forming`, { token: admin.token })
    expect(forming.body.byMachine.map((m) => m.key)).toEqual(['31'])
    expect(forming.body.current.piecesProduced).toBe(300)
    expect(forming.body.pareto.map((p) => p.defectName)).toEqual(['Scratch'])
    const paint = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&process=paint`, { token: admin.token })
    expect(paint.body.byMachine).toEqual([])
    expect(paint.body.current.samples).toBe(0)
    expect((await app.api('GET', `/api/kpi/overview?${period()}&process=lathe`, { token: admin.token })).status).toBe(400)
  })

  it('says how spread each defect is: days and orders', async () => {
    const all = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })
    expect(all.body.defectDetails).toEqual([
      { defectName: 'Scratch', pieces: 5, records: 2, days: 1, orders: 2, sharePct: 83.33 },
      { defectName: 'Dent', pieces: 1, records: 1, days: 1, orders: 1, sharePct: 16.67 },
    ])
    expect(all.body.byMachinePrevious).toEqual([])
  })

  it('carries the period month by month', async () => {
    const all = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })
    const months = all.body.monthly
    expect(months.length).toBeGreaterThanOrEqual(1)
    expect(months.length).toBeLessThanOrEqual(3)
    const produced = months.reduce((n, m) => n + m.piecesProduced, 0)
    expect(produced).toBe(600)
    expect(months.reduce((n, m) => n + m.productionDefectPieces, 0)).toBe(6)
    const thisMonth = months.find((m) => m.piecesProduced > 0)!
    // 6 rejected of 606 made.
    expect(thisMonth.defectRatePct).toBeCloseTo(0.99, 2)
    expect(thisMonth.samples).toBe(3)
  })

  it('shows the whole plant on the general page, unfiltered, over the last months', async () => {
    expect((await app.api('GET', '/api/kpi/general', { token: inspector.token })).status).toBe(403)
    const res = await app.api<KpiGeneral>('GET', '/api/kpi/general', { token: admin.token })
    expect(res.status).toBe(200)
    const g = res.body
    // Every session of this suite closed this month: the trend starts on the first month with production, not on empty ones.
    expect(g.monthsBack).toBe(1)
    expect(g.monthsBack).toBeLessThanOrEqual(GENERAL_MONTHS)
    expect(g.months.length).toBe(g.monthsBack)
    expect(g.months[0].month).toBe(g.to.slice(0, 7))
    expect(g.months[g.months.length - 1].month).toBe(g.to.slice(0, 7))
    expect(g.from.slice(8)).toBe('01')
    expect(g.window.from).toBe(g.from)
    expect(g.window.to).toBe(g.to)
    expect(g.totals.piecesProduced).toBe(600)
    expect(g.totals.productionDefectPieces).toBe(6)
    expect(g.totals.releasedPieces).toBe(594)
    expect(g.totals.defectRatePct).toBeCloseTo(0.99, 2)
    expect(g.totals.machines).toBe(2)
    expect(g.totals.factories).toBe(2)
    expect(g.factories.map((f) => f.factory)).toEqual(['Factory 1', 'Factory 2'])
    const f1 = g.factories[0]
    expect(f1.piecesProduced).toBe(300)
    expect(f1.months.length).toBe(g.monthsBack)
    expect(f1.months[f1.months.length - 1].productionDefectPieces).toBe(5)
    expect(f1.defectRatePct).toBeCloseTo(1.64, 2)
    // Every machine with production, worst rate first, with its months.
    expect(g.machines.map((m) => m.workCenterCode)).toEqual(['31', '77'])
    expect(g.machines[0].process).toBe('forming')
    expect(g.machines[0].months.length).toBe(g.monthsBack)
    // Since the first session on record, whatever the period: by factory and by process.
    expect(g.allTime.factories.map((x) => [x.key, x.made, x.productionDefectPieces])).toEqual([['Factory 1', 305, 5], ['Factory 2', 301, 1]])
    expect(g.allTime.processes.map((x) => x.key).sort()).toEqual(['forming', 'universal'])
    expect(g.machines[0].defectRatePct).toBeCloseTo(1.64, 2)
    // On a period: the figures follow it, the trend keeps its months.
    const short = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${today(-1)}&to=${today(1)}`, { token: admin.token })).body
    expect(short.from).toBe(today(-1))
    expect(short.totals.piecesProduced).toBe(600)
    expect(short.months.length).toBe(g.monthsBack)
    expect(short.factories[0].months.length).toBe(g.monthsBack)
    const empty = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${today(-40)}&to=${today(-30)}`, { token: admin.token })).body
    expect(empty.totals.piecesProduced).toBe(0)
    // Nothing in the period, but the factories and machines of the trend window are still listed, their months intact.
    expect(empty.factories.map((f) => [f.factory, f.piecesProduced, f.defectRatePct])).toEqual([['Factory 1', 0, null], ['Factory 2', 0, null]])
    expect(empty.machines.map((m) => m.workCenterCode).sort()).toEqual(['31', '77'])
    expect(empty.window.to).toBe(g.window.to)
    // The all-time pie does not follow the period.
    expect(empty.allTime).toEqual(g.allTime)
    expect((await app.api('GET', `/api/kpi/general?from=${today(1)}&to=${today(-1)}`, { token: admin.token })).status).toBe(400)
  })

  it('takes several factories or processes at once', async () => {
    const both = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&factory=Factory%201,Factory%202`, { token: admin.token })
    expect(both.body.current.piecesProduced).toBe(600)
    expect(both.body.filters.factories).toEqual(['Factory 1', 'Factory 2'])
    const one = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&factory=Factory%202`, { token: admin.token })
    expect(one.body.current.piecesProduced).toBe(300)
    const procs = await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}&process=forming,universal`, { token: admin.token })
    expect(procs.body.filters.processes).toEqual(['forming', 'universal'])
    expect(procs.body.defects.map((d) => d.defectName)).toEqual(['Scratch', 'Dent'])
    expect((await app.api('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}&process=forming,lathe`, { token: admin.token })).status).toBe(400)
  })

  it('takes several machines at once', async () => {
    const both = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&workCenterCode=31,77`, { token: admin.token })
    expect(both.status).toBe(200)
    expect(both.body.current.piecesProduced).toBe(600)
    expect(both.body.byMachine.map((m) => m.key).sort()).toEqual(['31', '77'])
    expect(both.body.filters.workCenterCodes).toEqual(['31', '77'])
    const one = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&workCenterCode=77`, { token: admin.token })
    expect(one.body.current.piecesProduced).toBe(300)
  })

  it('breaks a scope down month by month: defects, orders, items, and first part released', async () => {
    expect((await app.api('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}`, { token: inspector.token })).status).toBe(403)
    const res = await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}&factory=Factory%201`, { token: admin.token })
    expect(res.status).toBe(200)
    const b = res.body
    const month = b.months.find((m) => m.sessions > 0)!
    expect(month.sessions).toBe(2)
    expect(month.piecesProduced).toBe(300)
    expect(month.productionDefectPieces).toBe(5)
    expect(month.made).toBe(305)
    expect(month.defectRatePct).toBeCloseTo(1.64, 2)
    // The scratch is every rejected piece of the factory, and 1.64% of the month's made pieces.
    expect(b.defects.map((d) => d.defectName)).toEqual(['Scratch'])
    expect(b.defects[0].sharePct).toBe(100)
    expect(b.defects[0].months.find((m) => m.month === month.month)!.pctOfMade).toBeCloseTo(1.64, 2)
    // Laid on the orders, each against what it made itself: 3 of 203 for the second, 2 of 102 for the first.
    // One row per order line, keyed by the line, named by its order number.
    expect(new Set(b.byOrder.map((r) => r.key)).size).toBe(2)
    expect(b.byOrder.map((r) => [r.label, r.pieces, r.made, r.pctOfMade, r.shareOfMonthPct, r.shareOfPeriodPct])).toEqual([
      ['30002-B', 3, 203, 1.478, 60, 60],
      ['30001-A', 2, 102, 1.961, 40, 40],
    ])
    expect(b.byItem).toEqual([expect.objectContaining({ key: 'UP8060', pieces: 5, made: 305, pctOfMade: 1.639, shareOfMonthPct: 100, shareOfPeriodPct: 100 })])
    // Both forming sessions had nothing rejected before release.
    expect(b.firstPart).toMatchObject({ sessions: 2, clean: 2, pct: 100, failed: [] })
    // The scope split for the trend lines: one factory here, one process.
    expect(b.series.factories.map((x) => x.key)).toEqual(['Factory 1'])
    expect(b.series.processes.map((x) => x.key)).toEqual(['forming'])
    expect(b.series.factories[0].months.find((m) => m.made > 0)).toMatchObject({ made: 305, productionDefectPieces: 5 })
    expect(b.series.factories[0]).toMatchObject({ made: 305, productionDefectPieces: 5 })
    expect(b.series.factories[0].defectRatePct).toBeCloseTo(1.64, 2)
    // And one series per machine of the scope, named as the register names it, with its factory.
    expect(b.series.machines.map((x) => [x.key, x.sub, x.productionDefectPieces])).toEqual([['31', 'Factory 1', 5]])
    expect(b.byDisposition).toEqual({ Repair: 5 })

    const all = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}`, { token: admin.token })).body
    expect(all.firstPart).toMatchObject({ sessions: 3, clean: 2 })
    expect(all.firstPart.pct).toBeCloseTo(66.67, 2)
    expect(all.firstPart.rejectedPieces).toBe(7)
    // 7 rejected before release over 2 clean sessions + 7: the floor's cumulative first pass yield.
    expect(all.firstPart.cumulativePct).toBeCloseTo(77.78, 2)
    expect(b.firstPart.cumulativePct).toBe(0)
    expect(all.firstPart.byMachine[0]).toMatchObject({ workCenterCode: '77', sessions: 1, clean: 0, pct: 0, rejectedPieces: 7 })
    expect(all.firstPart.failed).toEqual([expect.objectContaining({ workCenterCode: '77', orderNumber: '30003-C', rejectedBeforeRelease: 7 })])
    // The part on the machine, how many of its sessions were not clean, and the orders behind them.
    expect(all.firstPart.byPart).toEqual([
      expect.objectContaining({ workCenterCode: '77', itemCode: 'MAST120', sessions: 1, notClean: 1, rejectedPieces: 7, orders: [expect.objectContaining({ orderNumber: '30003-C', notClean: 1, rejectedPieces: 7 })] }),
    ])
    expect(all.firstPart.byPart[0].orders[0].sessionIds).toHaveLength(1)
    // One session with 7 pieces rejected before release.
    expect(all.firstPart.byQty).toEqual([{ workCenterCode: '77', qty: 7, sessions: 1 }])
    expect(b.firstPart.byPart).toEqual([])
    expect(all.firstPart.months.find((m) => m.sessions > 0)).toMatchObject({ sessions: 3, clean: 2, rejectedPieces: 7 })
    expect(all.firstPart.months.find((m) => m.sessions > 0)!.cumulativePct).toBeCloseTo(77.78, 2)
    expect(all.firstPart.byMachineMonth[0]).toMatchObject({ workCenterCode: '77', rejectedPieces: 7 })
    expect(all.firstPart.byMachineMonth[0].months.find((m) => m.sessions > 0)).toMatchObject({ sessions: 1, clean: 0, rejectedPieces: 7, cumulativePct: 100 })
    expect(all.firstPart.byMachineMonth[1].months.find((m) => m.sessions > 0)).toMatchObject({ sessions: 2, clean: 2, rejectedPieces: 0, cumulativePct: 0 })
    // A process scope and a machine scope work the same way.
    const mast = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}&process=universal`, { token: admin.token })).body
    expect(mast.defects.map((d) => d.defectName)).toEqual(['Dent'])
    expect(mast.filters.processes).toEqual(['universal'])
    const two = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${today(-1)}&to=${today(1)}&workCenterCode=31,77`, { token: admin.token })).body
    expect(two.filters.workCenterCodes).toEqual(['31', '77'])
    expect(two.defects.map((d) => d.defectName)).toEqual(['Scratch', 'Dent'])
  })
})
