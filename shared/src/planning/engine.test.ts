import { describe, expect, it } from 'vitest'
import { MachineCalendar } from './calendar'
import { buildCalendars, lineHours, resolveSettings, runPlan, RateBook, type PlanInputs } from './engine'
import { comparePlans, dailyPlan, weeklyLoad } from './analysis'
import { formatWall, parseWall, wallOfInstant, instantOfWall, weekStart, factoryDayOfWall } from './time'
import type { MachineCapacity, PlanLine, PlanMachine } from './types'

// 2026-10-24 is a Saturday, 2026-10-30 a Friday.
const SAT = '2026-10-24'
const at = (s: string) => parseWall(s)!
const cap = (machineKey: string, hoursPerDay = 10, extra: Partial<MachineCapacity> = {}): MachineCapacity => ({ machineKey, hoursPerDay, efficiency: 1, worksFridays: false, source: 'set', ...extra })
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
    weightKg: null,
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
  machines: [machine('1'), machine('2', 'welding'), machine('3', 'paint')],
  capacities: [cap('1'), cap('2'), cap('3')],
  rates: [],
  calendar: [],
  ...over,
})

const op = (r: ReturnType<typeof runPlan>, lineKey: string) => r.operations.find((o) => o.lineKey === lineKey)!
const wall = (n: number | null) => (n === null ? null : formatWall(n))

describe('§25 the factory clock', () => {
  it('reads and writes wall minutes, and goes to and from instants in the factory zone', () => {
    expect(formatWall(at('2026-10-24 08:30'))).toBe('2026-10-24 08:30')
    expect(parseWall('2026-02-30 08:00')).toBeNull()
    const w = wallOfInstant('2026-10-24T05:30:00Z', 'Africa/Cairo')
    expect(formatWall(w)).toBe('2026-10-24 08:30')
    expect(instantOfWall(w, 'Africa/Cairo').toISOString()).toBe('2026-10-24T05:30:00.000Z')
    expect(factoryDayOfWall(at('2026-10-25 07:59'))).toBe('2026-10-24')
    expect(weekStart('2026-10-30')).toBe('2026-10-24')
    expect(weekStart('2026-10-24')).toBe('2026-10-24')
  })
})

describe('§25 a machine’s calendar', () => {
  it('works its hours from 08:00, not on Fridays or holidays, and on a Friday the calendar names', () => {
    const cal = new MachineCalendar('1', cap('1', 10), new Map([['2026-10-25', { day: '2026-10-25', working: false, name: 'Holiday' }]]))
    expect(cal.hoursOn(SAT)).toBe(10)
    expect(cal.hoursOn('2026-10-25')).toBe(0)
    expect(cal.hoursOn('2026-10-30')).toBe(0)
    const worked = new MachineCalendar('1', cap('1', 10), new Map([['2026-10-30', { day: '2026-10-30', working: true, name: 'Friday worked' }]]))
    expect(worked.hoursOn('2026-10-30')).toBe(10)
    expect(new MachineCalendar('1', cap('1', 10, { worksFridays: true }), new Map()).hoursOn('2026-10-30')).toBe(10)
    // 12 hours from Saturday 08:00: 10 on Saturday, the holiday skipped, 2 on Monday.
    expect(wall(cal.place(at(`${SAT} 08:00`), 12 * 60, at('2027-01-01 00:00'))!.end)).toBe('2026-10-26 10:00')
  })

  it('takes a machine down between two times and changes its hours a day for some days', () => {
    const cal = new MachineCalendar('1', cap('1', 10), new Map(), [
      { id: 'd', type: 'machine-down', machineKey: '1', from: `${SAT} 10:00`, to: `${SAT} 12:00` },
      { id: 'c', type: 'capacity', machineKey: '1', fromDay: '2026-10-25', toDay: '2026-10-25', hoursPerDay: 20 },
      { id: 'o', type: 'capacity', machineKey: '2', fromDay: '2026-10-25', toDay: '2026-10-25', hoursPerDay: 1 },
    ])
    expect(cal.windowsOn(Math.floor(at(`${SAT} 00:00`) / 1440)).map(([s, e]) => [wall(s), wall(e)])).toEqual([
      ['2026-10-24 08:00', '2026-10-24 10:00'],
      ['2026-10-24 12:00', '2026-10-24 18:00'],
    ])
    expect(cal.hoursOn('2026-10-25')).toBe(20)
    expect(cal.workingMinutes(at(`${SAT} 08:00`), at('2026-10-26 08:00'))).toBe(8 * 60 + 20 * 60)
  })

  it('places nothing on a machine that never works', () => {
    const cal = new MachineCalendar('1', cap('1', 0), new Map())
    expect(cal.place(at(`${SAT} 08:00`), 60, at('2027-01-01 00:00'))).toBeNull()
  })
})

