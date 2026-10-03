// ============================================================================
// §15 — Comparisons: the processes side by side by month and over the period,
// and the machines of one process side by side over the period, at a grain
// that follows the period's length. A universal line closed in two stages is
// made once, in each point and in the span.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DashboardLayoutResponse, SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { defaultDashboardLayouts, type KpiComparisons } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session

function today(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

const defect = (qty: number): SaveSampleRequest['defects'] => [{ defectName: 'Scratch', qty, disposition: 'Repair', notes: '', imageIds: [] }]

/** Open a session on the line, record one sample with the defects, close it on the final quantity. */
async function run(order: ProductionOrder, defects: SaveSampleRequest['defects'], finalQty: number, stage?: number): Promise<void> {
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })
  expect(opened.status).toBe(201)
  const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, { token: inspector.token, body: { submissionId: randomUUID(), drawing: 'D-1', sampleQty: 10, dimensions: [], defects, coils: [] } })
  if (saved.status !== 201) throw new Error(`sample save ${saved.status} ${JSON.stringify(saved.body)}`)
  const before = await app.api<SessionWithOrder>('GET', `/api/sessions/${opened.body.id}`, { token: inspector.token })
  const closed = await app.api('POST', `/api/sessions/${opened.body.id}/close`, { token: inspector.token, body: { finalQty, version: before.body.version, ...(stage ? { stage } : {}) } })
  if (closed.status !== 200) throw new Error(`close ${closed.status} ${JSON.stringify(closed.body)}`)
}

const compare = (from: string, to: string, process = 'forming') => app.api<KpiComparisons>('GET', `/api/kpi/comparisons?from=${from}&to=${to}&process=${process}`, { token: admin.token })

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
  const row = (lineKey: string, workCenterCode: string) => ({ lineKey, orderNumber: `ORD-${lineKey}`, item: 'Upright', itemCode: 'UP', workCenterCode, requiredQty: 500, finishedQty: 0, customer: 'A', expectedGrade: '', drawing: 'D-1' })
  await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [row('C-31', '31'), row('C-32', '32'), row('C-77', '77')] } })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  const line = (key: string) => orders.find((o) => o.lineKey === key)!
  await run(line('C-31'), defect(2), 100)
  await run(line('C-32'), defect(3), 200)
  // One universal line, two stages: the same 300 pieces typed twice, a defect in each.
  await run(line('C-77'), defect(1), 300, 1)
  await run(line('C-77'), defect(1), 300, 2)
})
afterAll(() => app.stop())

describe('§15 — Comparisons', () => {
  it('draws a short period a day a point, the processes side by side', async () => {
    const res = await compare(today(-1), today(1))
    expect(res.status).toBe(200)
    const { period } = res.body
    expect(period.grain).toBe('day')
    expect(period.buckets.map((b) => b.key)).toEqual([today(-1), today(0), today(1)])
    const forming = period.series.find((s) => s.key === 'forming')!
    expect(forming).toMatchObject({ made: 305, productionDefectPieces: 5, label: 'forming' })
    expect(forming.defectRatePct).toBeCloseTo((5 / 305) * 100, 3)
    // Nothing made yesterday or tomorrow: no rate there, the line breaks.
    expect(forming.points.map((p) => p.defectRatePct === null)).toEqual([true, false, true])
    // The universal line is made once: 300 pieces and the two stages' defects.
    expect(period.series.find((s) => s.key === 'universal')).toMatchObject({ made: 302, productionDefectPieces: 2 })
  })

  it('lays the machines of the process picked side by side, and only those', async () => {
    const { machines } = (await compare(today(-1), today(1))).body
    expect(machines.series.map((m) => [m.key, m.label, m.factory, m.made, m.productionDefectPieces])).toEqual([
      ['32', '32-Roll Forming-LM3', 'Factory 1', 203, 3],
      ['31', '31-Roll Forming-LM2', 'Factory 1', 102, 2],
    ])
    const universal = (await compare(today(-1), today(1), 'universal')).body
    expect(universal.process).toBe('universal')
    expect(universal.machines.series.map((m) => [m.key, m.made])).toEqual([['77', 302]])
  })

  it('keeps the month chart on the trend window, whatever the period', async () => {
    const short = (await compare(today(-1), today(1))).body.window
    const long = (await compare(today(-200), today(0))).body.window
    expect(short.grain).toBe('month')
    expect(long).toEqual(short)
    expect(short.buckets.at(-1)?.key).toBe(today(0).slice(0, 7))
    expect(short.series.find((s) => s.key === 'forming')?.made).toBe(305)
  })

  it('draws up to three months a week a point and longer ones a month a point', async () => {
    const weeks = (await compare(today(-59), today(0))).body.period
    expect(weeks.grain).toBe('week')
    expect(weeks.buckets).toHaveLength(9)
    expect(weeks.buckets[0]).toEqual({ key: today(-59), from: today(-59), to: today(-53) })
    // Everything happened today: the last week holds it.
    expect(weeks.series.find((s) => s.key === 'forming')?.points.at(-1)?.made).toBe(305)
    const months = (await compare(today(-200), today(0))).body.period
    expect(months.grain).toBe('month')
    expect(months.buckets.at(-1)?.to).toBe(today(0))
    expect(months.series.find((s) => s.key === 'universal')?.points.at(-1)?.made).toBe(302)
  })

  it('refuses a process it does not know, a period too long, and a reader without the dashboard', async () => {
    expect((await compare(today(-1), today(1), 'lathe')).status).toBe(400)
    expect((await compare(today(-400), today(0))).status).toBe(400)
    expect((await app.api('GET', `/api/kpi/comparisons?from=${today(-1)}&to=${today(1)}&process=forming`, { token: inspector.token })).status).toBe(403)
  })

  it('keeps its own arrangement on the board, and gives one to a client that sends none', async () => {
    const layouts = defaultDashboardLayouts()
    layouts.comparisons = layouts.comparisons.map((it) => (it.i === 'c.machinesPie' ? { ...it, hidden: true } : it))
    const saved = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts } })
    expect(saved.status).toBe(200)
    expect(saved.body.layouts.comparisons.find((it) => it.i === 'c.machinesPie')?.hidden).toBe(true)
    const older = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { general: layouts.general, details: layouts.details } } })
    expect(older.status).toBe(200)
    expect(older.body.layouts.comparisons).toEqual(defaultDashboardLayouts().comparisons)
  })
})
