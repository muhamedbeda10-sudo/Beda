// ============================================================================
// §21 — when an automation runs next. A watch runs every few minutes, so it
// is due again that long after it last started — around the clock, or only
// within the hours of the factory day it was given (from one HH:MM to
// another, a stretch crossing midnight counting as the day it starts on) and
// on the days it was given: a time outside them waits for the next time
// they open. A scheduled report runs at a time of day where the factory sits
// (FACTORY_TIMEZONE): every day (or on chosen weekdays), on one weekday, or
// on a day of the month (1–28, so every month has it). The wall-clock time
// is turned into an instant through Intl, which knows the zone's
// daylight-saving rules:
//
//   • a time that happens twice (clocks going back) runs at its first
//     occurrence;
//   • a time that never happens (clocks going forward) runs as the clocks
//     jump, that much later — 02:30 on the change day becomes 03:30.
//
// Pure functions: the engine hands in the moment it means as "now", so the
// tests can stand on any day in any zone.
// ============================================================================

import type { AutomationScheduleSpec, AutomationWatchSpec, AutomationWeekday } from '@qc/shared/automation'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/**
 * A report whose time passed while the app was down (or its creator could
 * not run it) still runs, if it is less than this late; otherwise it is
 * skipped. Only its latest time counts: after a longer outage the run due
 * last runs late, and the ones before it are recorded as missed.
 */
export const MISSED_RUN_GRACE_MS = 6 * 60 * MINUTE_MS

/** One formatter per zone: building them is the slow part. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The wall-clock time at an instant in a zone, as if it were UTC (ms): its fields, readable with getUTC*. */
function wallClock(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(at))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

/** How far the zone is ahead of UTC at an instant, in ms (whole minutes; seconds of history's odd offsets dropped). */
function offsetAt(at: number, timeZone: string): number {
  const atSecond = Math.floor(at / 1000) * 1000
  return Math.round((wallClock(atSecond, timeZone) - atSecond) / MINUTE_MS) * MINUTE_MS
}

/**
 * The instant a wall-clock time (given as if it were UTC) happens in a zone.
 * Twice (clocks back): the first. Never (clocks forward): as the clocks jump,
 * the gap later.
 */
export function zonedInstant(wall: number, timeZone: string): Date {
  // The offsets on either side of any change near this time: one of them is the one in force.
  const before = offsetAt(wall - DAY_MS, timeZone)
  const after = offsetAt(wall + DAY_MS, timeZone)
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((t) => t + offsetAt(t, timeZone) === wall)
    .sort((a, b) => a - b)
  if (candidates.length > 0) return new Date(candidates[0])
  // In the gap: read with the offset before the change, it lands that much later on the clock.
  return new Date(wall - before)
}

/** The factory day at an instant: its date fields, as a UTC midnight (ms). */
function localDay(at: Date, timeZone: string): number {
  const wall = wallClock(at.getTime(), timeZone)
  return wall - (wall % DAY_MS)
}

/** Whether a report of this schedule runs on a day (a UTC midnight standing for the factory's date). */
export function runsOn(s: Pick<AutomationScheduleSpec, 'cadence' | 'weekdays' | 'weekday' | 'monthDay'>, day: number): boolean {
  const d = new Date(day)
  const weekday = d.getUTCDay() as AutomationWeekday
  switch (s.cadence) {
    case 'daily':
      return !s.weekdays || s.weekdays.length === 0 || s.weekdays.includes(weekday)
    case 'weekly':
      return weekday === (s.weekday ?? 0)
    case 'monthly':
      return d.getUTCDate() === (s.monthDay ?? 1)
  }
}

/**
 * The first time a report of this schedule runs strictly after `after`, in
 * factory time. A month-day schedule finds its day within a month; the search
 * goes a little further than a year for safety and never loops for ever.
 */
export function nextReportRun(
  s: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>,
  after: Date,
  timeZone: string,
): Date {
  const [hh, mm] = s.time.split(':').map(Number)
  const minutes = hh * 60 + mm
  // From the day before (a gap or a late-evening slot can fall on the factory's previous date).
  const first = localDay(after, timeZone) - DAY_MS
  for (let i = 0; i <= 400; i++) {
    const day = first + i * DAY_MS
    if (!runsOn(s, day)) continue
    const at = zonedInstant(day + minutes * MINUTE_MS, timeZone)
    if (at.getTime() > after.getTime()) return at
  }
  throw new Error(`No run found for the schedule ${JSON.stringify(s)} after ${after.toISOString()}`)
}