describe('§25 a line’s hours', () => {
  const book = (rates: ConstructorParameters<typeof RateBook>[0] = []) => new RateBook(rates)
  it('reads the ERP’s duration for what is left, or one piece’s, with the machine’s efficiency when asked', () => {
    const l = line({ requiredQty: 100, remainingQty: 50, erpHours: 10 })
    expect(lineHours(l, cap('1'), book(), resolveSettings({}))).toEqual({ hours: 5, source: 'erp' })
    expect(lineHours(l, cap('1'), book(), resolveSettings({ erpDurationMeaning: 'piece' })).hours).toBe(500)
    expect(lineHours(l, cap('1', 10, { efficiency: 0.5 }), book(), resolveSettings({ applyEfficiency: true })).hours).toBe(10)
  })

  it('goes by the record first when asked, a set rate before everything, and the default with nothing to go by', () => {
    const l = line({ remainingQty: 60, itemCode: 'X', itemFamily: 'XL' })
    const learnt = [
      { machineKey: '1', itemCode: 'x', itemFamily: '', piecesPerHour: 30, samples: 4, source: 'inferred' as const },
      { machineKey: '1', itemCode: '', itemFamily: '', piecesPerHour: 10, samples: 9, source: 'inferred' as const },
    ]
    expect(lineHours(l, cap('1'), book(learnt), resolveSettings({ timeSource: 'actual-first' }))).toEqual({ hours: 2, source: 'rate-item' })
    expect(lineHours(line({ remainingQty: 60, itemCode: 'other' }), cap('1'), book(learnt), resolveSettings({ timeSource: 'actual-first' }))).toEqual({ hours: 6, source: 'rate-machine' })
    const set = [...learnt, { machineKey: '1', itemCode: '', itemFamily: 'xl', piecesPerHour: 60, samples: 0, source: 'set' as const }]
    expect(lineHours(l, cap('1'), book(set), resolveSettings({}))).toEqual({ hours: 1, source: 'set-rate' })
    expect(lineHours(line({ erpHours: null }), cap('1'), book(), resolveSettings({ defaultLineHours: 7 }))).toEqual({ hours: 7, source: 'assumed' })
  })
})

