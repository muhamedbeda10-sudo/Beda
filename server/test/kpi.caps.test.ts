// ============================================================================
// §15 — what the dashboard shows, and what it says it is showing.
//
// Every headline figure is counted over every record the filters match. Some
// lists are the largest few of something — the Pareto's fifteen defect types,
// the oldest fifty Holds. Two things must hold for those: the shares must be
// of the whole period rather than of the rows that fitted, and the page must
// be told how many exist behind each list.
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
let overview: KpiOverview

/** More defect types than the Pareto chart holds. */
const TYPES = 20
const PARETO_ROWS = 15
/** Defect i carries i pieces, so every share is distinct and checkable. */
const PIECES_TOTAL = (TYPES * (TYPES + 1)) / 2 // 210
const SHOWN_PIECES = ((TYPES + (TYPES - PARETO_ROWS + 1)) * PARETO_ROWS) / 2 // 195: types 20 down to 6

const defectName = (i: number) => `Defect ${String(i).padStart(2, '0')}`
const today = (offset = 0) => {
  return factoryDay(offset)
}
const period = () => `from=${today(-1)}&to=${today(1)}&prevFrom=${today(-31)}&prevTo=${today(-2)}`

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    // Roll forming: no PT record is required, so the samples here are only
    // about the defects the Pareto counts.
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
  })
  for (let i = 1; i <= TYPES; i++) {
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: defectName(i) } })
  }
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
          requiredQty: 2500,
          finishedQty: 0,
          customer: 'Beta Storage',
          expectedGrade: '',
          drawing: 'BS9059/31',
        },
      ],
    },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })

  // Two samples carry all twenty types: the tenth largest is as real a record
  // as the largest, and the dashboard must account for it either way.
  for (const range of [
    [1, 10],
    [11, TYPES],
  ]) {
    const body: SaveSampleRequest = {
      submissionId: randomUUID(),
      drawing: 'BS9059/31',
      sampleQty: 500,
      dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
      defects: Array.from({ length: range[1] - range[0] + 1 }, (_, k) => ({
        defectName: defectName(range[0] + k),
        qty: range[0] + k,
        // Every one on Hold: the Hold list is the other capped list on the page.
        disposition: 'Hold' as const,
        notes: '',
        imageIds: [],
      })),
      coils: [],
    }
    const res = await app.api('POST', `/api/sessions/${started.body.id}/samples`, { token: inspector.token, body })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
  overview = (await app.api<KpiOverview>('GET', `/api/kpi/overview?${period()}`, { token: admin.token })).body
})
afterAll(() => app.stop())

describe('§15 — the dashboard counts everything and says what it lists', () => {
  it('counts every defect piece in the headline figures', () => {
    // Not the fifteen on the chart: all twenty types.
    expect(overview.current.defectPieces).toBe(PIECES_TOTAL)
    expect(overview.current.defectRecords).toBe(TYPES)
  })

  it('takes Pareto shares over the whole period, not over the bars shown', () => {
    expect(overview.pareto).toHaveLength(PARETO_ROWS)
    // The largest type is 20 of 210 pieces — 9.52%, not 20 of the 195 shown.
    expect(overview.pareto[0].defectName).toBe(defectName(TYPES))
    expect(overview.pareto[0].sharePct).toBeCloseTo((TYPES / PIECES_TOTAL) * 100, 2)
    // The last bar does not pretend to complete the chart.
    expect(overview.pareto[PARETO_ROWS - 1].cumulativePct).toBeCloseTo((SHOWN_PIECES / PIECES_TOTAL) * 100, 2)
    expect(overview.pareto[PARETO_ROWS - 1].cumulativePct).toBeLessThan(100)
  })

  it('accounts for the types that did not fit', () => {
    expect(overview.paretoOthers).toEqual({
      types: TYPES - PARETO_ROWS,
      pieces: PIECES_TOTAL - SHOWN_PIECES,
      sharePct: expect.closeTo(((PIECES_TOTAL - SHOWN_PIECES) / PIECES_TOTAL) * 100, 2),
    })
    // Shown plus others is the whole period, to the rounding of a percentage.
    const shown = overview.pareto.reduce((n, p) => n + p.sharePct, 0)
    expect(shown + overview.paretoOthers!.sharePct).toBeCloseTo(100, 1)
  })

  it('reports how many rows exist behind each capped list', () => {
    expect(overview.counts.defectTypes).toBe(TYPES)
    expect(overview.counts.machines).toBe(1)
    expect(overview.counts.inspectors).toBe(1)
    expect(overview.counts.items).toBe(1)
    expect(overview.counts.holds).toBe(TYPES)
    expect(overview.counts.machines).toBe(overview.byMachine.length)
  })

  it('shows the oldest Holds and says how many are waiting in total', () => {
    expect(overview.holds.length).toBeLessThanOrEqual(50)
    expect(overview.counts.holds).toBe(TYPES)
    expect(overview.current.byDisposition.Hold).toBe(PIECES_TOTAL)
  })

  it('leaves a complete list unqualified', () => {
    // One machine, one item: nothing was cut, and the counts say so.
    expect(overview.counts.machines).toBe(overview.byMachine.length)
    expect(overview.counts.items).toBe(overview.byItem.length)
    expect(overview.counts.shifts).toBe(overview.byShift.length)
  })
})
