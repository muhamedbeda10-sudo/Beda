// ============================================================================
// §25 — reading a plan: each machine's load against what it can give, week
// by week; what a plan has each machine make on each day (to set beside what
// it made); and two plans side by side — a scenario against the plan it was
// made from — line by line.
// ============================================================================

import type { MachineCalendar } from './calendar'
import type { PlanOperation, PlanResult, PlanSummary } from './types'
import { DAY_START_MINUTE, MINUTES_PER_DAY, addDays, dayNumber, dayStartWall, weekStart } from './time'

export interface WeekLoad {
  machineKey: string
  /** The Saturday it begins. */
  week: string
  plannedHours: number
  capacityHours: number
  /** Planned ÷ capacity × 100; null for a week the machine does not work. */
  loadPct: number | null
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** Each machine's load over the weeks, the weeks added up: planned hours, the hours it has, and the share (unrounded; Infinity when planned with no hours). */
export function machineLoad(operations: readonly PlanOperation[], calendars: ReadonlyMap<string, MachineCalendar>, fromDay: string, weeks: number): Map<string, { plannedHours: number; capacityHours: number; pct: number }> {
  const out = new Map<string, { plannedHours: number; capacityHours: number; pct: number }>()
  for (const w of weeklyLoad(operations, calendars, fromDay, weeks)) {
    const a = out.get(w.machineKey) ?? { plannedHours: 0, capacityHours: 0, pct: 0 }
    a.plannedHours += w.plannedHours
    a.capacityHours += w.capacityHours
    out.set(w.machineKey, a)
  }
  for (const a of out.values()) a.pct = a.capacityHours > 0 ? (a.plannedHours / a.capacityHours) * 100 : a.plannedHours > 0 ? Infinity : 0
  return out
}

/** Each machine's planned hours and its working hours, for `weeks` weeks from the week of `fromDay`. */
export function weeklyLoad(operations: readonly PlanOperation[], calendars: ReadonlyMap<string, MachineCalendar>, fromDay: string, weeks: number): WeekLoad[] {
  const first = weekStart(fromDay)
  const starts = Array.from({ length: weeks }, (_, i) => addDays(first, i * 7))
  const byMachine = new Map<string, PlanOperation[]>()
  for (const op of operations) {
    if (op.start === null || op.end === null) continue
    const l = byMachine.get(op.machineKey)
    if (l) l.push(op)
    else byMachine.set(op.machineKey, [op])
  }
  const out: WeekLoad[] = []
  for (const [machineKey, cal] of calendars) {
    const ops = byMachine.get(machineKey) ?? []
    for (const w of starts) {
      const ws = dayStartWall(w)
      const we = ws + 7 * MINUTES_PER_DAY
      const capacity = cal.workingMinutes(ws, we)
      let planned = 0
      for (const op of ops) if (op.end! > ws && op.start! < we) planned += cal.workingMinutes(Math.max(ws, op.start!), Math.min(we, op.end!))
      if (capacity === 0 && planned === 0 && ops.length === 0) continue
      out.push({ machineKey, week: w, plannedHours: round1(planned / 60), capacityHours: round1(capacity / 60), loadPct: capacity > 0 ? Math.round((planned / capacity) * 100) : null })
    }
  }
  return out
}

export interface DayPlan {
  machineKey: string
  day: string
  /** Pieces the plan has the machine make that day: each line's quantity shared by its working minutes on the day. */
  qty: number
  hours: number
}

/** What the operations have each machine make on each factory day from `fromDay` to `toDay` (both included). */
export function dailyPlan(operations: readonly PlanOperation[], calendars: ReadonlyMap<string, MachineCalendar>, fromDay: string, toDay: string): DayPlan[] {
  const out = new Map<string, DayPlan>()
  const lo = dayStartWall(fromDay)
  const hi = dayStartWall(addDays(toDay, 1))
  for (const op of operations) {
    if (op.start === null || op.end === null || op.end <= lo || op.start >= hi) continue
    const cal = calendars.get(op.machineKey)
    if (!cal) continue
    const total = Math.max(1, cal.workingMinutes(op.start, op.end))
    for (let n = Math.max(dayNumber(fromDay), Math.floor((op.start - DAY_START_MINUTE) / MINUTES_PER_DAY)); n <= dayNumber(toDay); n++) {
      const ds = n * MINUTES_PER_DAY + DAY_START_MINUTE
      if (ds >= op.end) break
      const minutes = cal.workingMinutes(Math.max(ds, op.start), Math.min(ds + MINUTES_PER_DAY, op.end))
      if (minutes <= 0) continue
      const day = new Date(n * 86_400_000).toISOString().slice(0, 10)
      const key = `${op.machineKey}|${day}`
      const d = out.get(key) ?? { machineKey: op.machineKey, day, qty: 0, hours: 0 }
      d.qty += (op.qty * minutes) / total
      d.hours += minutes / 60
      out.set(key, d)
    }
  }
  return [...out.values()].map((d) => ({ ...d, qty: Math.round(d.qty * 10) / 10, hours: round1(d.hours) })).sort((a, b) => a.machineKey.localeCompare(b.machineKey) || a.day.localeCompare(b.day))
}

export interface LineChange {
  lineKey: string
  orderNumber: string
  item: string
  customer: string
  machineKey: string
  dueDate: string | null
  /** Wall minutes in each plan; null when not placed there (or not in it). */
  baseEnd: number | null
  scenarioEnd: number | null
  /** Days later (+) or sooner (−) it finishes in the scenario. */
  shiftDays: number | null
  baseLateDays: number
  scenarioLateDays: number
  /** In one of the two only. */
  only?: 'base' | 'scenario'
}

export interface PlanComparison {
  base: PlanSummary
  scenario: PlanSummary
  /** Lines late in the scenario that were on time. */
  newlyLate: number
  /** Lines on time in the scenario that were late. */
  recovered: number
  /** Lines finishing a day or more later / sooner. */
  later: number
  sooner: number
  /** The lines that changed most, by how far they moved. */
  changes: LineChange[]
}

/** A scenario against the plan it was made from: totals, then the lines that moved, most first. */
export function comparePlans(base: PlanResult, scenario: PlanResult, maxChanges = 200): PlanComparison {
  const key = (op: PlanOperation) => op.lineId
  const a = new Map(base.operations.map((o) => [key(o), o]))
  const b = new Map(scenario.operations.map((o) => [key(o), o]))
  const changes: LineChange[] = []
  let newlyLate = 0
  let recovered = 0
  let later = 0
  let sooner = 0
  const row = (o: PlanOperation, x: PlanOperation | undefined, y: PlanOperation | undefined): LineChange => {
    const baseEnd = x?.end ?? null
    const scenarioEnd = y?.end ?? null
    return {
      lineKey: o.lineKey,
      orderNumber: o.orderNumber,
      item: o.item,
      customer: o.customer,
      machineKey: (y ?? o).machineKey,
      dueDate: (y ?? o).dueDate,
      baseEnd,
      scenarioEnd,
      shiftDays: baseEnd !== null && scenarioEnd !== null ? Math.round(((scenarioEnd - baseEnd) / MINUTES_PER_DAY) * 10) / 10 : null,
      baseLateDays: x?.lateDays ?? 0,
      scenarioLateDays: y?.lateDays ?? 0,
      only: x && !y ? 'base' : !x && y ? 'scenario' : undefined,
    }
  }
  for (const [id, x] of a) {
    const y = b.get(id)
    const r = row(x, x, y)
    if (y) {
      if (r.baseLateDays === 0 && r.scenarioLateDays > 0) newlyLate++
      if (r.baseLateDays > 0 && r.scenarioLateDays === 0) recovered++
      if (r.shiftDays !== null && r.shiftDays >= 1) later++
      if (r.shiftDays !== null && r.shiftDays <= -1) sooner++
      const moved = x.machineKey !== y.machineKey || (r.shiftDays !== null && Math.abs(r.shiftDays) >= 0.05) || (x.end === null) !== (y.end === null) || r.baseLateDays !== r.scenarioLateDays
      if (moved) changes.push(r)
    } else changes.push(r)
  }
  for (const [id, y] of b) if (!a.has(id)) changes.push(row(y, undefined, y))
  const weight = (c: LineChange) => (c.only ? 1e9 : 0) + Math.abs(c.scenarioLateDays - c.baseLateDays) * 1000 + Math.abs(c.shiftDays ?? 1e6)
  changes.sort((x, y) => weight(y) - weight(x) || x.lineKey.localeCompare(y.lineKey))
  return { base: base.summary, scenario: scenario.summary, newlyLate, recovered, later, sooner, changes: changes.slice(0, maxChanges) }
}