/**
 * The last time a report of this schedule was due at or before `at`, in
 * factory time: the run a late start stands for. Null when none was within
 * the search (a little over a year back).
 */
export function previousReportRun(
  s: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>,
  at: Date,
  timeZone: string,
): Date | null {
  const [hh, mm] = s.time.split(':').map(Number)
  const minutes = hh * 60 + mm
  // From the day after (as nextReportRun starts the day before), back.
  const last = localDay(at, timeZone) + DAY_MS
  for (let i = 0; i <= 400; i++) {
    const day = last - i * DAY_MS
    if (!runsOn(s, day)) continue
    const due = zonedInstant(day + minutes * MINUTE_MS, timeZone)
    if (due.getTime() <= at.getTime()) return due
  }
  return null
}

/** How many runs of this schedule fall due from `from` (included) until `until` (not included); at most `max`. */
export function reportRunsBetween(
  s: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>,
  from: Date,
  until: Date,
  timeZone: string,
  max = 1000,
): number {
  let n = 0
  for (let t = nextReportRun(s, new Date(from.getTime() - 1), timeZone); t.getTime() < until.getTime() && n < max; t = nextReportRun(s, t, timeZone)) n++
  return n
}

// ---- Watches ---------------------------------------------------------------------------

/** When a watch looks: how often, in which hours, on which days. */
export type WatchTiming = Pick<AutomationWatchSpec, 'everyMinutes' | 'hours' | 'weekdays'>

/** How long a watch's hours may be searched ahead for their next opening: a week of days it may run on, and a day either side. */
const WATCH_SEARCH_DAYS = 9

const minutesOf = (hhmm: string): number => {
  const [hh, mm] = hhmm.split(':').map(Number)
  return hh * 60 + mm
}

/** Whether a watch of this timing runs on a day (a UTC midnight standing for the factory's date). */
function watchRunsOn(w: WatchTiming, day: number): boolean {
  return !w.weekdays || w.weekdays.length === 0 || w.weekdays.includes(new Date(day).getUTCDay() as AutomationWeekday)
}

/**
 * Whether an instant falls within a watch's hours, on a day it runs. Hours
 * that cross midnight (22:00 to 06:00) belong to the day they start on: the
 * small hours of Monday are Sunday night's.
 */
export function inWatchHours(w: WatchTiming, at: Date, timeZone: string): boolean {
  if (!w.hours && !w.weekdays?.length) return true
  const wall = wallClock(at.getTime(), timeZone)
  const day = wall - (wall % DAY_MS)
  if (!w.hours) return watchRunsOn(w, day)
  const minute = Math.floor((wall - day) / MINUTE_MS)
  const from = minutesOf(w.hours.from)
  const to = minutesOf(w.hours.to)
  if (from < to) return watchRunsOn(w, day) && minute >= from && minute < to
  return (minute >= from && watchRunsOn(w, day)) || (minute < to && watchRunsOn(w, day - DAY_MS))
}

/**
 * The first moment at or after `at` a watch of this timing may run: `at`
 * itself within its hours on a day it runs, otherwise the next time its hours
 * open (midnight, when it has no hours and the day is not one it runs on).
 */
export function watchRunAt(w: WatchTiming, at: Date, timeZone: string): Date {
  if (inWatchHours(w, at, timeZone)) return at
  const open = w.hours ? minutesOf(w.hours.from) : 0
  // From the day before: hours crossing midnight may have opened on the factory's previous date.
  const first = localDay(at, timeZone) - DAY_MS
  for (let i = 0; i <= WATCH_SEARCH_DAYS; i++) {
    const day = first + i * DAY_MS
    if (!watchRunsOn(w, day)) continue
    const t = zonedInstant(day + open * MINUTE_MS, timeZone)
    if (t.getTime() >= at.getTime()) return t
  }
  throw new Error(`No time found for the watch timing ${JSON.stringify(w)} after ${at.toISOString()}`)
}

/** When a watch runs next: its interval after the run that just started, or when its hours next open if that falls outside them. */
export function nextWatchRun(w: WatchTiming, startedAt: Date, timeZone: string): Date {
  return watchRunAt(w, new Date(startedAt.getTime() + w.everyMinutes * MINUTE_MS), timeZone)
}

/** The first instant of the factory day an instant falls on: where a day's limit starts counting. */
export function factoryDayStart(at: Date, timeZone: string): Date {
  return zonedInstant(localDay(at, timeZone), timeZone)
}
