import { describe, expect, it } from 'vitest'
import { evaluationBudget, optimisePlan, score } from './optimise'
import { runPlan, type PlanInputs } from './engine'
import { parseWall } from './time'
import type { MachineCapacity, PlanLine, PlanMachine } from './types'

const SAT = '2026-10-24'
const at = (s: string) => parseWall(s)!
const cap = (machineKey: string, hoursPerDay = 10): MachineCapacity => ({ machineKey, hoursPerDay, efficiency: 1, worksFridays: false, source: 'set' })
const machine = (key: string, process: PlanMachine['process'] = 'forming'): PlanMachine => ({ key, code: key, name: `M${key}`, factory: 'F1', process, known: true })

let seq = 0
function line(over: Partial<PlanLine> = {}): PlanLine {
  seq++
  return {
    id: `id${seq}`,
    lineKey: `LK${seq}`,
    orderNumber: `O${seq}`,
    itemCode: `IC${seq}`,
    item: `Item ${seq}`,
    itemFamily: null,
    customer: 'C',
    machineKey: '1',
    requiredQty: 100,
    remainingQty: 100,
    weightKg: 1000,
    erpHours: 10,
    dueDate: null,
    plannedStart: null,
    plannedFinish: null,
    orderDate: null,
    erpStatus: 'Active',
    hold: false,
    parentId: null,
    modelGroupId: null,
    rawMaterialQty: null,
    rmReceivedQty: null,
    rmPromiseDate: null,
    runningSince: null,
    ...over,
  }
}

const inputs = (over: Partial<PlanInputs>): PlanInputs => ({
  now: at(`${SAT} 08:00`),
  lines: [],
  machines: [machine('1'), machine('2', 'welding')],
  capacities: [cap('1'), cap('2')],
  rates: [],
  calendar: [],
  ...over,
})

