// ============================================================================
// §25 — balancing the machines: where a machine is loaded past its hours in
// the coming weeks and another machine that makes the same process of the
// same item (by the item's learnt route) has room, move lines one by one,
// work the plan out again each time, and keep a move when the objective
// gets smaller — and say what the moves are, for the planner to keep as a
// scenario or not. Nothing is kept here.
// ============================================================================

import { better, buildCalendars, machineLoad, score, weeklyLoad, type BalanceMove, type BalanceResponse, type PlanEvent, type PlanOperation, type PlanResult } from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { appendEvents } from './events'
import { maintenanceStops } from './data'
import { planBasis, workOut, type Planner } from './plans'

/** Moves tried at most, and the loaded share a machine must reach to be moved from, or stay under to be moved to. */
const DEFAULT_MAX_MOVES = 12
const OVER_PCT = 100
const ROOM_PCT = 85
const DEFAULT_WEEKS = 4

export async function balance(db: Db, config: Config, _planner: Planner, req: { basePlan?: 'auto' | 'published' | string; weeks?: number; maxMoves?: number }, now = new Date()): Promise<BalanceResponse> {
  const tz = config.FACTORY_TIMEZONE
  const basis = await planBasis(db, req.basePlan ?? 'published')
  const weeks = req.weeks ?? DEFAULT_WEEKS
  const maxMoves = req.maxMoves ?? DEFAULT_MAX_MOVES
  const { base, settings, result: before } = await workOut(db, config, basis.events, basis.settings, now)
  const names = new Map(base.machines.map((m) => [m.key, m.name]))
  const nameOf = (k: string) => names.get(k) ?? `Machine ${k}`
  const processOf = new Map(base.machines.map((m) => [m.key, m.process]))
  const routes = new Map(base.routes.map((r) => [r.itemCode.toLowerCase(), r]))
  const today = calendarDay(now, tz)
  const calendars = buildCalendars(base.machines.map((m) => m.key), base.capacities, base.calendar, settings, [...basis.events, ...maintenanceStops(base, now, tz, settings)])

  /** Each machine's load over the weeks: planned hours against its working hours, the weeks added up (the share unrounded, so a short line's move still counts). */
  type Loads = ReturnType<typeof machineLoad>
  const loads = (r: PlanResult): Loads => machineLoad(r.operations, calendars, today, weeks)
  const pctOf = (l: Loads, k: string) => l.get(k)?.pct ?? 0
  const plannedOf = (l: Loads, k: string) => l.get(k)?.plannedHours ?? 0
  const overloadedOf = (l: Loads) =>
    [...l.entries()]
      .filter(([, x]) => x.pct > OVER_PCT)
      .map(([machineKey, x]) => ({ machineKey, machineName: nameOf(machineKey), loadPct: Number.isFinite(x.pct) ? Math.round(x.pct) : 999 }))
      .sort((a, b) => b.loadPct - a.loadPct)
  const loadBefore = loads(before)
  const overloaded = overloadedOf(loadBefore)
  const weekList = [...new Set(weeklyLoad(before.operations, calendars, today, weeks).map((w) => w.week))].sort()
  const warnings: string[] = []
  if (overloaded.length === 0) {
    return { baseName: basis.name, now: before.now, weeks: weekList, overloaded, moves: [], events: [], before: before.summary, after: before.summary, stillOverloaded: [], warnings: ['No machine is loaded past its hours in these weeks.'] }
  }

  // The lines worth moving: on an overloaded machine, not running, not rushed, with another machine of their process on the item's route that has room.
  const fixed = (op: PlanOperation) => op.flags.includes('running') || op.flags.includes('rushed') || op.flags.includes('hypothetical')
  const alternatives = (op: PlanOperation, load: Loads): string[] => {
    const route = routes.get(op.itemCode.toLowerCase())
    const process = processOf.get(op.machineKey) ?? null
    if (!route || !process) return []
    const step = route.steps.find((s) => s.process === process)
    if (!step) return []
    return step.machines
      .map((m) => m.machineKey)
      .filter((k) => k !== op.machineKey && pctOf(load, k) < ROOM_PCT && processOf.get(k) === process)
      .sort((a, b) => pctOf(load, a) - pctOf(load, b))
  }

  let best = before
  let bestScore = score(before, settings.objective)
  let events: PlanEvent[] = []
  const moves: BalanceMove[] = []
  let load = loadBefore
  const tried = new Set<string>()
  for (let round = 0; round < maxMoves; round++) {
    const over = overloadedOf(load)
    if (over.length === 0) break
    // The heaviest machine's lines, the longest first: the one that unloads it most.
    const candidates = best.operations
      .filter((op) => over.some((o) => o.machineKey === op.machineKey) && !fixed(op) && !tried.has(op.lineId) && op.end !== null)
      .sort((a, b) => pctOf(load, b.machineKey) - pctOf(load, a.machineKey) || b.hours - a.hours)
    let accepted = false
    for (const op of candidates) {
      tried.add(op.lineId)
      const to = alternatives(op, load)[0]
      if (!to) continue
      const move: PlanEvent = { id: `bal-${op.lineKey}`, type: 'move', lineKey: op.lineKey, toMachineKey: to, note: `From ${nameOf(op.machineKey)}, loaded ${Math.round(pctOf(load, op.machineKey))}%` }
      const trial = await workOut(db, config, appendEvents(basis.events, [...events, move]), basis.settings, now, before.order)
      const s = score(trial.result, settings.objective)
      const l = loads(trial.result)
      // Kept when the objective does not worsen and the machine it leaves has fewer hours on it.
      if (!better(bestScore, s) && plannedOf(l, op.machineKey) < plannedOf(load, op.machineKey)) {
        best = trial.result
        bestScore = s
        events = [...events, move]
        load = l
        moves.push({ lineKey: op.lineKey, orderNumber: op.orderNumber, item: op.item, customer: op.customer, fromMachineKey: op.machineKey, toMachineKey: to, hours: op.hours })
        accepted = true
        break
      }
    }
    if (!accepted) break
  }
  if (moves.length === 0) warnings.push('No line could be moved: the overloaded machines’ items have no other machine of their process with room, by their learnt routes.')
  return {
    baseName: basis.name,
    now: before.now,
    weeks: weekList,
    overloaded,
    moves,
    events,
    before: before.summary,
    after: best.summary,
    stillOverloaded: overloadedOf(load),
    warnings,
  }
}