describe('§25 the plan', () => {
  it('runs a machine’s lines one after another by the ERP’s planned start, and says which are late', () => {
    const a = line({ plannedStart: '2026-10-26', erpHours: 10, dueDate: '2026-10-24' })
    const b = line({ plannedStart: '2026-10-20', erpHours: 10, dueDate: '2026-10-25' })
    const r = runPlan(inputs({ lines: [a, b] }))
    expect(wall(op(r, b.lineKey).start)).toBe('2026-10-24 08:00')
    expect(wall(op(r, b.lineKey).end)).toBe('2026-10-24 18:00')
    expect(op(r, b.lineKey).seq).toBe(1)
    expect(wall(op(r, a.lineKey).start)).toBe('2026-10-25 08:00')
    expect(op(r, a.lineKey).lateDays).toBe(1)
    expect(op(r, b.lineKey).lateDays).toBe(0)
    expect(r.summary).toMatchObject({ lines: 2, placed: 2, late: 1, onTimePct: 50, hours: 20 })
    // By due day instead, a goes first.
    const byDue = runPlan(inputs({ lines: [a, b], settings: { sequenceRule: 'due' } }))
    expect(op(byDue, a.lineKey).seq).toBe(1)
  })

  it('puts the line running now first, from now, whatever its planned start', () => {
    const a = line({ plannedStart: '2026-01-01' })
    const running = line({ plannedStart: '2027-01-01', runningSince: at(`${SAT} 07:00`), erpHours: 2 })
    const r = runPlan(inputs({ lines: [a, running], now: at(`${SAT} 09:00`) }))
    expect(op(r, running.lineKey)).toMatchObject({ seq: 1, flags: ['running'] })
    expect(wall(op(r, running.lineKey).start)).toBe('2026-10-24 09:00')
    expect(wall(op(r, a.lineKey).start)).toBe('2026-10-24 11:00')
  })

  it('leaves out lines that are done, cancelled, held, the STOCK line and lines with no machine', () => {
    const r = runPlan(
      inputs({
        lines: [
          line({ lineKey: 'done', remainingQty: 0 }),
          line({ lineKey: 'cancel', erpStatus: 'Cancelled' }),
          line({ lineKey: 'arabic', erpStatus: 'ملغي' }),
          line({ lineKey: 'hold', erpStatus: 'Hold' }),
          line({ lineKey: 'stock', orderNumber: 'STOCK' }),
          line({ lineKey: 'none', machineKey: '' }),
          line({ lineKey: 'ok' }),
        ],
      }),
    )
    expect(r.operations.map((o) => o.lineKey)).toEqual(['ok'])
    expect(Object.fromEntries(r.excluded.map((e) => [e.lineKey, e.reason]))).toEqual({ done: 'done', cancel: 'cancelled', arabic: 'cancelled', hold: 'hold', stock: 'stock', none: 'no-machine' })
    expect(runPlan(inputs({ lines: [line({ lineKey: 'hold', erpStatus: 'Hold' })], settings: { includeHold: true } })).operations).toHaveLength(1)
  })

  it('leaves out a line whose due day is older than the settings allow, never the line running now, and nothing when the setting is off', () => {
    const lines = [
      line({ lineKey: 'old', dueDate: '2026-07-01' }),
      line({ lineKey: 'edge', dueDate: '2026-09-24' }),
      line({ lineKey: 'recent', dueDate: '2026-10-01' }),
      line({ lineKey: 'nodue', dueDate: null }),
      line({ lineKey: 'running', dueDate: '2026-01-01', runningSince: at(`${SAT} 07:00`) }),
      line({ lineKey: 'rushed', dueDate: '2026-01-01' }),
    ]
    const events = [{ id: 'r', type: 'priority' as const, lineKey: 'rushed' }]
    const r = runPlan(inputs({ lines, events, settings: { ignoreDueOlderThanDays: 30 } }))
    expect(r.operations.map((o) => o.lineKey).sort()).toEqual(['nodue', 'recent', 'running', 'rushed'])
    expect(r.excluded.map((e) => [e.lineKey, e.reason])).toEqual([
      ['old', 'stale'],
      ['edge', 'stale'],
    ])
    expect(runPlan(inputs({ lines, events })).excluded).toEqual([])
  })

  it('makes an item’s later process wait for its earlier one in the same order, overlapping as set', () => {
    const forming = line({ orderNumber: 'A', itemCode: 'BEAM', machineKey: '1', erpHours: 10 })
    const welding = line({ orderNumber: 'A', itemCode: 'BEAM', machineKey: '2', erpHours: 2 })
    const r = runPlan(inputs({ lines: [welding, forming] }))
    expect(op(r, welding.lineKey).dependsOn).toEqual([forming.lineKey])
    // Half of forming (5 h) done before welding starts; welding ends no sooner than forming's end + 60 min.
    expect(wall(op(r, welding.lineKey).start)).toBe('2026-10-24 17:00')
    expect(wall(op(r, welding.lineKey).end)).toBe('2026-10-25 09:00')
    const strict = runPlan(inputs({ lines: [welding, forming], settings: { overlapPct: 0, finishLagMinutes: 0 } }))
    expect(wall(op(strict, welding.lineKey).start)).toBe('2026-10-25 08:00')
  })

  it('makes a line wait for the lines whose parent id it is, and goes ahead through a loop of parent ids', () => {
    const parent = line({ lineKey: 'P', machineKey: '2' })
    const child = line({ lineKey: 'C', parentId: 'p', machineKey: '1' })
    const r = runPlan(inputs({ lines: [parent, child], settings: { overlapPct: 0, finishLagMinutes: 0 } }))
    expect(op(r, 'P').dependsOn).toEqual(['C'])
    // The child ends Saturday 18:00, when the shift does: the parent starts with the next one.
    expect(wall(op(r, 'C').end)).toBe('2026-10-24 18:00')
    expect(wall(op(r, 'P').start)).toBe('2026-10-25 08:00')
    const loop = runPlan(inputs({ lines: [line({ lineKey: 'X', parentId: 'Y' }), line({ lineKey: 'Y', parentId: 'X', machineKey: '2' })] }))
    expect(loop.summary.placed).toBe(2)
    expect(loop.operations.some((o) => o.flags.includes('cycle'))).toBe(true)
  })

  it('uses a gap a waiting line left when the next line fits in it', () => {
    const forming = line({ orderNumber: 'A', itemCode: 'B', machineKey: '1', erpHours: 20, plannedStart: '2026-01-01' })
    const welding = line({ orderNumber: 'A', itemCode: 'B', machineKey: '2', erpHours: 2, plannedStart: '2026-01-02' })
    const small = line({ machineKey: '2', erpHours: 3, plannedStart: '2026-06-01' })
    const r = runPlan(inputs({ lines: [forming, welding, small], settings: { overlapPct: 0, finishLagMinutes: 0 } }))
    // Welding waits for forming (two days); the small line fills the welder's Saturday before it.
    expect(wall(op(r, small.lineKey).start)).toBe('2026-10-24 08:00')
    expect(wall(op(r, welding.lineKey).start)).toBe('2026-10-26 08:00')
  })

  it('waits for raw material promised later, unless it was received or the gate is off', () => {
    const waiting = line({ rmPromiseDate: '2026-10-27', rawMaterialQty: 10, rmReceivedQty: 0 })
    const received = line({ machineKey: '2', rmPromiseDate: '2026-10-27', rawMaterialQty: 10, rmReceivedQty: 10 })
    const r = runPlan(inputs({ lines: [waiting, received] }))
    expect(wall(op(r, waiting.lineKey).start)).toBe('2026-10-27 08:00')
    expect(op(r, waiting.lineKey).flags).toContain('waits-material')
    expect(wall(op(r, received.lineKey).start)).toBe('2026-10-24 08:00')
    expect(wall(op(runPlan(inputs({ lines: [waiting], settings: { materialGate: false } })), waiting.lineKey).start)).toBe('2026-10-24 08:00')
  })

  it('leaves a line unplaced on a machine with no working time in the horizon', () => {
    const r = runPlan(inputs({ lines: [line()], capacities: [cap('1', 0)] }))
    expect(r.summary).toMatchObject({ placed: 0, unplaced: 1 })
    expect(r.operations[0].flags).toContain('no-capacity')
  })
})

