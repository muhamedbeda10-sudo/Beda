// ============================================================================
// §25 — when a machine can work. A factory day runs from 08:00; a machine
// works its hours a day from then, on every day but Friday and the holidays
// in the calendar — unless the calendar names a Friday worked, or the machine
// works Fridays as a rule. A scenario changes it with events: a machine down
// between two times, other hours a day for some days, a day worked or not.
// ============================================================================

import type { CalendarException, MachineCapacity, PlanEvent } from './types'
import { FRIDAY, MINUTES_PER_DAY, dayNumber, dayStartWall, factoryDayOfWall, parseWall, weekday } from './time'

/** An interval of wall minutes, start included, end not. */
export type Window = readonly [number, number]

/** Hours a day are at most a whole day. */
const clampHours = (h: number) => Math.max(0, Math.min(24, Number.isFinite(h) ? h : 0))

export class MachineCalendar {
  private readonly cache = new Map<number, Window[]>()
  private readonly down: Window[]
  private readonly capacityEvents: { from: number; to: number; hours: number }[]
  private readonly dayEvents = new Map<number, boolean>()

  constructor(
    readonly machineKey: string,
    readonly capacity: MachineCapacity,
    private readonly exceptions: ReadonlyMap<string, CalendarException>,
    events: readonly PlanEvent[] = [],
  ) {
    const down: Window[] = []
    const caps: { from: number; to: number; hours: number }[] = []
    for (const e of events) {
      if (e.type === 'machine-down' && e.machineKey === machineKey) {
        const from = parseWall(e.from)
        const to = parseWall(e.to)
        if (from !== null && to !== null && to > from) down.push([from, to])
      } else if (e.type === 'capacity' && e.machineKey === machineKey) {
        caps.push({ from: dayNumber(e.fromDay), to: dayNumber(e.toDay), hours: clampHours(e.hoursPerDay) })
      } else if (e.type === 'working-day' && (e.machineKey === undefined || e.machineKey === '' || e.machineKey === machineKey)) {
        // A machine's own event wins over the factory's for that machine.
        const n = dayNumber(e.day)
        if (e.machineKey || !this.dayEvents.has(n)) this.dayEvents.set(n, e.working)
      }
    }
    this.down = down.sort((a, b) => a[0] - b[0])
    this.capacityEvents = caps
  }

  /** The day works at all, before hours and breakdowns. */
  isWorkingDay(day: string): boolean {
    const n = dayNumber(day)
    const byEvent = this.dayEvents.get(n)
    if (byEvent !== undefined) return byEvent
    const exception = this.exceptions.get(day)
    if (exception) return exception.working
    return weekday(day) !== FRIDAY || this.capacity.worksFridays
  }

  /** Hours of work the machine has on a day (0 on a day off). */
  hoursOn(day: string): number {
    if (!this.isWorkingDay(day)) return 0
    const n = dayNumber(day)
    // The last event naming the day wins.
    for (let i = this.capacityEvents.length - 1; i >= 0; i--) {
      const c = this.capacityEvents[i]
      if (n >= c.from && n <= c.to) return c.hours
    }
    return clampHours(this.capacity.hoursPerDay)
  }

  /** The machine's working time on a factory day: from 08:00 for its hours, less the times it is down. */
  windowsOn(dayNo: number): Window[] {
    const hit = this.cache.get(dayNo)
    if (hit) return hit
    const day = new Date(dayNo * 86_400_000).toISOString().slice(0, 10)
    const hours = this.hoursOn(day)
    let windows: Window[] = []
    if (hours > 0) {
      const start = dayStartWall(day)
      windows = [[start, start + Math.round(hours * 60)]]
      for (const d of this.down) {
        if (d[1] <= start || d[0] >= start + MINUTES_PER_DAY) continue
        windows = windows.flatMap(([s, e]): Window[] => {
          if (d[1] <= s || d[0] >= e) return [[s, e]]
          const parts: Window[] = []
          if (d[0] > s) parts.push([s, d[0]])
          if (d[1] < e) parts.push([d[1], e])
          return parts
        })
      }
    }
    this.cache.set(dayNo, windows)
    return windows
  }

  /**
   * Where `minutes` of work starting no earlier than `from` begins and ends,
   * running through the machine's working time and pausing outside it. Null
   * when the work does not fit before `limit` (wall minutes).
   */
  place(from: number, minutes: number, limit: number): { start: number; end: number } | null {
    let need = Math.max(0, Math.round(minutes))
    // A factory day begins at 08:00: the one `from` falls in may still have time.
    let dayNo = dayNumber(factoryDayOfWall(from))
    let start: number | null = null
    while (true) {
      const dayStart = dayNo * MINUTES_PER_DAY
      if (dayStart > limit) return null
      for (const [s, e] of this.windowsOn(dayNo)) {
        if (e <= from) continue
        const begin = Math.max(s, from)
        if (start === null) start = begin
        if (need === 0) return { start, end: begin }
        const take = e - begin
        if (take >= need) return { start, end: begin + need }
        need -= take
      }
      dayNo++
    }
  }

  /** Working minutes the machine has between two wall minutes. */
  workingMinutes(from: number, to: number): number {
    if (to <= from) return 0
    let total = 0
    for (let dayNo = dayNumber(factoryDayOfWall(from)); dayNo * MINUTES_PER_DAY < to; dayNo++) {
      for (const [s, e] of this.windowsOn(dayNo)) total += Math.max(0, Math.min(e, to) - Math.max(s, from))
    }
    return total
  }
}
