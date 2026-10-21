// ============================================================================
// §25 — changeovers and preventive maintenance: what the planners set for the
// engine to count besides the lines' own hours.
//
// A changeover rule says how long a machine (or every machine of a process,
// or every machine) stops between two item families; the most specific rule
// wins. A maintenance rule says a machine stops every so many days (or
// running hours, read as days of its own work) for so many hours; the engine
// gets those stops as machine-down events over the horizon.
// ============================================================================

import { MINUTES_PER_DAY, addDays, dayNumber, formatWall } from './time'
import type { PlanEvent, PlanningProcess } from './types'

/** How long a machine stops between two families; '' = any family, null = any machine / any process. */
export interface SetupTimeRule {
  id: string
  machineKey: string | null
  process: PlanningProcess | null
  fromFamily: string
  toFamily: string
  minutes: number
  note?: string
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

/**
 * The minutes a changeover takes on a machine from one family to another:
 * the most specific rule (the machine's over its process's over everyone's;
 * both families named over one over none). None, or the same family: 0.
 */
export function changeoverMinutes(rules: readonly SetupTimeRule[], machineKey: string, process: PlanningProcess | null, fromFamily: string, toFamily: string): number {
  const from = norm(fromFamily)
  const to = norm(toFamily)
  if (from === to) return 0
  let best: { score: number; minutes: number } | null = null
  for (const r of rules) {
    if (r.machineKey !== null && r.machineKey !== machineKey) continue
    if (r.machineKey === null && r.process !== null && r.process !== process) continue
    const rf = norm(r.fromFamily)
    const rt = norm(r.toFamily)
    if (rf !== '' && rf !== from) continue
    if (rt !== '' && rt !== to) continue
    const score = (r.machineKey !== null ? 8 : r.process !== null ? 4 : 0) + (rf !== '' ? 2 : 0) + (rt !== '' ? 1 : 0)
    if (!best || score > best.score || (score === best.score && r.minutes > best.minutes)) best = { score, minutes: r.minutes }
  }
  return best ? Math.max(0, best.minutes) : 0
}

/** A machine stops for `durationHours` every `everyDays` days (or every `everyRunHours` of its work), from `lastDone`. */
export interface MaintenanceRule {
  id: string
  machineKey: string
  name: string
  everyDays: number | null
  everyRunHours: number | null
  durationHours: number
  lastDone: string | null
  /** The time of day it starts, "HH:MM" on the factory clock; 08:00 when left out. */
  startTime?: string | null
}

/**
 * The stops a machine's maintenance rules make over the horizon, as
 * machine-down events (ids maint:<rule>:<n>): every so many days from the
 * last time (or from today when never done); one due before today is done
 * today. Running hours are read as days of the machine's own work.
 */
export function maintenanceEvents(rules: readonly MaintenanceRule[], today: string, horizonDays: number, hoursPerDay: (machineKey: string) => number): PlanEvent[] {
  const out: PlanEvent[] = []
  const end = addDays(today, Math.max(1, horizonDays))
  for (const r of rules) {
    const interval = r.everyDays !== null && r.everyDays > 0 ? r.everyDays : r.everyRunHours !== null && r.everyRunHours > 0 ? Math.max(1, Math.ceil(r.everyRunHours / Math.max(1, hoursPerDay(r.machineKey)))) : 0
    if (interval <= 0 || !(r.durationHours > 0)) continue
    const startMinute = (() => {
      const m = (r.startTime ?? '08:00').match(/^(\d{1,2}):(\d{2})$/)
      return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : 8 * 60
    })()
    let day = r.lastDone ? addDays(r.lastDone, interval) : addDays(today, interval)
    if (day < today) day = today
    for (let n = 0; day <= end && n < 400; n++, day = addDays(day, interval)) {
      // The stop starts at startMinute of the clock on that day (wall minutes count from the day's midnight).
      const from = dayNumber(day) * MINUTES_PER_DAY + startMinute
      const to = from + Math.round(r.durationHours * 60)
      out.push({ id: `maint:${r.id}:${n}`, type: 'machine-down', machineKey: r.machineKey, from: formatWall(from), to: formatWall(to), note: r.name })
    }
  }
  return out
}