describe('§25 a scenario', () => {
  it('moves, leaves out, rushes, re-dates, re-sizes, delays and adds lines, and says what it could not find', () => {
    const a = line({ lineKey: 'A', plannedStart: '2026-01-01', erpHours: 10 })
    const b = line({ lineKey: 'B', plannedStart: '2026-01-02', erpHours: 10, customer: 'Big' })
    const c = line({ lineKey: 'C', plannedStart: '2026-01-03', erpHours: 10 })
    const r = runPlan(
      inputs({
        lines: [a, b, c],
        events: [
          { id: '1', type: 'priority', customer: 'big' },
          { id: '2', type: 'move', lineKey: 'C', toMachineKey: '2' },
          { id: '3', type: 'quantity', lineKey: 'A', remainingQty: 50 },
          { id: '4', type: 'due', lineKey: 'A', dueDate: '2026-10-24' },
          { id: '5', type: 'add-order', orderNumber: 'NEW1', item: 'Frame', customer: 'Z', machineKey: '1', qty: 10, hours: 4, dueDate: '2026-10-26' },
          { id: '6', type: 'exclude', lineKey: 'nope' },
          { id: '7', type: 'not-before', lineKey: 'C', at: '2026-10-25 09:00' },
        ],
      }),
    )
    expect(op(r, 'B')).toMatchObject({ seq: 1, flags: ['rushed'] })
    expect(op(r, 'A')).toMatchObject({ hours: 5, dueDate: '2026-10-24' })
    expect(op(r, 'C').machineKey).toBe('2')
    expect(wall(op(r, 'C').start)).toBe('2026-10-25 09:00')
    expect(op(r, 'NEW-5')).toMatchObject({ hours: 4, durationSource: 'event', flags: ['hypothetical'] })
    expect(r.warnings).toEqual(['Event exclude (6): no open line has the Order ID "nope".'])
  })

  it('shows a breakdown and a slower machine pushing its lines later, and the comparison says which', () => {
    const a = line({ lineKey: 'A', plannedStart: '2026-01-01', erpHours: 10, dueDate: '2026-10-24' })
    const b = line({ lineKey: 'B', plannedStart: '2026-01-02', erpHours: 10, dueDate: '2026-10-26' })
    const base = runPlan(inputs({ lines: [a, b] }))
    const scenario = runPlan(
      inputs({
        lines: [a, b],
        events: [
          { id: 'd', type: 'machine-down', machineKey: '1', from: `${SAT} 08:00`, to: '2026-10-26 08:00' },
          { id: 's', type: 'speed', machineKey: '1', speedPct: 50 },
        ],
      }),
    )
    expect(wall(op(scenario, 'A').start)).toBe('2026-10-26 08:00')
    expect(op(scenario, 'A').hours).toBe(20)
    const cmp = comparePlans(base, scenario)
    expect(cmp.newlyLate).toBe(2)
    expect(cmp.later).toBe(2)
    expect(cmp.changes.map((c) => c.lineKey).sort()).toEqual(['A', 'B'])
    expect(cmp.scenario.late).toBe(2)
  })

  it('reads the load of each machine week by week, and what it makes each day', () => {
    const a = line({ erpHours: 25 })
    const r = runPlan(inputs({ lines: [a] }))
    const calendars = buildCalendars(['1'], [cap('1')], [], resolveSettings({}))
    const load = weeklyLoad(r.operations, calendars, SAT, 2)
    expect(load[0]).toMatchObject({ machineKey: '1', week: SAT, plannedHours: 25, capacityHours: 60, loadPct: 42 })
    expect(load[1]).toMatchObject({ plannedHours: 0, capacityHours: 60 })
    const days = dailyPlan(r.operations, calendars, SAT, '2026-10-27')
    expect(days.map((d) => [d.day, d.hours, d.qty])).toEqual([
      [SAT, 10, 40],
      ['2026-10-25', 10, 40],
      ['2026-10-26', 5, 20],
    ])
  })
})

describe('§25 the plan at a factory’s size', () => {
  it('plans 6 000 lines on 60 machines, with their stages, within a second or two', () => {
    const machines = Array.from({ length: 60 }, (_, i) => machine(String(i + 1), i % 3 === 0 ? 'forming' : i % 3 === 1 ? 'welding' : 'paint'))
    const lines: PlanLine[] = []
    for (let o = 0; o < 2000; o++) {
      const base = (o % 20) * 3
      for (let s = 0; s < 3; s++) {
        lines.push(
          line({
            orderNumber: `ORD${o}`,
            itemCode: `ITEM${o % 400}`,
            machineKey: String(base + s + 1),
            erpHours: 2 + (o % 7),
            plannedStart: `2026-${String(1 + (o % 12)).padStart(2, '0')}-01`,
            dueDate: '2026-12-31',
          }),
        )
      }
    }
    const started = Date.now()
    const r = runPlan(inputs({ lines, machines, capacities: machines.map((m) => cap(m.key, 16)) }))
    const ms = Date.now() - started
    expect(r.summary.placed).toBe(6000)
    expect(ms).toBeLessThan(3000)
  })
})
