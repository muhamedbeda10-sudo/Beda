import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, AuditListResponse, KpiThresholdsResponse, SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { DEFAULT_KPI_THRESHOLDS, type KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let weldOrder: ProductionOrder
let sessionId: string
let coilId: string

function sample(overrides: Partial<SaveSampleRequest> = {}): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'BS9059/58',
    sampleQty: 10,
    dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
    defects: [],
    coils: [{ coilId, coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }],
    pt: {
      testFrequencyPct: 10,
      consumableLots: { Cleaner: 'B24-0388', Penetrant: 'B24-0417', Developer: 'B24-0511' },
      weldingWireBatch: 'WW-2401',
      testedLengths: [
        { lengthMm: 150, verdict: 'Accept' },
        { lengthMm: 90, verdict: 'Reject / Repair' },
      ],
      imageIds: [],
    },
    ...overrides,
  }
}

function today(offsetDays = 0): string {
  return factoryDay(offsetDays)
}

const period = () => `from=${today(-1)}&to=${today(1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting Line', line: 'LM4', displayName: '48-Painting Line-LM4', process: 'paint', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '58', defectName: 'Weld porosity' } })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '58', defectName: 'Undercut' } })
  await app.api('POST', '/api/master/pt-consumables', { token: admin.token, body: { kind: 'Cleaner', productName: 'SKC-S', lotBatch: 'B24-0388' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 2000, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' },
        { lineKey: 'L-2', orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 900, customer: 'Alpha Racking', expectedGrade: 'ST52-3', drawing: 'BS9059/48' },
      ],
    },
  })
  await app.api('POST', '/api/coils/import', { token: admin.token, body: { rows: [{ coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }] } })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  weldOrder = orders.find((o) => o.lineKey === 'L-1')!
  const coil = await app.db.query<{ id: string }>(`SELECT id FROM coils WHERE coil_number = 'C10021'`)
  coilId = coil.rows[0].id
  const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 500 } })
  sessionId = started.body.id
  // Three samples: one clean, one with a Hold defect, one with a failed dimension.
  for (const body of [
    sample(),
    sample({ defects: [{ defectName: 'Weld porosity', qty: 3, disposition: 'Hold', notes: '', imageIds: [] }] }),
    sample({ dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 126.4, unit: 'mm', source: 'item-order' }], defects: [{ defectName: 'Undercut', qty: 1, disposition: 'Repair', notes: '', imageIds: [] }] }),
  ]) {
    const res = await app.api('POST', `/api/sessions/${sessionId}/samples`, { token: inspector.token, body })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
})
afterAll(() => app.stop())

describe('kpi span', () => {
  it('starts the record on the day of the first inspection', async () => {
    const res = await app.api<{ firstDay: string | null }>('GET', '/api/kpi/span', { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.firstDay).toBe(today())
  })
  it('is for the dashboard only', async () => {
    expect((await app.api('GET', '/api/kpi/span', { token: inspector.token })).status).toBe(403)
  })
})

describe('kpi thresholds', () => {
  it('are the defaults until an administrator changes them', async () => {
    const res = await app.api<KpiThresholdsResponse>('GET', '/api/kpi/thresholds', { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.thresholds).toEqual(DEFAULT_KPI_THRESHOLDS)
    expect(res.body.updatedAt).toBeUndefined()
  })

  it('are hidden from anyone without the dashboard capability', async () => {
    expect((await app.api('GET', '/api/kpi/thresholds', { token: inspector.token })).status).toBe(403)
    expect((await app.api('GET', `/api/kpi/overview?${period()}`, { token: inspector.token })).status).toBe(403)
  })

  it('reject an order that makes no sense', async () => {
    const res = await app.api<ApiErrorBody>('PUT', '/api/kpi/thresholds', { token: admin.token, body: { ...DEFAULT_KPI_THRESHOLDS, defectRateGreen: 6, defectRateAmber: 5 } })
    expect(res.status).toBe(400)
  })

  it('are stored with the change in the audit log', async () => {
    const res = await app.api<KpiThresholdsResponse>('PUT', '/api/kpi/thresholds', { token: admin.token, body: { ...DEFAULT_KPI_THRESHOLDS, defectRateGreen: 1, holdAgeRedDays: 4 } })
    expect(res.status).toBe(200)
    expect(res.body.thresholds.defectRateGreen).toBe(1)
    expect(res.body.thresholds.holdAgeRedDays).toBe(4)
    expect(res.body.updatedByName).toBe('Admin')
    const again = await app.api<KpiThresholdsResponse>('GET', '/api/kpi/thresholds', { token: admin.token })
    expect(again.body.thresholds.defectRateGreen).toBe(1)
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    const entries = audit.body.entries.filter((e) => e.entity === 'AppSettings')
    expect(entries.map((e) => e.field).sort()).toEqual(['defectRateGreen', 'holdAgeRedDays'])
    expect(entries.find((e) => e.field === 'defectRateGreen')?.oldValue).toBe('2')
  })
})

describe('kpi overview', () => {
  it('validates the period', async () => {
    const backwards = await app.api<ApiErrorBody>('GET', `/api/kpi/overview?from=${today(1)}&to=${today(-1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`, { token: admin.token })
    expect(backwards.status).toBe(400)
    const tooLong = await app.api<ApiErrorBody>('GET', `/api/kpi/overview?from=2020-01-01&to=2021-06-01&prevFrom=2019-01-01&prevTo=2019-12-31`, { token: admin.token })
    expect(tooLong.status).toBe(400)
    const notADay = await app.api<ApiErrorBody>('GET', `/api/kpi/overview?from=2024-02-30&to=2024-03-01&prevFrom=2024-01-01&prevTo=2024-01-31`, { token: admin.token })
    expect(notADay.status).toBe(400)
  })

  it('computes the period from the records as written', async () => {
    const res = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })
    expect(res.status).toBe(200)
    const o = res.body
    expect(o.current.sessions).toBe(1)
    expect(o.current.samples).toBe(3)
    expect(o.current.pieces).toBe(30)
    expect(o.current.defectPieces).toBe(4)
    expect(o.current.defectRecords).toBe(2)
    // The session is still open: no production yet, so no defect rate; the inspected view is 4 of 30.
    expect(o.current.defectRatePct).toBeNull()
    expect(o.current.inspectedDefectPct).toBeCloseTo(13.33, 1)
    expect(o.current.piecesProduced).toBe(0)
    expect(o.current.producedSessions).toBe(0)
    // One clean sample of three.
    expect(o.current.fpyPct).toBeCloseTo(33.33, 1)
    expect(o.current.dimensionsMeasured).toBe(3)
    expect(o.current.dimensionsFail).toBe(1)
    expect(o.current.byDisposition).toEqual({ Hold: 3, Repair: 1 })
    expect(o.current.ptLengthsTested).toBe(6)
    expect(o.current.ptLengthsRejected).toBe(3)
    expect(o.current.activeInspectors).toBe(1)
    expect(o.current.machinesInspected).toBe(1)
    expect(o.current.samplesPerSession).toBe(3)
    expect(o.previous.samples).toBe(0)
    expect(o.daily).toHaveLength(1)
    expect(o.daily[0].samples).toBe(3)
    expect(o.pareto.map((p) => [p.defectName, p.pieces])).toEqual([
      ['Weld porosity', 3],
      ['Undercut', 1],
    ])
    expect(o.pareto[0].sharePct).toBe(75)
    expect(o.pareto[1].cumulativePct).toBe(100)
    expect(o.byMachine).toHaveLength(1)
    expect(o.byMachine[0].key).toBe('58')
    expect(o.byMachine[0].sub).toBe('Factory 1')
    expect(o.byInspector[0].label).toBe('Inspector One')
    expect(o.byItem[0].key).toBe('125185TA3')
    // Coils are consumed by roll forming; a welding line's coil says nothing
    // about its supplier, so the welding samples here do not count.
    expect(o.suppliers).toEqual([])
    expect(o.counts.suppliers).toBe(0)
    // Every sample sits in exactly one band of defect rate.
    expect(o.defectRateBands.map((b) => b.band)).toEqual(['0%', '≤1%', '1–3%', '3–5%', '5–10%', '>10%'])
    expect(o.defectRateBands.reduce((s, b) => s + b.samples, 0)).toBe(3)
    expect(o.defectRateBands.find((b) => b.band === '0%')?.samples).toBe(1)
    // The Pareto per machine: one machine, shares of its own pieces.
    expect(o.paretoByMachine).toHaveLength(1)
    expect(o.paretoByMachine[0].workCenterCode).toBe('58')
    expect(o.paretoByMachine[0].rows.map((r) => r.defectName)).toEqual(['Weld porosity', 'Undercut'])
    expect(o.paretoByMachine[0].rows[1].cumulativePct).toBe(100)
    // What the item is known to suffer, with the machine it came from.
    expect(o.itemDefects.map((r) => [r.itemCode, r.defectName, r.workCenterCode, r.pieces])).toEqual([
      ['125185TA3', 'Weld porosity', '58', 3],
      ['125185TA3', 'Undercut', '58', 1],
    ])
    expect(o.itemDefects[0].sharePct).toBe(75)
    expect(o.paintByItem).toEqual([])
    expect(o.holds).toHaveLength(1)
    expect(o.holds[0].defectName).toBe('Weld porosity')
    expect(o.holds[0].qty).toBe(3)
    expect(o.holds[0].ageDays).toBe(0)
    expect(o.discipline.coveragePct).toBe(50)
    expect(o.discipline.typedCoilPct).toBe(0)
    // The thresholds saved above colour this overview.
    expect(o.thresholds.defectRateGreen).toBe(1)
    const ids = o.insights.map((i) => i.id)
    // No session has closed with a final quantity yet: the defect rate has nothing to stand on, so no rate insight.
    expect(ids).not.toContain('defect-rate-red')
    expect(ids).toContain('hold-open')
    expect(ids).not.toContain('on-target')
  })

  it('narrows to a machine, an inspector or a shift', async () => {
    const other = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&workCenterCode=48`, { token: admin.token })
    expect(other.body.current.samples).toBe(0)
    expect(other.body.insights.map((i) => i.id)).toEqual(['no-data'])
    const mine = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&inspectorId=${inspector.user.id}&factory=Factory%201`, { token: admin.token })
    expect(mine.body.current.samples).toBe(3)
    const nobody = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&inspectorId=${admin.user.id}`, { token: admin.token })
    expect(nobody.body.current.samples).toBe(0)
  })

  it('answers a period with nothing in it with empty bands, not an error', async () => {
    const res = await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&workCenterCode=48`, { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.defectRateBands.every((b) => b.samples === 0)).toBe(true)
    expect(res.body.paretoByMachine).toEqual([])
    expect(res.body.itemDefects).toEqual([])
  })
})

describe('the defect rate is over production (§15)', () => {
  it('closes on a final quantity below the defective pieces: the final quantity is the good production', async () => {
    const before = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionId}`, { token: inspector.token })
    expect((await app.api('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 3, version: before.body.version } })).status).toBe(200)
    // 4 rejected against 3 produced: 4 of 7 made.
    const o = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body
    expect(o.current.piecesProduced).toBe(3)
    expect(o.current.defectRatePct).toBeCloseTo(57.14, 1)
    const closed = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionId}`, { token: admin.token })
    expect((await app.api('POST', `/api/sessions/${sessionId}/reopen`, { token: admin.token, body: { version: closed.body.version } })).status).toBe(200)
  })

  it('counts the closed session\'s production and the defects of its batch', async () => {
    const before = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionId}`, { token: inspector.token })
    expect((await app.api('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 200, version: before.body.version } })).status).toBe(200)
    const o = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body
    expect(o.current.piecesProduced).toBe(200)
    expect(o.current.producedSessions).toBe(1)
    expect(o.current.productionDefectPieces).toBe(4)
    // 4 rejected of 204 made: produced + rejected is the base.
    expect(o.current.defectRatePct).toBeCloseTo(1.96, 2)
    expect(o.current.inspectedDefectPct).toBeCloseTo(13.33, 1)
    // 2% against the 1% target saved earlier (limit 5%): the rate insight is back as a warning, and it quotes production.
    const amber = o.insights.find((i) => i.id === 'defect-rate-amber')!
    expect(amber.severity).toBe('warning')
    expect(amber.detail).toContain('4 rejected pieces against 200 produced')
    // Ordered most serious first.
    const order = ['critical', 'warning', 'good', 'info']
    const ranks = o.insights.map((i) => order.indexOf(i.severity))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    // The machine and the item carry the production; an inspector or a shift cannot.
    expect(o.byMachine[0].piecesProduced).toBe(200)
    expect(o.byMachine[0].defectRatePct).toBeCloseTo(1.96, 2)
    expect(o.byMachine[0].inspectedDefectPct).toBeCloseTo(13.33, 1)
    expect(o.byItem[0].piecesProduced).toBe(200)
    expect(o.byInspector[0].piecesProduced).toBeNull()
    expect(o.byInspector[0].defectRatePct).toBeNull()
    expect(o.byShift[0].defectRatePct).toBeNull()
    // The day it was closed carries the production.
    const today = o.daily.find((d) => d.piecesProduced > 0)!
    expect(today.productionDefectPieces).toBe(4)
    expect(today.defectRatePct).toBeCloseTo(1.96, 2)
    // Narrowed to an inspector, production is not attributable: no rate.
    const byInspector = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}&inspectorId=${inspector.user.id}`, { token: admin.token })).body
    expect(byInspector.current.piecesProduced).toBe(0)
    expect(byInspector.current.defectRatePct).toBeNull()
    expect(byInspector.current.inspectedDefectPct).toBeCloseTo(13.33, 1)
    // A correction of the final quantity below the defects is allowed for the same reason.
    const closed = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionId}`, { token: admin.token })
    expect((await app.api('PATCH', `/api/sessions/${sessionId}/quantities`, { token: admin.token, body: { finalQty: 200, version: closed.body.version } })).status).toBe(200)
  })
})
