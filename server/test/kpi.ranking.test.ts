// ============================================================================
// §16 — the inspector ranking, end to end.
//
// Two inspectors on the same machine, one recording completely and one
// leaving measurements blank. What must hold: the figures behind the score
// come from the records as written, the ranking places the complete record
// first, the per-factory lists are separate from the overall one, and an
// inspector with too little work is listed but never placed.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { KpiThresholdsResponse, SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let careful: Session
let hasty: Session
let newcomer: Session
let overview: KpiOverview

const SAMPLES = 12
/** Lowered from the default twenty so the case stays small; the bar itself
 *  is what the administrator sets, and the test sets it. */
const MIN_TO_RANK = 10
const today = (offset = 0) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const period = () => `from=${today(-1)}&to=${today(1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`

/** A forming sample: no PT record is asked for, so only what is tested here varies. */
function sample(measured: boolean, defects: number): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'BS9059/31',
    sampleQty: 100,
    dimensions: [
      { name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: measured ? 125.1 : null, unit: 'mm', source: 'item-order' },
      { name: 'Height', sequence: 2, nominal: 60, tolPlus: 0.5, tolMinus: 0.5, actual: measured ? 60.2 : null, unit: 'mm', source: 'item-order' },
    ],
    defects: Array.from({ length: defects }, () => ({ defectName: 'Bad edge', qty: 1, disposition: 'Repair' as const, notes: '', imageIds: [] })),
    coils: [],
  }
}

async function record(who: Session, order: ProductionOrder, measured: boolean, defects: number, times: number): Promise<void> {
  const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: who.token, body: { orderId: order.id, startQty: 0 } })
  for (let i = 0; i < times; i++) {
    const res = await app.api('POST', `/api/sessions/${started.body.id}/samples`, { token: who.token, body: sample(measured, defects) })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  careful = await app.register('careful', 'Hany Fathy')
  hasty = await app.register('hasty', 'Mostafa Zaki')
  newcomer = await app.register('newcomer', 'Ali Salah')
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
  })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: 'Bad edge' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        {
          lineKey: 'L-1',
          orderNumber: '20095-QC1-HYH',
          item: 'XL Light Beam',
          itemCode: '125185TA3',
          workCenterCode: '31',
          requiredQty: 5000,
          finishedQty: 0,
          customer: 'Beta Storage',
          expectedGrade: '',
          drawing: 'BS9059/31',
        },
      ],
    },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]

  const { thresholds } = (await app.api<KpiThresholdsResponse>('GET', '/api/kpi/thresholds', { token: admin.token })).body
  const saved = await app.api('PUT', '/api/kpi/thresholds', { token: admin.token, body: { ...thresholds, minSamplesForRanking: MIN_TO_RANK } })
  expect(saved.status).toBe(200)

  // Same machine, same item, same day: one measures everything and finds
  // defects; one leaves the measurements blank and finds none.
  await record(careful, order, true, 1, SAMPLES)
  await record(hasty, order, false, 0, SAMPLES)
  // And one who only just started.
  await record(newcomer, order, true, 0, 2)

  overview = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body
})
afterAll(() => app.stop())

describe('§16 — the ranking comes from the records as written', () => {
  it('counts each inspector’s own work', () => {
    const rows = overview.inspectorRanking.overall.ranked
    const one = rows.find((r) => r.inspectorId === careful.user.id)!
    expect(one.samples).toBe(SAMPLES)
    expect(one.pieces).toBe(SAMPLES * 100)
    expect(one.activeDays).toBe(1)
    expect(one.samplesPerActiveDay).toBe(SAMPLES)
    expect(one.dimensionRows).toBe(SAMPLES * 2)
    expect(one.dimensionsMeasured).toBe(SAMPLES * 2)
    expect(one.sessionsOpened).toBe(1)
  })

  it('places the complete record above the blank one', () => {
    const rows = overview.inspectorRanking.overall.ranked
    expect(rows[0].inspectorId).toBe(careful.user.id)
    expect(rows[0].rank).toBe(1)
    expect(rows[0].dimensionCompletionPct).toBe(100)
    const behind = rows.find((r) => r.inspectorId === hasty.user.id)!
    expect(behind.dimensionCompletionPct).toBe(0)
    expect(behind.score).toBeLessThan(rows[0].score)
  })

  it('does not punish the inspector who found the defects', () => {
    const rows = overview.inspectorRanking.overall.ranked
    const found = rows.find((r) => r.inspectorId === careful.user.id)!
    const foundNothing = rows.find((r) => r.inspectorId === hasty.user.id)!
    expect(found.defectRecords).toBe(SAMPLES)
    expect(foundNothing.defectRecords).toBe(0)
    // Peer-relative: one found everything on this machine, the other nothing.
    expect(found.detectionScore).toBeGreaterThan(foundNothing.detectionScore)
  })

  it('lists the newcomer without placing them', () => {
    const { ranked, unranked } = overview.inspectorRanking.overall
    expect(ranked.map((r) => r.inspectorId)).not.toContain(newcomer.user.id)
    expect(unranked.map((r) => r.inspectorId)).toContain(newcomer.user.id)
    expect(overview.inspectorRanking.minSamples).toBe(MIN_TO_RANK)
  })

  it('ranks each factory on its own as well as overall', () => {
    expect(overview.inspectorRanking.byFactory.map((g) => g.factory)).toEqual(['Factory 1'])
    const f = overview.inspectorRanking.byFactory[0]
    expect(f.ranked.map((r) => r.inspectorId)).toEqual(overview.inspectorRanking.overall.ranked.map((r) => r.inspectorId))
  })

  it('follows the dashboard filters', async () => {
    const only = (
      await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&inspectorId=${careful.user.id}`, { token: admin.token })
    ).body.inspectorRanking
    expect(only.overall.ranked.concat(only.overall.unranked).map((r) => r.inspectorId)).toEqual([careful.user.id])
  })

  it('keeps the ranking out of reach of an inspector', async () => {
    expect((await app.api('GET', `/api/kpi/overview?${period()}`, { token: careful.token })).status).toBe(403)
  })
})
