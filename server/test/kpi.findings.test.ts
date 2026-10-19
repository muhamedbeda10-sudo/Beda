// ============================================================================
// §15 / §16 — dashboard figures that must be counted over the whole record,
// on what they say they count:
//   • "% of dimensions out of tolerance" over judged dimensions only: a
//     reading with no specification (paint thickness) is Pending, not a pass;
//   • coverage: open lines sampled, of the open lines — never a line sampled
//     and since finished or cancelled;
//   • shifts compared on their inspected defect rate (a shift has no
//     production of its own);
//   • Holds counted and summed whole, not over the fifty listed;
//   • the ranking's empty sessions: those discarded too, and those opened in
//     a factory where the inspector recorded no sample.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let insp: Session
let other: Session
let orders: ProductionOrder[]

const line = (key: string) => orders.find((o) => o.lineKey === key)!
const period = () => `from=${factoryDay(-1)}&to=${factoryDay(1)}&prevFrom=${factoryDay(-31)}&prevTo=${factoryDay(-2)}`
const overview = async () => (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body

type Dim = SaveSampleRequest['dimensions'][number]
const judged = (name: string, actual: number): Dim => ({ name, sequence: 1, nominal: 100, tolPlus: 0.5, tolMinus: 0.5, actual, unit: 'mm', source: 'item-order' })
/** A reading with no specification to judge it by, as paint thickness is saved: Pending. */
const unjudged = (sequence: number, actual: number): Dim => ({ name: 'Paint thickness', sequence, nominal: null, tolPlus: null, tolMinus: null, actual, unit: 'µm', source: 'item-order' })

/**
 * Close what an earlier test left open on a line: one session per line is open at a time, and these tests each open
 * their own. Closed as it stands (no samples are added), so no figure a test reads changes by it.
 */
async function freeLine(order: ProductionOrder): Promise<void> {
  await app.db.query(`UPDATE inspection_sessions SET status = 'Closed', closed_at = now() WHERE order_id = $1 AND status = 'Open' AND deleted_at IS NULL`, [order.id])
}

async function start(who: Session, order: ProductionOrder): Promise<string> {
  const res = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: who.token, body: { orderId: order.id, startQty: 0 } })
  if (res.status !== 201) throw new Error(`session failed ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.id
}

async function record(who: Session, session: string, s: { qty: number; dims?: Dim[]; defects?: { name: string; qty: number; disposition: 'Repair' | 'Hold' }[] }): Promise<void> {
  const body: SaveSampleRequest = {
    submissionId: randomUUID(),
    drawing: 'D-1',
    sampleQty: s.qty,
    dimensions: s.dims ?? [],
    defects: (s.defects ?? []).map((d) => ({ defectName: d.name, qty: d.qty, disposition: d.disposition, notes: '', imageIds: [] })),
    coils: [],
  }
  const res = await app.api('POST', `/api/sessions/${session}/samples`, { token: who.token, body })
  if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Hany Fathy')
  other = await app.register('other', 'Mostafa Zaki')
  for (const m of [
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
    { code: '48', name: 'Forming', line: 'LM4', displayName: '48-Forming-LM4', process: 'forming', factory: 'Factory 2' },
  ]) {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: m })
  }
  for (const code of ['31', '48']) await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: code, defectName: 'Bad edge' } })
  const row = (lineKey: string, workCenterCode: string) => ({ lineKey, orderNumber: `O-${lineKey}`, item: `Item ${lineKey}`, itemCode: `IC-${lineKey}`, workCenterCode, requiredQty: 1000, finishedQty: 0, customer: 'Beta', drawing: 'D-1' })
  await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [row('L1', '31'), row('L2', '31'), row('L3', '31'), row('L4', '31'), row('P1', '48')] } })
  orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
})
afterAll(() => app.stop())

describe('§15 dimensions out of tolerance: judged dimensions only', () => {
  it('leaves readings with no specification out of the measured count, and a machine with only those without a figure', async () => {
    const s1 = await start(insp, line('L1'))
    await record(insp, s1, { qty: 10, dims: [judged('Width', 100.6), { ...judged('Height', 100.1), sequence: 2 }] })
    const p1 = await start(insp, line('P1'))
    await record(insp, p1, { qty: 10, dims: [unjudged(1, 61), unjudged(2, 59), unjudged(3, 75)] })
    const o = await overview()
    // Two judged dimensions, one of them failed: 50%, not 1 of 5.
    expect(o.current.dimensionsMeasured).toBe(2)
    expect(o.current.dimensionsFail).toBe(1)
    expect(o.current.dimensionsPass).toBe(1)
    expect(o.current.dimFailPct).toBe(50)
    const byMachine = new Map(o.byMachine.map((m) => [m.key, m.dimFailPct]))
    expect(byMachine.get('31')).toBe(50)
    expect(byMachine.get('48')).toBeNull()
  })
})

describe('§15 coverage: open lines sampled, of the open lines', () => {
  it('counts only sampled lines that are still open', async () => {
    // L1 is sampled and open (above). L2 is open and not sampled. L3 and L4
    // are sampled, then L3 is finished and L4 cancelled on the ERP sheet.
    for (const key of ['L3', 'L4']) await record(insp, await start(insp, line(key)), { qty: 10 })
    await app.db.query(`UPDATE production_orders SET finished_qty = required_qty WHERE line_key = 'L3'`)
    await app.db.query(`UPDATE production_orders SET erp_status = 'Cancelled' WHERE line_key = 'L4'`)
    const d = (await overview()).discipline
    // Open: L1, L2 and P1; sampled among them: L1 and P1.
    expect(d.openLines).toBe(3)
    expect(d.openLinesInspected).toBe(2)
    expect(d.coveragePct).toBe(66.7)
  })

  it('shows no sampled open line when none of the open lines was sampled', async () => {
    const f = `${period()}&workCenterCode=31&itemCode=IC-L2`
    const d = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${f}`, { token: admin.token })).body.discipline
    expect(d.openLines).toBe(1)
    expect(d.openLinesInspected).toBe(0)
    expect(d.coveragePct).toBe(0)
  })
})