describe('§25 the optimiser', () => {
  // By planned start a goes first and b (due today, 10 h) finishes tomorrow: late. b first makes both on time.
  const a = line({ lineKey: 'A', plannedStart: '2026-10-01', dueDate: '2026-10-26', erpHours: 10 })
  const b = line({ lineKey: 'B', plannedStart: '2026-10-02', dueDate: '2026-10-24', erpHours: 10 })

  it('keeps a move that makes the objective smaller, says what the priority order gave, and never does worse', () => {
    const plain = runPlan(inputs({ lines: [a, b] }))
    expect(plain.summary.late).toBe(1)
    const r = optimisePlan(inputs({ lines: [a, b] }))
    expect(r.summary.late).toBe(0)
    expect(r.optimisation).toMatchObject({ objective: 'late-weight-days', effort: 'light', improved: true, moves: 1, baseline: { late: 1 }, baselineScore: 1, score: 0 })
    expect(r.operations.find((o) => o.lineKey === 'B')!.seq).toBe(1)
    expect(r.optimisation!.evaluations).toBeGreaterThan(0)
  })

  it('is the priority order when turned off, and the same plan every time', () => {
    const off = optimisePlan(inputs({ lines: [a, b], settings: { optimise: 'off' } }))
    expect(off.optimisation).toMatchObject({ effort: 'off', evaluations: 0, improved: false, baselineScore: 1, score: 1 })
    expect(off.summary.late).toBe(1)
    const x = optimisePlan(inputs({ lines: [a, b] }))
    const y = optimisePlan(inputs({ lines: [a, b] }))
    expect(y.operations).toEqual(x.operations)
  })

  it('never passes the line running now or a rushed one, and keeps a stage behind the one it waits for', () => {
    const running = line({ lineKey: 'R', runningSince: at(`${SAT} 07:00`), erpHours: 10, dueDate: '2026-10-30' })
    const late = line({ lineKey: 'L', plannedStart: '2026-10-02', dueDate: '2026-10-24', erpHours: 2 })
    const r = optimisePlan(inputs({ lines: [running, late] }))
    expect(r.operations.find((o) => o.lineKey === 'R')!.seq).toBe(1)
    const forming = line({ orderNumber: 'X', itemCode: 'B', machineKey: '1', erpHours: 10, dueDate: '2026-10-24' })
    const welding = line({ orderNumber: 'X', itemCode: 'B', machineKey: '2', erpHours: 10, dueDate: '2026-10-24' })
    const other = line({ orderNumber: 'Y', machineKey: '2', erpHours: 2, plannedStart: '2026-01-01', dueDate: '2026-11-30' })
    const s = optimisePlan(inputs({ lines: [forming, welding, other], settings: { overlapPct: 0, finishLagMinutes: 0 } }))
    const w = s.operations.find((o) => o.lineKey === welding.lineKey)!
    const f = s.operations.find((o) => o.lineKey === forming.lineKey)!
    expect(w.start!).toBeGreaterThanOrEqual(f.end!)
  })

  it('starts from another plan’s order when told to, so a scenario differs from its base by its changes alone', () => {
    const base = optimisePlan(inputs({ lines: [a, b] }))
    // The same lines with a change that touches neither: the search starts where the base ended and keeps its order.
    const scenario = optimisePlan(inputs({ lines: [a, b], events: [{ id: 'x', type: 'working-day', day: '2026-11-20', working: true }] }), { startFrom: base.order })
    expect(scenario.operations.map((o) => [o.lineKey, o.seq])).toEqual(base.operations.map((o) => [o.lineKey, o.seq]))
    // A line the start does not know (an order the scenario adds) comes after the ones it does.
    const added = optimisePlan(inputs({ lines: [a, b], events: [{ id: 'n', type: 'add-order', orderNumber: 'NEW', item: 'Frame', customer: 'Z', machineKey: '1', qty: 10, hours: 1, dueDate: '2026-12-31' }] }), { startFrom: base.order })
    expect(added.operations.find((o) => o.lineKey === 'NEW-n')!.seq).toBe(3)
  })

  it('tries an unplaced line too, in the objective’s order', () => {
    // Machine 1 has 10 h a day for 7 days of horizon: 8 lines of 10 h do not all fit; the last, a heavy one, is unplaced.
    const lines = Array.from({ length: 8 }, (_, i) => line({ lineKey: `U${i}`, plannedStart: `2026-10-0${i + 1}`, erpHours: 10, weightKg: i === 7 ? 50_000 : 100, dueDate: '2026-12-31' }))
    const r = optimisePlan(inputs({ lines, settings: { horizonDays: 7, optimise: 'full' } }))
    expect(r.optimisation!.baseline.unplaced).toBeGreaterThan(0)
    expect(r.operations.find((o) => o.lineKey === 'U7')!.end).not.toBeNull()
  })

  it('scores by the objective asked for', () => {
    const r = runPlan(inputs({ lines: [a, b] }))
    expect(score(r, 'late-weight-days')).toEqual([0, 0, 1, 1, 1])
    expect(score(r, 'late-lines')).toEqual([0, 0, 1, 1, 1])
    expect(score(r, 'late-days')[2]).toBe(1)
    expect(score(r, 'order-complete')).toEqual([0, 0, 1, 1, 1])
    expect(r.summary).toMatchObject({ orders: 2, lateOrders: 1 })
  })

  it('delivers an order whole: its lateness is its last line’s, weighed by the whole order, and its lines move together', () => {
    // Order X: two lines, one on each machine, 10 t and 1 t, due today; order Y: a light line ahead of each, due in a week.
    // One line of X moved alone gains nothing (the other still finishes late); both moved, X is on time and only Y's 2 t is late.
    const x1 = line({ orderNumber: 'X', lineKey: 'X1', machineKey: '1', plannedStart: '2026-10-05', dueDate: '2026-10-24', erpHours: 6, weightKg: 10_000 })
    const x2 = line({ orderNumber: 'X', lineKey: 'X2', machineKey: '2', plannedStart: '2026-10-05', dueDate: '2026-10-24', erpHours: 6, weightKg: 1_000 })
    const y1 = line({ orderNumber: 'Y', lineKey: 'Y1', machineKey: '1', plannedStart: '2026-10-01', dueDate: '2026-10-24', erpHours: 6, weightKg: 1_000 })
    const y2 = line({ orderNumber: 'Y', lineKey: 'Y2', machineKey: '2', plannedStart: '2026-10-01', dueDate: '2026-10-24', erpHours: 6, weightKg: 1_000 })
    const plain = runPlan(inputs({ lines: [x1, x2, y1, y2], settings: { dependencies: { sameItem: false, parent: false, orderProcess: false } } }))
    expect(plain.summary).toMatchObject({ late: 2, lateOrders: 1 })
    expect(score(plain, 'order-complete')[2]).toBe(11)
    const r = optimisePlan(inputs({ lines: [x1, x2, y1, y2], settings: { objective: 'order-complete', optimise: 'full', dependencies: { sameItem: false, parent: false, orderProcess: false } } }))
    expect(r.optimisation).toMatchObject({ objective: 'order-complete', improved: true, baselineScore: 11, score: 2 })
    expect(r.operations.filter((o) => o.orderNumber === 'X').every((o) => o.lateDays === 0)).toBe(true)
    expect(r.summary.lateOrders).toBe(1)
  })

  it('spends a budget that shrinks with the record, and stays under a few seconds at a factory’s size', () => {
    expect(evaluationBudget('off', 100)).toBe(0)
    expect(evaluationBudget('light', 400)).toBe(30)
    expect(evaluationBudget('light', 6000)).toBe(2)
    expect(evaluationBudget('full', 6000)).toBe(16)
    const lines: PlanLine[] = []
    for (let o = 0; o < 2000; o++) {
      for (let s = 0; s < 3; s++) lines.push(line({ orderNumber: `ORD${o}`, itemCode: `ITEM${o % 400}`, machineKey: String((o % 20) * 3 + s + 1), erpHours: 2 + (o % 7), plannedStart: `2026-${String(1 + (o % 12)).padStart(2, '0')}-01`, dueDate: '2026-11-15' }))
    }
    const machines = Array.from({ length: 60 }, (_, i) => machine(String(i + 1)))
    const started = Date.now()
    const r = optimisePlan(inputs({ lines, machines, capacities: machines.map((m) => cap(m.key, 16)) }))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.optimisation!.evaluations).toBeLessThanOrEqual(2)
  })
})