describe('§15 shifts compared on what they inspected', () => {
  it('names the shift that finds twice the defects of another', async () => {
    const s = await start(other, line('L2'))
    await record(other, s, { qty: 100, defects: [{ name: 'Bad edge', qty: 1, disposition: 'Repair' }] })
    await record(other, s, { qty: 100, defects: [{ name: 'Bad edge', qty: 8, disposition: 'Repair' }] })
    const ids = (await app.db.query<{ id: string }>(`SELECT id FROM inspection_samples WHERE session_id = $1 ORDER BY created_at, id`, [s])).rows.map((r) => r.id)
    // Every other sample of the period is the morning's: the second of these is the night's.
    await app.db.query(`UPDATE inspection_samples SET shift = 'A' WHERE session_id <> $1`, [s])
    await app.db.query(`UPDATE inspection_samples SET shift = 'A' WHERE id = $1`, [ids[0]])
    await app.db.query(`UPDATE inspection_samples SET shift = 'C' WHERE id = $1`, [ids[1]])
    const o = await overview()
    const byShift = new Map(o.byShift.map((r) => [r.key, r]))
    expect(byShift.get('C')?.defectRatePct).toBeNull()
    expect(byShift.get('C')?.inspectedDefectPct).toBe(8)
    const insight = o.insights.find((i) => i.id === 'shift-outlier')
    expect(insight?.title).toBe(`Shift C runs at 8.00% defects of inspected, shift A at ${byShift.get('A')!.inspectedDefectPct!.toFixed(2)}%`)
  })
})

describe('§15 Holds: counted and summed whole', () => {
  it('counts every Hold and its pieces, not the fifty listed', async () => {
    await freeLine(line('L1'))
    const s = await start(other, line('L1'))
    for (let i = 0; i < 3; i++) {
      await record(other, s, { qty: 100, defects: Array.from({ length: 20 }, () => ({ name: 'Bad edge', qty: 2, disposition: 'Hold' as const })) })
    }
    // Forty days on Hold: past every age line.
    await app.db.query(`UPDATE inspection_samples SET created_at = now() - interval '40 days' WHERE session_id = $1`, [s])
    const o = await overview()
    expect(o.holds).toHaveLength(50)
    expect(o.counts.holds).toBe(60)
    expect(o.holdTotals).toEqual({ defects: 60, pieces: 120, amber: 0, red: 60 })
    const insight = o.insights.find((i) => i.id === 'hold-aging-red')!
    expect(insight.title).toBe(`60 defects on Hold for ${o.thresholds.holdAgeRedDays}+ days`)
    expect(insight.detail).toContain('120 pieces on Hold in total.')
  })
})

describe('§16 the ranking’s empty sessions', () => {
  it('counts sessions discarded, and sessions in a factory where no sample was recorded', async () => {
    await freeLine(line('L2'))
    await freeLine(line('P1'))
    const before = (await overview()).inspectorRanking!
    const row = (r: KpiOverview['inspectorRanking']) => [...r!.overall.ranked, ...r!.overall.unranked].find((x) => x.inspectorId === insp.user.id)!
    const was = row(before)
    // One session opened and discarded on machine 31, one left empty on machine 48 (Factory 2).
    const discarded = await start(insp, line('L2'))
    expect((await app.api('POST', `/api/sessions/${discarded}/discard`, { token: insp.token })).status).toBe(204)
    await start(other, line('P1'))
    const after = (await overview()).inspectorRanking!
    expect(row(after).sessionsOpened).toBe(was.sessionsOpened + 1)
    expect(row(after).emptySessions).toBe(was.emptySessions + 1)
    // Mostafa recorded nothing in Factory 2: his empty session there still counts, on a row of its own.
    const factory2 = after.byFactory.find((f) => f.factory === 'Factory 2')!
    const mostafa = [...factory2.ranked, ...factory2.unranked].find((x) => x.inspectorId === other.user.id)!
    expect(mostafa).toMatchObject({ samples: 0, sessionsOpened: 1, emptySessions: 1 })
    const overall = [...after.overall.ranked, ...after.overall.unranked].find((x) => x.inspectorId === other.user.id)!
    expect(overall.emptySessions).toBeGreaterThanOrEqual(1)
  })
})
